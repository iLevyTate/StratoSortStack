/**
 * @jest-environment jsdom
 *
 * Focused tests for the per-row download progress rendering added so that
 * model downloads in Settings → Model Management show a live percentage
 * instead of a silent "Working…" spinner.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('lucide-react', () => {
  const Icon = (props) => <svg data-testid={props['aria-label'] || 'icon'} {...props} />;
  return {
    Languages: Icon,
    Eye: Icon,
    Layers: Icon,
    Sparkles: Icon,
    CheckCircle2: Icon,
    Download: Icon,
    HardDrive: Icon,
    Loader2: Icon
  };
});

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/ui/Input', () => ({
  __esModule: true,
  default: (props) => <input {...props} />
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children, ...rest }) => <span {...rest}>{children}</span>
}));

jest.mock('../../src/renderer/components/settings/SettingRow', () => ({
  __esModule: true,
  default: ({ children, label }) => (
    <div>
      <label>{label}</label>
      {children}
    </div>
  )
}));

jest.mock('../../src/renderer/components/settings/SettingsCard', () => ({
  __esModule: true,
  default: ({ children, title }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  )
}));

// Trim the catalog to a single deterministic entry so tests can lock onto a
// known filename. Without this, the real registry would surface every catalog
// model and dozens of <Download> buttons.
jest.mock('../../src/shared/modelRegistry', () => ({
  getAllModels: () => ({
    'mxbai-embed-large-Q4_K_M.gguf': {
      type: 'embedding',
      displayName: 'MxBai Embed Large',
      description: 'High-fidelity embeddings',
      size: 670000000,
      url: 'https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/mxbai-embed-large-Q4_K_M.gguf'
    }
  }),
  formatSize: (bytes) => `${Math.round(bytes / 1e6)}MB`
}));

const renderSection = (overrides = {}) => {
  const ModelManagementSection =
    require('../../src/renderer/components/settings/ModelManagementSection').default;
  return render(
    <ModelManagementSection
      newModel=""
      setNewModel={jest.fn()}
      isAddingModel={false}
      onAddModel={jest.fn()}
      installedModels={[]}
      {...overrides}
    />
  );
};

describe('ModelManagementSection — theme-aware icon wells (U-018)', () => {
  test('not-installed wells use the inverted-scale tint, never bg-white', () => {
    const { container } = renderSection();

    expect(container.querySelector('[class*="bg-system-gray-900/5"]')).not.toBeNull();
    expect(container.querySelector('[class*="bg-white"]')).toBeNull();
  });
});

describe('ModelManagementSection — download progress rendering', () => {
  test('renders Download button when no download is active', () => {
    renderSection();

    // The catalog row's primary action is the Download button when the row is
    // neither installed nor being downloaded.
    expect(screen.getByTitle(/Download MxBai Embed Large/)).toBeInTheDocument();
    // No progress role should be present yet
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('replaces Download button with live percent + progress bar when this row is downloading', () => {
    renderSection({
      isAddingModel: true,
      downloadProgress: {
        modelName: 'mxbai-embed-large-Q4_K_M.gguf',
        percent: 42
      }
    });

    // The progress region uses role="status" + aria-live so screen readers
    // announce updates. Catching it via role is also the most resilient query.
    const status = screen.getByRole('status', {
      name: /Downloading MxBai Embed Large: 42 percent/
    });
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent('42%');
    expect(status).toHaveTextContent('downloading');
    // The actual Download button is gone while the row is in progress
    expect(screen.queryByTitle(/Download MxBai Embed Large/)).not.toBeInTheDocument();
  });

  test('clamps percent to [0, 100] so flaky upstream values do not break the bar', () => {
    renderSection({
      isAddingModel: true,
      downloadProgress: {
        modelName: 'mxbai-embed-large-Q4_K_M.gguf',
        percent: 150 // upstream overshoot
      }
    });

    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  test('progress UI does not attach to non-matching rows', () => {
    renderSection({
      isAddingModel: true,
      downloadProgress: {
        modelName: 'some-other-model-Q4.gguf',
        percent: 50
      }
    });

    // The catalog row should still show the Download button because the
    // active download is for a different file.
    expect(screen.getByTitle(/Download MxBai Embed Large/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('does not show progress on an installed row even when downloadProgress matches', () => {
    renderSection({
      installedModels: ['mxbai-embed-large-Q4_K_M.gguf'],
      downloadProgress: {
        modelName: 'mxbai-embed-large-Q4_K_M.gguf',
        percent: 75
      }
    });

    // Installed badge wins — no progress UI for already-installed rows
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Installed')).toBeInTheDocument();
  });
});
