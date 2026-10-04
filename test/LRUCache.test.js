/**
 * Tests for unified LRUCache
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const { LRUCache } = require('../src/shared/LRUCache');

describe('LRUCache', () => {
  let cache;

  afterEach(async () => {
    if (cache) {
      await cache.shutdown();
    }
  });

  describe('constructor', () => {
    test('creates cache with default options', () => {
      cache = new LRUCache();

      expect(cache.maxSize).toBe(200);
      expect(cache.ttlMs).toBe(120000);
      expect(cache.lruStrategy).toBe('insertion');
      expect(cache.trackMetrics).toBe(false);
    });

    test('accepts custom options', () => {
      cache = new LRUCache({
        maxSize: 50,
        ttlMs: 5000,
        lruStrategy: 'access',
        trackMetrics: true,
        name: 'TestCache'
      });

      expect(cache.maxSize).toBe(50);
      expect(cache.ttlMs).toBe(5000);
      expect(cache.lruStrategy).toBe('access');
      expect(cache.trackMetrics).toBe(true);
      expect(cache.name).toBe('TestCache');
    });
  });

  describe('get/set basics', () => {
    beforeEach(() => {
      cache = new LRUCache({ maxSize: 5, ttlMs: 1000 });
    });

    test('stores and retrieves values', () => {
      cache.set('key1', 'value1');
      cache.set('key2', { nested: 'object' });

      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toEqual({ nested: 'object' });
    });

    test('returns null for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    test('updates existing key', () => {
      cache.set('key1', 'original');
      cache.set('key1', 'updated');

      expect(cache.get('key1')).toBe('updated');
      expect(cache.size).toBe(1);
    });
  });

  describe('TTL expiration', () => {
    test('returns null for expired entry', async () => {
      cache = new LRUCache({ maxSize: 5, ttlMs: 50 });
      cache.set('key1', 'value1');

      expect(cache.get('key1')).toBe('value1');

      await new Promise((r) => setTimeout(r, 100));

      expect(cache.get('key1')).toBeNull();
    });

    test('cleanup removes expired entries', async () => {
      cache = new LRUCache({ maxSize: 5, ttlMs: 50 });
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      await new Promise((r) => setTimeout(r, 100));

      cache.cleanup();

      expect(cache.size).toBe(0);
    });
  });

  describe('LRU eviction - insertion strategy', () => {
    beforeEach(() => {
      cache = new LRUCache({ maxSize: 3, ttlMs: 10000, lruStrategy: 'insertion' });
    });

    test('evicts oldest inserted entry when at capacity', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      cache.set('key4', 'value4');

      expect(cache.size).toBe(3);
      expect(cache.get('key1')).toBeNull(); // Evicted
      expect(cache.get('key2')).toBe('value2');
      expect(cache.get('key4')).toBe('value4');
    });

    test('re-setting key updates its position', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key1', 'updated'); // Moves key1 to end
      cache.set('key3', 'value3');
      cache.set('key4', 'value4');

      expect(cache.get('key2')).toBeNull(); // key2 was evicted (oldest)
      expect(cache.get('key1')).toBe('updated'); // key1 survived
    });
  });

  describe('LRU eviction - access strategy', () => {
    beforeEach(() => {
      cache = new LRUCache({ maxSize: 3, ttlMs: 10000, lruStrategy: 'access' });
    });

    test('evicts least recently accessed entry', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Access key1 and key3, making key2 LRU
      cache.get('key1');
      cache.get('key3');

      cache.set('key4', 'value4');

      expect(cache.get('key2')).toBeNull(); // key2 was LRU, evicted
      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key3')).toBe('value3');
      expect(cache.get('key4')).toBe('value4');
    });

    test('get updates access time', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // Access key2 and key3, leaving key1 as LRU
      cache.get('key2');
      cache.get('key3');

      cache.set('key4', 'value4');

      expect(cache.get('key1')).toBeNull(); // key1 was LRU
    });
  });

  describe('metrics tracking', () => {
    test('does not track when disabled', () => {
      cache = new LRUCache({ maxSize: 5, trackMetrics: false });
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('missing');

      const stats = cache.getStats();
      expect(stats.hits).toBeUndefined();
      expect(stats.misses).toBeUndefined();
    });

    test('tracks hits and misses when enabled', () => {
      cache = new LRUCache({ maxSize: 5, trackMetrics: true });
      cache.set('key1', 'value1');

      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('missing'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe('66.67%');
    });

    test('tracks evictions', () => {
      cache = new LRUCache({ maxSize: 2, trackMetrics: true });
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3'); // Evicts key1

      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
    });
  });

  describe('has', () => {
    beforeEach(() => {
      cache = new LRUCache({ maxSize: 5, ttlMs: 1000 });
    });

    test('returns true for existing non-expired entry', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
    });

    test('returns false for non-existent entry', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    test('returns false for expired entry', async () => {
      cache = new LRUCache({ maxSize: 5, ttlMs: 50 });
      cache.set('key1', 'value1');

      await new Promise((r) => setTimeout(r, 100));

      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      cache = new LRUCache({ maxSize: 5 });
    });

    test('removes entry from cache', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.delete('key1');

      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBe('value2');
    });

    test('handles non-existent key', () => {
      expect(() => cache.delete('nonexistent')).not.toThrow();
    });
  });

  describe('invalidateWhere', () => {
    beforeEach(() => {
      cache = new LRUCache({ maxSize: 10 });
    });

    test('removes entries matching predicate', () => {
      cache.set('file:abc123:v1', 'data1');
      cache.set('file:abc123:v2', 'data2');
      cache.set('file:def456:v1', 'data3');

      const removed = cache.invalidateWhere((key) => key.includes('abc123'));

      expect(removed).toBe(2);
      expect(cache.get('file:abc123:v1')).toBeNull();
      expect(cache.get('file:abc123:v2')).toBeNull();
      expect(cache.get('file:def456:v1')).toBe('data3');
    });

    test('handles no matches', () => {
      cache.set('key1', 'value1');

      const removed = cache.invalidateWhere((key) => key.includes('nomatch'));

      expect(removed).toBe(0);
      expect(cache.get('key1')).toBe('value1');
    });
  });

  describe('clear', () => {
    test('removes all entries', () => {
      cache = new LRUCache({ maxSize: 5 });
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeNull();
    });

    test('resets metrics', () => {
      cache = new LRUCache({ maxSize: 5, trackMetrics: true });
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('missing');

      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('lifecycle', () => {
    test('initialize starts cleanup interval', () => {
      cache = new LRUCache({ maxSize: 5 });

      expect(cache.initialized).toBe(false);
      expect(cache.cleanupInterval).toBeNull();

      cache.initialize(1000);

      expect(cache.initialized).toBe(true);
      expect(cache.cleanupInterval).not.toBeNull();
    });

    test('initialize is idempotent', () => {
      cache = new LRUCache({ maxSize: 5 });
      cache.initialize(1000);
      const interval = cache.cleanupInterval;

      cache.initialize(1000);

      expect(cache.cleanupInterval).toBe(interval);
    });

    test('shutdown clears interval and cache', async () => {
      cache = new LRUCache({ maxSize: 5 });
      cache.initialize(1000);
      cache.set('key1', 'value1');

      await cache.shutdown();

      expect(cache.cleanupInterval).toBeNull();
      expect(cache.initialized).toBe(false);
      expect(cache.size).toBe(0);
    });

    test('shutdown is safe to call multiple times', async () => {
      cache = new LRUCache({ maxSize: 5 });

      await expect(cache.shutdown()).resolves.not.toThrow();
      await expect(cache.shutdown()).resolves.not.toThrow();
    });
  });

  describe('getStats', () => {
    test('returns basic stats without metrics', () => {
      cache = new LRUCache({ maxSize: 10, ttlMs: 5000 });
      cache.set('key1', 'value1');

      const stats = cache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.maxSize).toBe(10);
      expect(stats.ttlMs).toBe(5000);
    });

    test('returns full stats with metrics enabled', () => {
      cache = new LRUCache({ maxSize: 10, trackMetrics: true });
      cache.set('key1', 'value1');
      cache.get('key1');

      const stats = cache.getStats();

      expect(stats).toHaveProperty('hits');
      expect(stats).toHaveProperty('misses');
      expect(stats).toHaveProperty('evictions');
      expect(stats).toHaveProperty('hitRate');
    });
  });

  describe('edge cases', () => {
    test('handles empty cache operations', () => {
      cache = new LRUCache({ maxSize: 5 });

      expect(cache.get('any')).toBeNull();
      expect(cache.has('any')).toBe(false);
      expect(() => cache.delete('any')).not.toThrow();
      expect(() => cache.clear()).not.toThrow();
      expect(() => cache.cleanup()).not.toThrow();
    });

    test('handles maxSize of 1', () => {
      cache = new LRUCache({ maxSize: 1 });
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      expect(cache.size).toBe(1);
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBe('value2');
    });

    test('handles various data types', () => {
      cache = new LRUCache({ maxSize: 10 });

      cache.set('string', 'value');
      cache.set('number', 42);
      cache.set('boolean', true);
      cache.set('null', null);
      cache.set('array', [1, 2, 3]);
      cache.set('object', { a: 1 });

      expect(cache.get('string')).toBe('value');
      expect(cache.get('number')).toBe(42);
      expect(cache.get('boolean')).toBe(true);
      expect(cache.get('null')).toBeNull(); // null is valid cache value
      expect(cache.get('array')).toEqual([1, 2, 3]);
      expect(cache.get('object')).toEqual({ a: 1 });
    });
  });
});
