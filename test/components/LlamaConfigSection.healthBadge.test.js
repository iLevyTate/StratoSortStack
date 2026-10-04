/**
 * @jest-environment jsdom
 *
 * The AI Configuration health badge used to read "Ready (cuda)" while a
 * circuit breaker refused every request or the engine had dropped to CPU.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import LlamaConfigSection from '../../src/renderer/components/settings/LlamaConfigSection';

jest.mock('../../src/renderer/components/ui/StatusBadge', () => ({
  __esModule: true,
  default: ({ children, variant }) => (
    <span data-testid="health-badge" data-variant={variant}>
      {children}
    </span>
  )
}));
jest.mock('../../src/renderer/components/ui/Modal', () => ({
  __esModule: true,
  ConfirmModal: () => null
}));
jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ children, title, description, headerAction }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {headerAction}
      {children}
    </section>
  )
}));
jest.mock('../../src/renderer/components/settings/SettingsGroup', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));
jest.mock('../../src/renderer/components/ui/StateMessage', () => ({
  __esModule: true,
  default: ({ children }) => <div>{children}</div>
}));

function renderSection(llamaHealth) {
  return render(
    <LlamaConfigSection
      llamaHealth={llamaHealth}
      modelList={[]}
      showAllModels={false}
      setShowAllModels={jest.fn()}
      onRefreshModels={jest.fn()}
      onDownloadModel={jest.fn()}
      onDeleteModel={jest.fn()}
    />
  );
}

describe('LlamaConfigSection health badge', () => {
  test('shows Ready with the backend when nothing is degraded', () => {
    renderSection({ status: 'healthy', initialized: true, gpuBackend: 'cuda' });
    const badge = screen.getByTestId('health-badge');
    expect(badge).toHaveTextContent('Ready (cuda)');
    expect(badge).toHaveAttribute('data-variant', 'success');
  });

  test('shows a paused warning while a circuit breaker is open', () => {
    renderSection({
      status: 'unhealthy',
      initialized: true,
      gpuBackend: 'cuda',
      openCircuits: ['text']
    });
    const badge = screen.getByTestId('health-badge');
    expect(badge).toHaveTextContent(/Paused \(text model failing, retry in 5 min\)/);
    expect(badge).toHaveAttribute('data-variant', 'warning');
  });

  test('names the model types on the CPU while the GPU backend is still live', () => {
    // A per-type fallback is not an engine fallback: vulkan loaded fine and
    // only these models are on the CPU. The badge used to say "CPU fallback,
    // vulkan unavailable" — wrong about the backend and about the scope.
    renderSection({
      status: 'healthy',
      initialized: true,
      gpuBackend: 'vulkan',
      usingCPUFallback: true,
      cpuFallbackTypes: ['text', 'embedding']
    });
    const badge = screen.getByTestId('health-badge');
    expect(badge).toHaveTextContent('Ready (vulkan active, text, embedding models on CPU)');
    expect(badge).not.toHaveTextContent(/unavailable/);
    expect(badge).toHaveAttribute('data-variant', 'warning');
  });

  test('singular copy for a single model type on the CPU', () => {
    renderSection({
      status: 'healthy',
      initialized: true,
      gpuBackend: 'cuda',
      usingCPUFallback: true,
      cpuFallbackTypes: ['vision']
    });
    expect(screen.getByTestId('health-badge')).toHaveTextContent(
      'Ready (cuda active, vision model on CPU)'
    );
  });

  test('a whole-engine fallback says CPU only, not "cpu unavailable"', () => {
    // The engine fallback path leaves gpuBackend === 'cpu', so the old string
    // interpolated the backend into itself: "CPU fallback, cpu unavailable".
    renderSection({
      status: 'healthy',
      initialized: true,
      gpuBackend: 'cpu',
      usingCPUFallback: true,
      cpuFallbackTypes: []
    });
    const badge = screen.getByTestId('health-badge');
    expect(badge).toHaveTextContent('Ready (CPU only — GPU backend unavailable)');
    expect(badge).not.toHaveTextContent(/cpu unavailable/);
    expect(badge).toHaveAttribute('data-variant', 'warning');
  });

  test('a fallback with no named types stays vague instead of guessing', () => {
    renderSection({
      status: 'healthy',
      initialized: true,
      gpuBackend: 'vulkan',
      usingCPUFallback: true
    });
    expect(screen.getByTestId('health-badge')).toHaveTextContent(
      'Ready (vulkan active, some models on CPU)'
    );
  });
});
