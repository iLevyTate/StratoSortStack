/**
 * Tests for textModelActivity – interactive text request ref-counting
 */

let beginInteractiveTextRequest;
let isInteractiveTextRequestActive;
let getInteractiveTextRequestCount;

beforeEach(() => {
  jest.resetModules();
  ({
    beginInteractiveTextRequest,
    isInteractiveTextRequestActive,
    getInteractiveTextRequestCount
  } = require('../src/main/services/textModelActivity'));
});

describe('textModelActivity', () => {
  describe('initial state', () => {
    it('reports inactive with count 0', () => {
      expect(isInteractiveTextRequestActive()).toBe(false);
      expect(getInteractiveTextRequestCount()).toBe(0);
    });
  });

  describe('single request lifecycle', () => {
    it('becomes active after begin', () => {
      const end = beginInteractiveTextRequest();
      expect(isInteractiveTextRequestActive()).toBe(true);
      expect(getInteractiveTextRequestCount()).toBe(1);
      end();
    });

    it('returns to inactive after end', () => {
      const end = beginInteractiveTextRequest();
      end();
      expect(isInteractiveTextRequestActive()).toBe(false);
      expect(getInteractiveTextRequestCount()).toBe(0);
    });
  });

  describe('concurrent requests', () => {
    it('tracks multiple active requests independently', () => {
      const end1 = beginInteractiveTextRequest();
      const end2 = beginInteractiveTextRequest();
      const end3 = beginInteractiveTextRequest();

      expect(getInteractiveTextRequestCount()).toBe(3);

      end1();
      expect(getInteractiveTextRequestCount()).toBe(2);
      expect(isInteractiveTextRequestActive()).toBe(true);

      end2();
      end3();
      expect(getInteractiveTextRequestCount()).toBe(0);
      expect(isInteractiveTextRequestActive()).toBe(false);
    });
  });

  describe('double-end guard', () => {
    it('calling end twice does not go below zero', () => {
      const end = beginInteractiveTextRequest();
      end();
      end();
      expect(getInteractiveTextRequestCount()).toBe(0);
    });

    it('double-ending one request does not affect another', () => {
      const end1 = beginInteractiveTextRequest();
      const end2 = beginInteractiveTextRequest();

      end1();
      end1();
      expect(getInteractiveTextRequestCount()).toBe(1);

      end2();
      expect(getInteractiveTextRequestCount()).toBe(0);
    });
  });

  describe('interleaved begin/end', () => {
    it('handles interleaved calls correctly', () => {
      const end1 = beginInteractiveTextRequest();
      const end2 = beginInteractiveTextRequest();
      end1();
      const end3 = beginInteractiveTextRequest();
      expect(getInteractiveTextRequestCount()).toBe(2);

      end2();
      end3();
      expect(getInteractiveTextRequestCount()).toBe(0);
    });
  });
});
