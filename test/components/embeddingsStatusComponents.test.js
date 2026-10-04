/**
 * @jest-environment jsdom
 *
 * Real-component coverage for the embeddings/search status surface.
 *
 * This replaces the M-5 "EmbeddingsStatus" block of the former
 * test/recentFixes.ui.test.js, which defined an INLINE copy of the status
 * logic and asserted on strings that had already drifted away from the
 * shipped UI (e.g. "check AI engine connection" vs the real "...status").
 * These tests import the genuine shipped components so they fail if the real
 * render logic regresses.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import StatsDisplay from '../../src/renderer/components/search/StatsDisplay';
import EmptyEmbeddingsBanner from '../../src/renderer/components/search/EmptyEmbeddingsBanner';
import IndexHealthBanner from '../../src/renderer/components/search/IndexHealthBanner';

describe('StatsDisplay (real component)', () => {
  test('renders "Search Offline" when stats are unavailable', () => {
    render(
      <StatsDisplay stats={null} isLoadingStats={false} statsUnavailable onRefresh={jest.fn()} />
    );
    expect(screen.getByText('Search offline')).toBeInTheDocument();
  });

  test('renders a cold-load indicator while loading with no stats yet', () => {
    render(<StatsDisplay stats={null} isLoadingStats onRefresh={jest.fn()} />);
    expect(screen.getByText(/Loading index/i)).toBeInTheDocument();
  });

  test('default empty state shows "No embeddings"; simpleMode shows "No search index yet"', () => {
    const { unmount } = render(
      <StatsDisplay stats={null} isLoadingStats={false} onRefresh={jest.fn()} />
    );
    expect(screen.getByText('No embeddings')).toBeInTheDocument();
    unmount();

    render(<StatsDisplay stats={null} isLoadingStats={false} simpleMode onRefresh={jest.fn()} />);
    expect(screen.getByText('No search index yet')).toBeInTheDocument();
  });

  test('renders folder + file counts and a health hint when index needs rebuild', () => {
    // D6: files > 0 with needsFileEmbeddingRebuild means partial coverage, not
    // an empty index, so the hint reads "incomplete index" here. A truly
    // empty index (files: 0) is covered separately below.
    render(
      <StatsDisplay
        stats={{ files: 100, folders: 10, needsFileEmbeddingRebuild: true }}
        isLoadingStats={false}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('folder embeddings')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('files indexed')).toBeInTheDocument();
    expect(screen.getByText('incomplete index')).toBeInTheDocument();
  });

  test('shows "empty index" as the health hint when files is exactly 0', () => {
    render(
      <StatsDisplay
        stats={{ files: 0, folders: 0, needsFileEmbeddingRebuild: true }}
        isLoadingStats={false}
        onRefresh={jest.fn()}
      />
    );
    expect(screen.getByText('empty index')).toBeInTheDocument();
  });

  test('flags stale stats via aria-busy when refreshing over populated stats', () => {
    const { container } = render(
      <StatsDisplay stats={{ files: 5, folders: 1 }} isLoadingStats onRefresh={jest.fn()} />
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  test('refresh button invokes onRefresh and is disabled while loading', () => {
    const onRefresh = jest.fn();
    const { rerender } = render(
      <StatsDisplay stats={null} isLoadingStats={false} onRefresh={onRefresh} />
    );
    const button = screen.getByRole('button', { name: /refresh embeddings status/i });
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<StatsDisplay stats={null} isLoadingStats onRefresh={onRefresh} />);
    expect(screen.getByRole('button', { name: /refresh embeddings status/i })).toBeDisabled();
  });
});

describe('EmptyEmbeddingsBanner (real component)', () => {
  const baseProps = {
    onRebuildFolders: jest.fn(),
    onRebuildFiles: jest.fn(),
    isRebuildingFolders: false,
    isRebuildingFiles: false
  };

  test('default state shows the "No embeddings yet" title and both build buttons', () => {
    render(<EmptyEmbeddingsBanner {...baseProps} />);
    expect(screen.getByText('No embeddings yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build folder embeddings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build file embeddings' })).toBeInTheDocument();
  });

  test('model mismatch and needs-rebuild index health pick distinct titles', () => {
    const { unmount } = render(
      <EmptyEmbeddingsBanner {...baseProps} indexHealth={{ embeddingModelMismatch: true }} />
    );
    expect(screen.getByText('Embedding model mismatch')).toBeInTheDocument();
    unmount();

    render(
      <EmptyEmbeddingsBanner {...baseProps} indexHealth={{ needsFileEmbeddingRebuild: true }} />
    );
    expect(screen.getByText('Search index needs rebuild')).toBeInTheDocument();
  });

  test('manual timing exposes the Open Settings affordance when handler provided', () => {
    render(
      <EmptyEmbeddingsBanner
        {...baseProps}
        embeddingConfig={{ timing: 'manual' }}
        onOpenSettings={jest.fn()}
      />
    );
    expect(screen.getByText('Embeddings are set to manual')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument();
  });

  test('clicking Build File Embeddings invokes onRebuildFiles', () => {
    const onRebuildFiles = jest.fn();
    render(<EmptyEmbeddingsBanner {...baseProps} onRebuildFiles={onRebuildFiles} />);
    fireEvent.click(screen.getByRole('button', { name: 'Build file embeddings' }));
    expect(onRebuildFiles).toHaveBeenCalledTimes(1);
  });

  test('in-flight rebuild disables the button and shows Building...', () => {
    render(<EmptyEmbeddingsBanner {...baseProps} isRebuildingFiles />);
    const button = screen.getByRole('button', { name: 'Building...' });
    expect(button).toBeDisabled();
  });
});

// F-197 (K-02): the health banner must speak up when a meaningful share of
// analyzed files has no search vector, not only when the index is empty.
describe('IndexHealthBanner coverage warning (real component) [F-197]', () => {
  const renderBanner = (stats) =>
    render(
      <IndexHealthBanner stats={stats} onRebuildFiles={jest.fn()} isRebuildingFiles={false} />
    );

  test('is hidden when coverage is fine', () => {
    renderBanner({ embeddingCoverageLow: false, uncoveredFiles: 0, analysisHistoryTotal: 40 });
    expect(screen.queryByText(/missing from search/i)).not.toBeInTheDocument();
  });

  test('names the uncovered count when coverage is low', () => {
    renderBanner({
      embeddingCoverageLow: true,
      uncoveredFiles: 270,
      analysisHistoryTotal: 281,
      embeddingCoverage: 0.039
    });
    const banner = screen.getByText(/missing from search/i).closest('div');
    expect(banner).toHaveTextContent(/270 of 281/);
    expect(banner).toHaveTextContent(/4%/);
    expect(screen.getByRole('button', { name: /rebuild/i })).toBeInTheDocument();
  });

  test('an empty index still shows the original empty-index copy', () => {
    renderBanner({
      needsFileEmbeddingRebuild: true,
      embeddingCoverageLow: true,
      uncoveredFiles: 9
    });
    expect(screen.getByText(/Search index is empty/i)).toBeInTheDocument();
  });
});
