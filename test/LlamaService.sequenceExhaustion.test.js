/**
 * Real-coverage test for LlamaService.generateText() session disposal on
 * sequence exhaustion.
 *
 * Supersedes the inline "Section 3" theater that previously lived in
 * test/bugfix-round3.test.js, which reimplemented the dispose-on-exhaustion
 * try/catch locally and asserted against its own copy (importing nothing from
 * src/). This drives the REAL generateText() path: it mocks node-llama-cpp so
 * the first LlamaChatSession.prompt() throws "no sequences left" and the retry
 * succeeds, then asserts the real code disposes the exhausted session BEFORE
 * recovery and tolerates a throwing dispose.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => ({
    checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
  }))
}));

const mockModelMemoryManager = {
  ensureModelLoaded: jest.fn(),
  unloadAll: jest.fn().mockResolvedValue(undefined),
  unloadModel: jest.fn().mockResolvedValue(undefined),
  acquireRef: jest.fn(),
  releaseRef: jest.fn(),
  getMemoryStatus: jest.fn().mockReturnValue({ totalLoaded: 1 })
};

jest.mock('../src/main/services/ModelMemoryManager', () => ({
  ModelMemoryManager: jest.fn().mockImplementation(() => mockModelMemoryManager)
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  ModelAccessCoordinator: jest.fn().mockImplementation(() => ({
    acquireLoadLock: jest.fn(async () => () => {}),
    withModel: jest.fn((_modelType, fn) => fn())
  }))
}));

jest.mock('../src/main/services/PerformanceMetrics', () => ({
  PerformanceMetrics: jest.fn().mockImplementation(() => ({
    recordEmbedding: jest.fn(),
    recordTextGeneration: jest.fn(),
    recordModelLoad: jest.fn(),
    getMetrics: jest.fn().mockReturnValue({}),
    destroy: jest.fn()
  }))
}));

jest.mock('../src/main/services/GPUMonitor', () => ({
  GPUMonitor: jest.fn().mockImplementation(() => ({})),
  getInstance: jest.fn(() => ({}))
}));

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => ({
    load: jest.fn().mockResolvedValue({}),
    save: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => ({
    analyzeImage: jest.fn(),
    shutdown: jest.fn(),
    isIdleKeepAliveEnabled: jest.fn(() => true)
  }))
}));

// Only `withLlamaResilience` is exercised on this path; have it invoke the
// resilience function directly (retryOptions = {}, so no forceCPU reload).
// `isSequenceExhaustedError` / `isOutOfMemoryError` are LOCAL helpers in
// LlamaService.js, not imported from here, so the real ones run.
jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: jest.fn((fn) => fn({})),
  cleanupLlamaCircuits: jest.fn(),
  shouldFallbackToCPU: jest.fn().mockReturnValue(false)
}));

// Controllable node-llama-cpp mock. `mockLlama` is mock-prefixed so the
// hoisted jest.mock factory may reference it; the factory only runs lazily
// (on the dynamic import inside loadNodeLlamaModule), by which point it is
// initialized. Each constructed LlamaChatSession is recorded so the test can
// drive per-session prompt/dispose behavior by construction order.
const mockLlama = {
  sessions: [],
  promptBehaviors: [],
  disposeBehaviors: [],
  callLog: [],
  reset() {
    this.sessions = [];
    this.promptBehaviors = [];
    this.disposeBehaviors = [];
    this.callLog = [];
  }
};

jest.mock('node-llama-cpp', () => ({
  getLlama: jest.fn(),
  LlamaChatSession: jest.fn().mockImplementation(() => {
    const index = mockLlama.sessions.length;
    const id = `session-${index + 1}`;
    const session = {
      id,
      dispose: jest.fn(() => {
        mockLlama.callLog.push(`dispose:${id}`);
        const behavior = mockLlama.disposeBehaviors[index];
        if (behavior instanceof Error) throw behavior;
      }),
      prompt: jest.fn(async () => {
        const behavior = mockLlama.promptBehaviors[index];
        if (typeof behavior === 'function') return behavior();
        if (behavior instanceof Error) throw behavior;
        return behavior ?? 'mock-response';
      })
    };
    mockLlama.sessions.push(session);
    return session;
  })
}));

const { LlamaService } = require('../src/main/services/LlamaService');

function createTestService() {
  const service = new LlamaService();
  service._initialized = true;
  service._modelsPath = '/mock/models';
  service._selectedModels = { text: 'text.gguf', vision: 'vision.gguf', embedding: 'embed.gguf' };
  service._config = { gpuLayers: -1, threads: 4 };
  service._gpuBackend = 'vulkan';
  service._awaitModelReady = jest.fn().mockResolvedValue(undefined);
  // Context with no numeric sequencesLeft -> skips the in-method reclaim wait.
  service._ensureModelLoaded = jest.fn().mockResolvedValue({
    getSequence: jest.fn().mockReturnValue({}),
    model: { gpuLayers: 33, trainContextSize: 4096 }
  });
  service._modelMemoryManager = mockModelMemoryManager;
  service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
  service._reloadModelCPU = jest.fn().mockResolvedValue(undefined);
  service._recoverFromSequenceExhaustion = jest.fn(async () => {
    mockLlama.callLog.push('recover');
  });
  service._getEffectiveContextSize = jest.fn().mockReturnValue(4096);
  return service;
}

describe('LlamaService.generateText – session disposal on sequence exhaustion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlama.reset();
  });

  test('disposes the exhausted session BEFORE recovery, then retries successfully', async () => {
    const service = createTestService();
    // First session: prompt throws sequence-exhaustion. Second: succeeds.
    mockLlama.promptBehaviors = [new Error('no sequences left'), 'recovered-response'];

    const result = await service.generateText({ prompt: 'hello', maxTokens: 128 });

    expect(result).toEqual({ response: 'recovered-response' });
    // Two sessions were constructed (one per runOnce attempt).
    expect(mockLlama.sessions).toHaveLength(2);
    // The exhausted session was disposed exactly once (in the catch) and
    // recovery ran AFTER that disposal — the real fix's ordering guarantee.
    expect(service._recoverFromSequenceExhaustion).toHaveBeenCalledTimes(1);
    expect(service._recoverFromSequenceExhaustion).toHaveBeenCalledWith('text', expect.any(Error));
    expect(mockLlama.callLog).toEqual(['dispose:session-1', 'recover', 'dispose:session-2']);
    // The retry session (session-2) served the successful prompt.
    expect(mockLlama.sessions[1].prompt).toHaveBeenCalledTimes(1);
  });

  test('a throwing dispose on exhaustion does not abort recovery or the retry', async () => {
    const service = createTestService();
    mockLlama.promptBehaviors = [new Error('no sequences left'), 'recovered-response'];
    // session-1.dispose() throws (model being unloaded) — must be swallowed.
    mockLlama.disposeBehaviors = [new Error('already disposed')];

    const result = await service.generateText({ prompt: 'hello', maxTokens: 128 });

    expect(result).toEqual({ response: 'recovered-response' });
    expect(mockLlama.sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(service._recoverFromSequenceExhaustion).toHaveBeenCalledTimes(1);
    // Recovery + retry still happened despite the dispose throwing.
    expect(mockLlama.callLog).toContain('recover');
    expect(mockLlama.sessions).toHaveLength(2);
  });

  test('a non-exhaustion inference error is rethrown without a recovery retry', async () => {
    const service = createTestService();
    mockLlama.promptBehaviors = [new Error('some other inference failure')];

    await expect(service.generateText({ prompt: 'hello', maxTokens: 128 })).rejects.toThrow(
      'some other inference failure'
    );

    // No recovery, no retry, only the single failing session constructed.
    expect(service._recoverFromSequenceExhaustion).not.toHaveBeenCalled();
    expect(mockLlama.sessions).toHaveLength(1);
  });
});
