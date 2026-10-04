// @ts-check
/**
 * AI Model Configuration — Single Source of Truth
 *
 * Change default models here. All other modules import from this file.
 * Env overrides: STRATOSORT_TEXT_MODEL, STRATOSORT_VISION_MODEL, STRATOSORT_EMBEDDING_MODEL
 *
 * Default profile targets broad compatibility across hardware.
 * Requires entries in modelRegistry.js MODEL_CATALOG for download URLs.
 */

const env = typeof process !== 'undefined' && process.env ? process.env : {};

/** Installer profiles for first-run model selection */
const INSTALL_MODEL_PROFILES = {
  BASE_SMALL: {
    id: 'base-small',
    label: 'Base (Small & Fast)',
    description:
      'Smallest text and embedding models for CPU-only systems. Vision (image) analysis uses LLaVA v1.6 Mistral 7B and benefits from a GPU.',
    models: {
      TEXT_ANALYSIS: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
      IMAGE_ANALYSIS: 'llava-v1.6-mistral-7b-Q4_K_M.gguf',
      EMBEDDING: 'all-MiniLM-L6-v2-Q4_K_M.gguf'
    }
  },
  BETTER_QUALITY: {
    id: 'better-quality',
    label: 'Better Quality (Larger)',
    description: 'Higher quality results on modern hardware, with larger downloads.',
    models: {
      TEXT_ANALYSIS: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      IMAGE_ANALYSIS: 'llava-v1.6-mistral-7b-Q4_K_M.gguf',
      EMBEDDING: 'nomic-embed-text-v1.5-Q8_0.gguf'
    }
  }
};

/** Default model filenames (must match MODEL_CATALOG keys in modelRegistry.js) */
const DEFAULT_AI_MODELS = {
  TEXT_ANALYSIS:
    env.STRATOSORT_TEXT_MODEL || INSTALL_MODEL_PROFILES.BASE_SMALL.models.TEXT_ANALYSIS,
  IMAGE_ANALYSIS:
    env.STRATOSORT_VISION_MODEL || INSTALL_MODEL_PROFILES.BASE_SMALL.models.IMAGE_ANALYSIS,
  EMBEDDING: env.STRATOSORT_EMBEDDING_MODEL || INSTALL_MODEL_PROFILES.BASE_SMALL.models.EMBEDDING,
  FALLBACK_MODELS: ['Llama-3.2-3B-Instruct-Q4_K_M.gguf', 'Phi-3-mini-4k-instruct-q4.gguf']
};

/** AI processing defaults (temperature, context, etc.) */
const AI_DEFAULTS = {
  TEXT: {
    MODEL: DEFAULT_AI_MODELS.TEXT_ANALYSIS,
    GPU_LAYERS: -1,
    TEMPERATURE: 0.7,
    MAX_TOKENS: 8192,
    CONTEXT_SIZE: 8192,
    MAX_CONTENT_LENGTH: 32000,
    DEEP_ANALYSIS: false,
    FALLBACK_MODELS: [
      'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
      'Phi-3-mini-4k-instruct-q4.gguf'
    ]
  },
  IMAGE: {
    MODEL: DEFAULT_AI_MODELS.IMAGE_ANALYSIS,
    GPU_LAYERS: -1,
    TEMPERATURE: 0.2,
    MAX_TOKENS: 512,
    FALLBACK_MODELS: ['llava-v1.6-mistral-7b-Q4_K_M.gguf']
  },
  EMBEDDING: {
    MODEL: DEFAULT_AI_MODELS.EMBEDDING,
    // Fallback dimension used ONLY when a model name cannot be resolved to a
    // known catalog entry. It must match the *default* EMBEDDING model above
    // (BASE_SMALL = all-MiniLM-L6-v2 → 384). Real routing resolves per-model via
    // resolveEmbeddingDimension(), so a user on nomic-embed-text-v1.5 correctly
    // gets 768. Keep this in lockstep with DEFAULT_AI_MODELS.EMBEDDING.
    DIMENSIONS: 384,
    GPU_LAYERS: -1,
    FALLBACK_MODELS: [
      'nomic-embed-text-v1.5-Q8_0.gguf',
      'nomic-embed-text-v1.5-Q4_K_M.gguf',
      'all-MiniLM-L6-v2-Q8_0.gguf',
      'all-MiniLM-L6-v2-Q4_K_M.gguf'
    ],
    // Must agree with DEFAULT_SETTINGS.autoChunkOnAnalysis (F-209): this is
    // the settings-less fallback, not a second opinion.
    AUTO_CHUNK_ON_ANALYSIS: true
  }
};

