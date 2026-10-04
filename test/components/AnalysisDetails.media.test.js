/**
 * @jest-environment jsdom
 *
 * Renderer guarantees for the v3.1.1 audio/video analysis surface.
 * Each assertion maps to a P0/P1 issue from the audit plan that landed
 * with this commit:
 *
 *   - Keyframe captions are rendered (P0 #1)
 *   - Transcript container scrolls instead of clamping at 4 lines (P0 #2)
 *   - `multimodalText` is surfaced when present (P0 #3)
 *   - "no detectable speech" fallback shows for silent media (P0 #4)
 *   - Duration above 1 hour formats as hh:mm:ss (P1 #12)
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// AnalysisDetails imports a few UI primitives that pull in framer-motion / icons.
// Stub the ones that don't need real behavior so we test the analysis-rendering
// logic, not the styling layer.
jest.mock('../../src/renderer/components/ui/Card', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children, className }) => <div className={className}>{children}</div>
  };
});
jest.mock('../../src/renderer/components/ui/Collapsible', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ title, children }) => (
      <section>
        {title}
        {children}
      </section>
    )
  };
});
jest.mock('../../src/renderer/components/ui/StatusBadge', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: ({ children }) => <span>{children}</span>
  };
});
jest.mock('lucide-react', () => new Proxy({}, { get: () => () => null }));

import AnalysisDetails from '../../src/renderer/components/AnalysisDetails';

describe('AnalysisDetails — media surfacing', () => {
  test('renders keyframe captions, not just the count', () => {
    render(
      <AnalysisDetails
        analysis={{
          mediaKind: 'video',
          durationSeconds: 120,
          keyframes: [
            { timestamp: 5, caption: 'A speaker at a podium.' },
            { timestamp: 30, caption: 'Slide showing a chart.' }
          ]
        }}
      />
    );
    expect(screen.getByText('A speaker at a podium.')).toBeInTheDocument();
    expect(screen.getByText('Slide showing a chart.')).toBeInTheDocument();
    // Timestamps render as mm:ss codes alongside captions.
    expect(screen.getByText('00:05')).toBeInTheDocument();
    expect(screen.getByText('00:30')).toBeInTheDocument();
  });

  test('formats durations >= 1 hour as hh:mm:ss (no ambiguous "90:00")', () => {
    render(
      <AnalysisDetails
        analysis={{
          mediaKind: 'video',
          durationSeconds: 5400 // 90 minutes
        }}
      />
    );
    expect(screen.getByText('01:30:00')).toBeInTheDocument();
    // Must not render the ambiguous "90:00" form.
    expect(screen.queryByText('90:00')).not.toBeInTheDocument();
  });

  test('surfaces multimodalText separately from the raw transcript', () => {
    render(
      <AnalysisDetails
        analysis={{
          mediaKind: 'video',
          transcript: 'spoken words only',
          multimodalText:
            '[00:05] (speech) hello\n[00:05] (visual) podium scene\n[00:30] (visual) chart slide'
        }}
      />
    );
    expect(screen.getByText(/Multimodal Transcript/i)).toBeInTheDocument();
    expect(screen.getByText(/podium scene/)).toBeInTheDocument();
  });

  test('shows the no-speech fallback when transcript is empty', () => {
    render(
      <AnalysisDetails
        analysis={{
          mediaKind: 'video',
          durationSeconds: 60,
          transcript: '',
          keyframes: [{ timestamp: 0, caption: 'A car driving.' }]
        }}
      />
    );
    expect(screen.getByText(/No detectable speech/i)).toBeInTheDocument();
    expect(screen.getByText(/visual keyframes/i)).toBeInTheDocument();
  });

  test('does not claim visual keyframes when no frame was captioned (MI-04)', () => {
    render(
      <AnalysisDetails
        analysis={{
          mediaKind: 'video',
          durationSeconds: 60,
          transcript: '',
          keyframes: [{ timestamp: 0, caption: null }]
        }}
      />
    );
    expect(screen.getByText(/No detectable speech/i)).toBeInTheDocument();
    expect(screen.queryByText(/visual keyframes/i)).not.toBeInTheDocument();
  });

  test('transcript container is scrollable, not line-clamped', () => {
    render(
      <AnalysisDetails
        analysis={{
          mediaKind: 'audio',
          transcript: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
        }}
      />
    );
    const transcriptHeader = screen.getByText('Transcript');
    // Export buttons are now rendered as the first div sibling; select the
    // scrollable transcript container specifically via its overflow class.
    const container = transcriptHeader.parentElement?.querySelector(
      'div[class*="overflow-y-auto"]'
    );
    expect(container).not.toBeNull();
    expect(container.className).toMatch(/overflow-y-auto/);
    expect(container.className).not.toMatch(/line-clamp/);
  });
});
