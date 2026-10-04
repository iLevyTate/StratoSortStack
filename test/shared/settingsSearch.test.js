'use strict';

const {
  matchSettingsSections,
  sectionMatchesQuery,
  SETTINGS_SECTION_INDEX
} = require('../../src/shared/settingsSearch');

describe('settingsSearch', () => {
  test('empty query shows all sections', () => {
    expect(matchSettingsSections('')).toEqual({ sectionIds: null, revealAdvanced: false });
    expect(matchSettingsSections('   ')).toEqual({ sectionIds: null, revealAdvanced: false });
  });

  test('matches contiguous phrase in keywords', () => {
    const { sectionIds } = matchSettingsSections('knowledge graph');
    expect(sectionIds.has('settings-performance')).toBe(true);
  });

  test('matches multi-word queries via token AND (stop words ignored)', () => {
    const { sectionIds, revealAdvanced } = matchSettingsSections('chat with documents');
    expect(sectionIds.has('settings-ai')).toBe(true);
    expect(revealAdvanced).toBe(true);
  });

  test('finds chat persona from conversational synonyms', () => {
    const entry = SETTINGS_SECTION_INDEX.find((s) => s.title === 'Chat persona');
    expect(sectionMatchesQuery(entry, 'knowledge os')).toBe(true);
    expect(sectionMatchesQuery(entry, 'semantic search')).toBe(true);
  });

  test('finds AI provider from openai query', () => {
    const { sectionIds } = matchSettingsSections('openai api key');
    expect(sectionIds.has('settings-ai-provider')).toBe(true);
  });

  test('finds the video keyframe toggle under Processing limits', () => {
    const { sectionIds, revealAdvanced } = matchSettingsSections('video keyframes');
    expect(sectionIds.has('settings-performance')).toBe(true);
    expect(revealAdvanced).toBe(true);
    const entry = SETTINGS_SECTION_INDEX.find((s) => s.title === 'Processing limits');
    expect(sectionMatchesQuery(entry, 'caption')).toBe(true);
    expect(sectionMatchesQuery(entry, 'describe video')).toBe(true);
  });

  test('returns empty set for nonsense query', () => {
    const { sectionIds } = matchSettingsSections('xyzzy plugh');
    expect(sectionIds.size).toBe(0);
  });

  test('flags advanced-only matches for temporary reveal', () => {
    const { revealAdvanced } = matchSettingsSections('embedding rebuild');
    expect(revealAdvanced).toBe(true);
  });
});
