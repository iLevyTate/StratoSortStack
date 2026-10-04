/**
 * @jest-environment node
 *
 * Regression guards for audio/video naming convention application.
 */

const {
  normalizeNamingConventionState,
  generateSuggestedNameFromAnalysis,
  resolveDiscoverSuggestedName
} = require('../src/shared/namingConventions');

const namingSettings = {
  convention: 'subject-date',
  separator: '-',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case'
};

describe('media naming convention regressions', () => {
  test('normalizeNamingConventionState accepts legacy string shape', () => {
    expect(normalizeNamingConventionState('subject-date')).toMatchObject({
      convention: 'subject-date',
      caseConvention: 'kebab-case'
    });
  });

  test('subject-date applies to audio-shaped analysis', () => {
    const name = generateSuggestedNameFromAnalysis({
      originalFileName: 'My Podcast.mp3',
      analysis: { suggestedName: 'My Podcast', category: 'audio', type: 'audio' },
      settings: {
        convention: 'subject-date',
        separator: '-',
        dateFormat: 'YYYY-MM-DD',
        caseConvention: 'kebab-case'
      },
      fileTimestamps: { modified: new Date('2026-06-01T00:00:00Z') }
    });
    expect(name).toBe('my-podcast-2026-06-01.mp3');
  });

  test('resolveDiscoverSuggestedName preserves main-process dated name when modified is null', () => {
    const name = resolveDiscoverSuggestedName({
      originalFileName: 'Timeline 1.mp4',
      analysis: {
        llmSuggestedName: 'Timeline 1',
        suggestedName: 'timeline-1-2026-06-01.mp4',
        category: 'video'
      },
      settings: namingSettings,
      fileTimestamps: { modified: null, created: null },
      trustMainProcess: true
    });
    expect(name).toBe('timeline-1-2026-06-01.mp4');
  });

  test('resolveDiscoverSuggestedName re-applies from llmSuggestedName when main naming not trusted', () => {
    const name = resolveDiscoverSuggestedName({
      originalFileName: 'Timeline 1.ogg',
      analysis: {
        llmSuggestedName: 'Timeline 1',
        suggestedName: 'timeline-1-2026-06-01.ogg',
        category: 'audio'
      },
      settings: namingSettings,
      fileTimestamps: { modified: new Date('2026-06-01T00:00:00Z') }
    });
    expect(name).toBe('timeline-1-2026-06-01.ogg');
  });

  test('ready queue hydration preserves main-process dated media names without timestamps', () => {
    const { mergeReadyQueueIntoState } = require('../src/renderer/utils/readyQueueHydration');

    const merged = mergeReadyQueueIntoState(
      { selectedFiles: [], analysisResults: [], fileStates: {} },
      [
        {
          path: 'C:\\media\\Timeline 1.mp4',
          name: 'Timeline 1.mp4',
          analysis: {
            category: 'video',
            llmSuggestedName: 'Timeline 1',
            suggestedName: 'timeline-1-2026-06-01.mp4',
            mediaKind: 'video',
            namingConvention: namingSettings
          },
          analyzedAt: '2026-06-01T00:00:00.000Z'
        }
      ],
      namingSettings
    );

    expect(merged.hydratedCount).toBe(1);
    expect(merged.analysisResults[0].analysis.suggestedName).toBe('timeline-1-2026-06-01.mp4');
  });

  test('ready queue hydration applies Discover naming to media entries', () => {
    const { mergeReadyQueueIntoState } = require('../src/renderer/utils/readyQueueHydration');

    const merged = mergeReadyQueueIntoState(
      { selectedFiles: [], analysisResults: [], fileStates: {} },
      [
        {
          path: 'C:\\media\\clip.mp4',
          name: 'clip.mp4',
          modified: '2026-06-01T00:00:00.000Z',
          analysis: {
            category: 'video',
            suggestedName: 'clip',
            mediaKind: 'video'
          },
          analyzedAt: '2026-06-01T00:00:00.000Z'
        }
      ],
      {
        convention: 'subject-date',
        separator: '-',
        dateFormat: 'YYYY-MM-DD',
        caseConvention: 'kebab-case'
      }
    );

    expect(merged.hydratedCount).toBe(1);
    expect(merged.analysisResults[0].analysis.suggestedName).toBe('clip-2026-06-01.mp4');
  });
});
