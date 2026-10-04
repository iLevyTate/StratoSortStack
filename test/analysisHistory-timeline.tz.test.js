/**
 * @jest-environment node
 *
 * F-162 regression: month-boundary ordering for users west of UTC. V8 locks
 * the timezone before any in-process assignment can change it (Jest setup
 * files touch Date first), so the scenario runs in a CHILD node process
 * spawned with TZ=America/New_York.
 */
const { execFileSync } = require('child_process');
const path = require('path');

describe('buildTimelineItems day-key ordering (F-162, TZ=America/New_York)', () => {
  test('a local-evening timestamp sorts under the calendar day it displays as', () => {
    // '2024-04-01T02:00:00Z' is Mar 31, 22:00 in New York — it DISPLAYS as
    // March. Pre-fix the raw-epoch sort put it ABOVE the date-only Apr 1
    // content date, rendering a March month header above an April one.
    const queriesPath = path.resolve(__dirname, '../src/main/services/analysisHistory/queries.js');
    const script = `
      const { buildTimelineItems } = require(process.env.QUERIES_PATH);
      const mk = (id, timestamp, documentDate) => ({
        id,
        timestamp,
        originalPath: '/files/' + id + '.pdf',
        fileName: id + '.pdf',
        analysis: { category: 'Docs', documentDate, mediaKind: null, subject: 's-' + id }
      });
      const history = {
        entries: {
          marchEvening: mk('marchEvening', '2024-04-01T02:00:00.000Z', null),
          aprilDoc: mk('aprilDoc', '2026-01-01T00:00:00.000Z', '2024-04-01'),
          marchDoc: mk('marchDoc', '2026-01-01T00:00:00.000Z', '2024-03-15')
        }
      };
      const { items } = buildTimelineItems(history, { limit: 10, offset: 0 });
      console.log(items.map((i) => i.id).join(','));
    `;

    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: 'America/New_York', QUERIES_PATH: queriesPath },
      encoding: 'utf8'
    }).trim();

    expect(out).toBe('aprilDoc,marchEvening,marchDoc');
  });

  test('east-of-UTC ordering is calendar-consistent too (TZ=Asia/Tokyo)', () => {
    // '2024-03-31T20:00:00Z' is Apr 1, 05:00 in Tokyo — it displays as April
    // and must sort ABOVE a date-only March 31 despite the earlier UTC
    // instant.
    const queriesPath = path.resolve(__dirname, '../src/main/services/analysisHistory/queries.js');
    const script = `
      const { buildTimelineItems } = require(process.env.QUERIES_PATH);
      const mk = (id, timestamp, documentDate) => ({
        id,
        timestamp,
        originalPath: '/files/' + id + '.pdf',
        fileName: id + '.pdf',
        analysis: { category: 'Docs', documentDate, mediaKind: null, subject: 's-' + id }
      });
      const history = {
        entries: {
          aprilMorning: mk('aprilMorning', '2024-03-31T20:00:00.000Z', null),
          marchDoc: mk('marchDoc', '2026-01-01T00:00:00.000Z', '2024-03-31')
        }
      };
      const { items } = buildTimelineItems(history, { limit: 10, offset: 0 });
      console.log(items.map((i) => i.id).join(','));
    `;

    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: 'Asia/Tokyo', QUERIES_PATH: queriesPath },
      encoding: 'utf8'
    }).trim();

    expect(out).toBe('aprilMorning,marchDoc');
  });
});
