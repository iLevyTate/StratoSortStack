/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import InsightDock from '../../../../src/renderer/components/search/InsightDock';

const baseSummary = {
  topicClusters: 3,
  bridgeDocuments: 2,
  nearDuplicates: 5,
  scatteredFiles: 1
};

const baseHealth = {
  grade: 'B',
  score: 72,
  findings: [
    { key: 'dup', label: 'Duplicates', active: true },
    { key: 'ok', label: 'All good', active: false }
  ]
};

describe('InsightDock', () => {
  test('region has five top-level buttons and no nested buttons', () => {
    const onStatClick = jest.fn();
    const onHealthClick = jest.fn();
    const { container } = render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        duplicateSummary={{ loading: false }}
        onStatClick={onStatClick}
        onHealthClick={onHealthClick}
      />
    );

    const region = screen.getByRole('region', { name: /graph insights/i });
    expect(region).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(5);
    expect(container.querySelectorAll('button button')).toHaveLength(0);
  });

  test('bridge tile invokes onStatClick with bridges', () => {
    const onStatClick = jest.fn();
    render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        onStatClick={onStatClick}
        onHealthClick={jest.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /bridge documents, click to explore/i }));
    expect(onStatClick).toHaveBeenCalledWith('bridges');
  });

  test('clusters tile invokes onStatClick with clusters', () => {
    const onStatClick = jest.fn();
    render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        onStatClick={onStatClick}
        onHealthClick={jest.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /topic clusters, click to explore/i }));
    expect(onStatClick).toHaveBeenCalledWith('clusters');
  });

  test('near-duplicates tile invokes onStatClick with duplicates', () => {
    const onStatClick = jest.fn();
    render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        duplicateSummary={{ loading: false }}
        onStatClick={onStatClick}
        onHealthClick={jest.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: /near-duplicate files, click to explore/i })
    );
    expect(onStatClick).toHaveBeenCalledWith('duplicates');
  });

  test('health tile invokes onHealthClick', () => {
    const onHealthClick = jest.fn();
    render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        onStatClick={jest.fn()}
        onHealthClick={onHealthClick}
      />
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Organizational health grade B, score 72/i })
    );
    expect(onHealthClick).toHaveBeenCalled();
  });

  test('scattered tile invokes onStatClick with scattered', () => {
    const onStatClick = jest.fn();
    render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        onStatClick={onStatClick}
        onHealthClick={jest.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /scattered files, click to explore/i }));
    expect(onStatClick).toHaveBeenCalledWith('scattered');
  });

  test('with onTriageClick, region has six top-level buttons and triage invokes callback', () => {
    const onTriageClick = jest.fn();
    const { container } = render(
      <InsightDock
        insightSummary={baseSummary}
        organizationalHealth={baseHealth}
        duplicateSummary={{ loading: false }}
        onStatClick={jest.fn()}
        onHealthClick={jest.fn()}
        onTriageClick={onTriageClick}
      />
    );
    expect(container.querySelectorAll('button')).toHaveLength(6);
    fireEvent.click(
      screen.getByRole('button', { name: /Triage Downloads folder, click to open/i })
    );
    expect(onTriageClick).toHaveBeenCalled();
  });

  test('aria-labels never contain the substring "undefined" when summary fields are missing', () => {
    const { container } = render(
      <InsightDock
        insightSummary={{
          topicClusters: undefined,
          bridgeDocuments: undefined,
          nearDuplicates: undefined,
          scatteredFiles: undefined
        }}
        organizationalHealth={{
          grade: undefined,
          score: undefined,
          findings: []
        }}
        duplicateSummary={{ loading: false }}
        onStatClick={jest.fn()}
        onHealthClick={jest.fn()}
      />
    );
    const labelled = container.querySelectorAll('[aria-label]');
    labelled.forEach((el) => {
      expect(el.getAttribute('aria-label')).not.toMatch(/undefined/i);
    });
  });
});
