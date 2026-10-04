/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import KnowledgeStatsCard from '../../../src/renderer/components/dashboard/KnowledgeStatsCard';

// formatBytes(5.5 * 1024 * 1024 * 1024) → "5.50 GB"
// (value=5.5, precision=2 because value<10, output `${5.5.toFixed(2)} GB`)

describe('KnowledgeStatsCard', () => {
  beforeEach(() => {
    window.electronAPI = {
      analysisHistory: {
        getStatistics: jest.fn(async () => ({
          totalFiles: 1234,
          totalSize: 5.5 * 1024 * 1024 * 1024,
          categoriesCount: 12,
          oldestContentDate: '2016-03-02',
          newestContentDate: '2026-06-30',
          isEmpty: false
        }))
      }
    };
  });

  test('renders years covered, items, storage, and categories from statistics', async () => {
    render(<KnowledgeStatsCard />);
    await waitFor(() => expect(screen.getByText(/2016\s*–\s*2026/)).toBeTruthy());
    expect(screen.getByText(/10 years/i)).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    // formatBytes uses value.toFixed(2) for values < 10 → "5.50 GB"
    expect(screen.getByText(/5\.50 GB/i)).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  test('renders an invitation state when history is empty', async () => {
    window.electronAPI.analysisHistory.getStatistics.mockResolvedValueOnce({
      totalFiles: 0,
      totalSize: 0,
      categoriesCount: 0,
      oldestContentDate: null,
      newestContentDate: null,
      isEmpty: true
    });
    render(<KnowledgeStatsCard />);
    await waitFor(() =>
      expect(screen.getByText(/analyze files to build your knowledge layer/i)).toBeTruthy()
    );
  });

  test('shows the UNAVAILABLE state when IPC degrades to a bare success envelope [F-164]', async () => {
    // wrapResponse fallback path: `{ success: true }` with no stats fields at
    // all. This used to render the "Analyze files…" invitation — a lie to a
    // user whose thousands of analyzed files just failed to load. Genuinely
    // empty stats always carry explicit isEmpty/totalFiles fields, so the
    // fieldless envelope is distinguishable and renders as unavailable.
    window.electronAPI.analysisHistory.getStatistics.mockResolvedValueOnce({ success: true });
    render(<KnowledgeStatsCard />);
    await waitFor(() => expect(screen.getByText(/knowledge stats unavailable/i)).toBeTruthy());
    expect(screen.queryByText(/analyze files to build your knowledge layer/i)).toBeNull();
    expect(screen.queryByText(/items preserved/i)).toBeNull();
  });

  test('shows the unavailable state instead of loading forever when the API returns nothing', async () => {
    window.electronAPI.analysisHistory.getStatistics.mockResolvedValueOnce(undefined);
    render(<KnowledgeStatsCard />);
    await waitFor(() => expect(screen.getByText(/knowledge stats unavailable/i)).toBeTruthy());
  });

  test('falls back to analyzed-at span when no content dates exist', async () => {
    window.electronAPI.analysisHistory.getStatistics.mockResolvedValueOnce({
      totalFiles: 10,
      totalSize: 1024,
      categoriesCount: 2,
      oldestContentDate: null,
      newestContentDate: null,
      // Midday UTC so the rendered year is the same in every local timezone.
      oldestAnalysis: '2025-01-01T12:00:00.000Z',
      newestAnalysis: '2026-07-01T12:00:00.000Z',
      isEmpty: false
    });
    render(<KnowledgeStatsCard />);
    await waitFor(() => expect(screen.getByText(/2025\s*–\s*2026/)).toBeTruthy());
  });
});