/**
 * Hardware floor for the Better Quality profile: a 7B Q4 text model next to
 * the LLaVA server wants about 16 GB of RAM, and runs acceptably only with a
 * GPU holding 8 GB or more (Apple Silicon reports unified memory as VRAM).
 *
 * The floors are compared in whole gigabytes, the way the reason text
 * prints them. os.totalmem() leaves out firmware-reserved memory, so a 16 GB
 * PC reports 15.7 GB, and nvidia-smi shows 8188 MiB for several 8 GB cards;
 * compared raw, nearly every 16 GB machine was told it had "16 GB of RAM"
 * and then that 16 GB was not enough.
 */
const QUALITY_PROFILE_MIN_RAM_MB = 16 * 1024;
const QUALITY_PROFILE_MIN_VRAM_MB = 8 * 1024;
const QUALITY_PROFILE_MIN_RAM_GB = QUALITY_PROFILE_MIN_RAM_MB / 1024;
const QUALITY_PROFILE_MIN_VRAM_GB = QUALITY_PROFILE_MIN_VRAM_MB / 1024;

/** @param {any} value */
function readMegabytes(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pick the install profile this computer can carry. The wizard shows the
 * result next to the profile cards and preselects it on a fresh install;
 * the user can still pick the other one (audit row ML-07: the wizard read
 * no RAM or VRAM at all and the registry's minRam/requiresGpu had no
 * consumer).
 *
 * @param {{ totalMemMB?: number|null, vramMB?: number|null, hasGpu?: boolean|null, gpuName?: string|null }} facts
 * @returns {{ profile: 'base'|'quality', reason: string, facts: { totalMemMB: number|null, vramMB: number|null, hasGpu: boolean } }}
 */
function recommendInstallProfile(facts = {}) {
  const totalMemMB = readMegabytes(facts?.totalMemMB);
  // null means the probe could not read GPU memory (AMD and Intel adapters,
  // Linux without nvidia-smi); 0 is a real reading. The two used to collapse
  // into "GPU with 0 GB".
  const vramMB = readMegabytes(facts?.vramMB);
  const hasGpu = facts?.hasGpu === true || (vramMB !== null && vramMB > 0);
  const normalized = { totalMemMB, vramMB, hasGpu };
  const ramGB = totalMemMB === null ? null : Math.round(totalMemMB / 1024);
  const vramGB = vramMB === null ? null : Math.round(vramMB / 1024);

  if (totalMemMB === null) {
    return {
      profile: 'base',
      reason: 'Memory could not be read, so the smaller profile is the safe choice.',
      facts: normalized
    };
  }
  if (/** @type {number} */ (ramGB) < QUALITY_PROFILE_MIN_RAM_GB) {
    return {
      profile: 'base',
      reason: `${ramGB} GB of RAM: the larger profile needs 16 GB or more.`,
      facts: normalized
    };
  }
  if (!hasGpu) {
    return {
      profile: 'base',
      reason: `${ramGB} GB of RAM but no GPU detected: the 7B text model would run on the CPU and be slow.`,
      facts: normalized
    };
  }
  if (vramGB === null) {
    // A GPU is present but its memory is unknown; it may be a 2 GB
    // integrated adapter. The user can still pick the larger profile.
    return {
      profile: 'base',
      reason: `${ramGB} GB of RAM and a GPU whose memory could not be read: the smaller profile is the safe choice.`,
      facts: normalized
    };
  }
  if (vramGB < QUALITY_PROFILE_MIN_VRAM_GB) {
    return {
      profile: 'base',
      reason: `${ramGB} GB of RAM, GPU with ${vramGB} GB: the larger profile wants 8 GB of GPU memory.`,
      facts: normalized
    };
  }
  const gpuLabel = facts?.gpuName
    ? `${facts.gpuName}${vramMB ? ` (${vramGB} GB)` : ''}`
    : vramMB
      ? `GPU with ${vramGB} GB`
      : 'a GPU';
  return {
    profile: 'quality',
    reason: `${ramGB} GB of RAM and ${gpuLabel}: this computer can carry the larger models.`,
    facts: normalized
  };
}

module.exports = {
  INSTALL_MODEL_PROFILES,
  DEFAULT_AI_MODELS,
  AI_DEFAULTS,
  QUALITY_PROFILE_MIN_RAM_MB,
  QUALITY_PROFILE_MIN_VRAM_MB,
  recommendInstallProfile
};
