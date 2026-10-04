const {
  formatTimestamp,
  toVtt,
  toSrt,
  toTranscriptJson
} = require('../src/main/services/transcriptFormats');

describe('transcriptFormats', () => {
  const segments = [
    { start: 0, end: 2.5, text: ' Hello world ' },
    { start: 2.5, end: 65.04, text: 'Second segment' },
    { start: 3661.999, end: 3675, text: 'After an hour' }
  ];

  describe('formatTimestamp', () => {
    test('formats zero', () => {
      expect(formatTimestamp(0, '.')).toBe('00:00:00.000');
    });
    test('formats sub-second rounding without ms overflow', () => {
      // 59.9996s must carry into the next minute, not render 00:00:59.1000
      expect(formatTimestamp(59.9996, '.')).toBe('00:01:00.000');
    });
    test('formats hours and comma separator (SRT)', () => {
      expect(formatTimestamp(3661.5, ',')).toBe('01:01:01,500');
    });
    test('clamps negative and non-finite input to zero', () => {
      expect(formatTimestamp(-5, '.')).toBe('00:00:00.000');
      expect(formatTimestamp(Number.NaN, '.')).toBe('00:00:00.000');
    });
  });

  describe('toVtt', () => {
    test('produces a valid WEBVTT document with numbered cues', () => {
      const vtt = toVtt(segments);
      expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
      expect(vtt).toContain('1\n00:00:00.000 --> 00:00:02.500\nHello world');
      expect(vtt).toContain('2\n00:00:02.500 --> 00:01:05.040\nSecond segment');
      expect(vtt).toContain('3\n01:01:01.999 --> 01:01:15.000\nAfter an hour');
      expect(vtt.endsWith('\n')).toBe(true);
    });
    test('handles empty segment list', () => {
      expect(toVtt([])).toBe('WEBVTT\n\n');
    });
    test('skips malformed segments and strips CR/newlines inside cue text', () => {
      const vtt = toVtt([
        { start: 0, end: 1, text: 'line1\r\nline2' },
        null,
        { start: 'x', end: 2, text: 'bad start' }
      ]);
      expect(vtt).toContain('line1 line2');
      expect(vtt).not.toContain('bad start');
    });
    test('skips segments whose end precedes start', () => {
      const vtt = toVtt([{ start: 10, end: 5, text: 'inverted' }]);
      expect(vtt).toBe('WEBVTT\n\n');
    });
    test('escapes VTT cue-text markup characters (raw < swallows the line as a tag)', () => {
      const vtt = toVtt([{ start: 0, end: 1, text: 'temps < 10 & humidity > 90' }]);
      expect(vtt).toContain('temps &lt; 10 &amp; humidity &gt; 90');
      expect(vtt).not.toContain('< 10');
    });
  });

  describe('toSrt', () => {
    test('produces numbered SRT blocks with comma milliseconds', () => {
      const srt = toSrt(segments);
      expect(srt.startsWith('1\n00:00:00,000 --> 00:00:02,500\nHello world\n\n')).toBe(true);
      expect(srt).toContain('3\n01:01:01,999 --> 01:01:15,000\nAfter an hour');
    });
    test('handles empty segment list', () => {
      expect(toSrt([])).toBe('');
    });
  });

  describe('toTranscriptJson', () => {
    test('serializes metadata, text, and segments as pretty JSON', () => {
      const json = toTranscriptJson({
        sourceFile: 'C:/media/talk.mp4',
        language: 'en',
        durationSeconds: 3675,
        text: 'Hello world Second segment After an hour',
        segments
      });
      const parsed = JSON.parse(json);
      expect(parsed.sourceFile).toBe('C:/media/talk.mp4');
      expect(parsed.language).toBe('en');
      expect(parsed.durationSeconds).toBe(3675);
      expect(parsed.segments).toHaveLength(3);
      expect(parsed.segments[0]).toEqual({ start: 0, end: 2.5, text: 'Hello world' });
    });
    test('defaults missing metadata to null and coerces segments defensively', () => {
      const parsed = JSON.parse(
        toTranscriptJson({ text: 'x', segments: [null, { start: 1, end: 2, text: 'ok' }] })
      );
      expect(parsed.language).toBeNull();
      expect(parsed.durationSeconds).toBeNull();
      expect(parsed.sourceFile).toBeNull();
      expect(parsed.segments).toEqual([{ start: 1, end: 2, text: 'ok' }]);
    });
  });
});
