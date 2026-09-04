/**
 * Unit Tests for DataCache
 *
 * Written against the API DataCache actually exposes. The real shapes are:
 *   - caches.parsedConversations  (not "parsedData")
 *   - this.config                 (not "options"); the constructor takes no arguments
 *   - eviction is evictOldEntries() / enforceSizeLimits()
 *
 * fs-extra is mocked with an explicit factory rather than bare jest.mock():
 * fs-extra re-exports graceful-fs through getters, so automocking leaves
 * fs.stat as a non-mock function.
 *
 * jest.mock() is written ABOVE the requires on purpose. jest.config.js
 * currently sets `transform: {}`, which disables babel-plugin-jest-hoist, so
 * mock calls are not hoisted. Ordering it manually keeps this suite green both
 * before and after that config is fixed.
 */

jest.mock('fs-extra', () => ({
  stat: jest.fn(),
  readFile: jest.fn(),
}));

const fs = require('fs-extra');
const DataCache = require('../../src/analytics/data/DataCache');

const statsFor = (mtimeMs) => ({ mtime: new Date(mtimeMs), size: 1234 });

describe('DataCache', () => {
  let dataCache;

  beforeEach(() => {
    jest.clearAllMocks();
    dataCache = new DataCache();
  });

  afterEach(() => {
    // Stops the housekeeping interval so the runner can exit.
    dataCache.cleanup();
  });

  describe('constructor', () => {
    it('creates the documented cache buckets', () => {
      expect(dataCache.caches.fileContent).toBeInstanceOf(Map);
      expect(dataCache.caches.parsedConversations).toBeInstanceOf(Map);
      expect(dataCache.caches.tokenUsage).toBeInstanceOf(Map);
      expect(dataCache.caches.fileStats).toBeInstanceOf(Map);
    });

    it('creates dependency-tracked computation buckets', () => {
      expect(dataCache.caches.sessions.data).toBeNull();
      expect(dataCache.caches.sessions.dependencies).toBeInstanceOf(Set);
      expect(dataCache.caches.summary.data).toBeNull();
    });

    it('starts with zeroed metrics', () => {
      expect(dataCache.metrics.hits).toBe(0);
      expect(dataCache.metrics.misses).toBe(0);
      expect(dataCache.metrics.invalidations).toBe(0);
      expect(dataCache.metrics.evictions).toBe(0);
    });

    it('exposes TTL configuration on config', () => {
      expect(dataCache.config.fileContentTTL).toBe(60000);
      expect(dataCache.config.parsedDataTTL).toBe(30000);
      expect(dataCache.config.maxCacheSize).toBe(50);
    });
  });

  describe('getFileContent', () => {
    it('reads and caches on a miss', async () => {
      fs.stat.mockResolvedValue(statsFor(1000));
      fs.readFile.mockResolvedValue('file body');

      const content = await dataCache.getFileContent('/a.jsonl');

      expect(content).toBe('file body');
      expect(fs.readFile).toHaveBeenCalledWith('/a.jsonl', 'utf8');
      expect(dataCache.metrics.misses).toBe(1);
      expect(dataCache.caches.fileContent.get('/a.jsonl').content).toBe('file body');
      expect(dataCache.caches.fileStats.has('/a.jsonl')).toBe(true);
    });

    it('serves from cache when the file has not changed', async () => {
      fs.stat.mockResolvedValue(statsFor(1000));
      fs.readFile.mockResolvedValue('file body');

      await dataCache.getFileContent('/a.jsonl');
      const second = await dataCache.getFileContent('/a.jsonl');

      expect(second).toBe('file body');
      expect(fs.readFile).toHaveBeenCalledTimes(1);
      expect(dataCache.metrics.hits).toBe(1);
    });

    it('re-reads when the file has been modified', async () => {
      fs.stat.mockResolvedValueOnce(statsFor(1000));
      fs.readFile.mockResolvedValueOnce('old');
      await dataCache.getFileContent('/a.jsonl');

      fs.stat.mockResolvedValueOnce(statsFor(2000));
      fs.readFile.mockResolvedValueOnce('new');
      const content = await dataCache.getFileContent('/a.jsonl');

      expect(content).toBe('new');
      expect(fs.readFile).toHaveBeenCalledTimes(2);
    });

    it('invalidates and rethrows when the file cannot be read', async () => {
      fs.stat.mockRejectedValue(new Error('ENOENT'));

      await expect(dataCache.getFileContent('/missing.jsonl')).rejects.toThrow('ENOENT');
      expect(dataCache.caches.fileContent.has('/missing.jsonl')).toBe(false);
      expect(dataCache.metrics.filesInvalidated).toBe(1);
    });
  });

  describe('getFileStats', () => {
    it('caches stats and serves them within the metadata TTL', async () => {
      fs.stat.mockResolvedValue(statsFor(1000));

      await dataCache.getFileStats('/a.jsonl');
      await dataCache.getFileStats('/a.jsonl');

      expect(fs.stat).toHaveBeenCalledTimes(1);
      expect(dataCache.metrics.hits).toBe(1);
      expect(dataCache.metrics.misses).toBe(1);
    });
  });

  describe('invalidateFile', () => {
    it('removes every per-file cache entry and counts the invalidation', () => {
      dataCache.caches.fileContent.set('/a.jsonl', { content: 'x', timestamp: 1 });
      dataCache.caches.parsedConversations.set('/a.jsonl', { messages: [], timestamp: 1 });
      dataCache.caches.tokenUsage.set('/a.jsonl', { usage: {}, timestamp: 1 });
      dataCache.caches.fileStats.set('/a.jsonl', { stats: {}, timestamp: 1 });

      dataCache.invalidateFile('/a.jsonl');

      expect(dataCache.caches.fileContent.has('/a.jsonl')).toBe(false);
      expect(dataCache.caches.parsedConversations.has('/a.jsonl')).toBe(false);
      expect(dataCache.caches.tokenUsage.has('/a.jsonl')).toBe(false);
      expect(dataCache.caches.fileStats.has('/a.jsonl')).toBe(false);
      expect(dataCache.metrics.filesInvalidated).toBe(1);
      expect(dataCache.metrics.invalidations).toBe(1);
    });

    it('resets computations that depend on the file', () => {
      dataCache.caches.sessions = {
        data: ['cached'],
        timestamp: 123,
        dependencies: new Set(['/a.jsonl']),
      };

      dataCache.invalidateFile('/a.jsonl');

      expect(dataCache.caches.sessions.data).toBeNull();
      expect(dataCache.caches.sessions.timestamp).toBe(0);
      expect(dataCache.metrics.computationsInvalidated).toBe(1);
    });

    it('leaves unrelated computations alone', () => {
      dataCache.caches.summary = {
        data: ['keep'],
        timestamp: 123,
        dependencies: new Set(['/other.jsonl']),
      };

      dataCache.invalidateFile('/a.jsonl');

      expect(dataCache.caches.summary.data).toEqual(['keep']);
      expect(dataCache.metrics.computationsInvalidated).toBe(0);
    });
  });

  describe('invalidateFiles', () => {
    it('invalidates each path', () => {
      dataCache.caches.fileContent.set('/a', { content: 'a', timestamp: 1 });
      dataCache.caches.fileContent.set('/b', { content: 'b', timestamp: 1 });

      dataCache.invalidateFiles(['/a', '/b']);

      expect(dataCache.caches.fileContent.size).toBe(0);
      expect(dataCache.metrics.filesInvalidated).toBe(2);
    });
  });

  describe('invalidateComputations', () => {
    it('clears sessions and summary and counts both', () => {
      dataCache.caches.sessions.data = ['x'];
      dataCache.caches.summary.data = ['y'];

      dataCache.invalidateComputations();

      expect(dataCache.caches.sessions.data).toBeNull();
      expect(dataCache.caches.summary.data).toBeNull();
      expect(dataCache.metrics.computationsInvalidated).toBe(2);
    });
  });

  describe('evictOldEntries', () => {
    it('drops entries past their TTL and keeps fresh ones', () => {
      const now = Date.now();
      dataCache.caches.fileContent.set('/old', { content: 'o', timestamp: now - 120000 });
      dataCache.caches.fileContent.set('/fresh', { content: 'f', timestamp: now });
      dataCache.caches.parsedConversations.set('/oldparse', { messages: [], timestamp: now - 120000 });

      dataCache.evictOldEntries();

      expect(dataCache.caches.fileContent.has('/old')).toBe(false);
      expect(dataCache.caches.fileContent.has('/fresh')).toBe(true);
      expect(dataCache.caches.parsedConversations.has('/oldparse')).toBe(false);
    });

    it('does nothing when every entry is fresh', () => {
      dataCache.caches.fileContent.set('/fresh', { content: 'f', timestamp: Date.now() });

      dataCache.evictOldEntries();

      expect(dataCache.caches.fileContent.size).toBe(1);
    });
  });

  describe('enforceSizeLimits', () => {
    it('trims the oldest entries down to maxCacheSize', () => {
      dataCache.configure({ maxCacheSize: 3 });
      const now = Date.now();
      for (let i = 0; i < 6; i++) {
        dataCache.caches.tokenUsage.set(`/f${i}`, { usage: {}, timestamp: now + i });
      }

      dataCache.enforceSizeLimits();

      expect(dataCache.caches.tokenUsage.size).toBe(3);
      expect(dataCache.caches.tokenUsage.has('/f0')).toBe(false);
      expect(dataCache.caches.tokenUsage.has('/f5')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('reports a 0 hit rate before any traffic', () => {
      expect(dataCache.getStats().hitRate).toBe('0%');
    });

    it('computes the hit rate and per-bucket sizes', () => {
      dataCache.metrics.hits = 3;
      dataCache.metrics.misses = 1;
      dataCache.caches.fileContent.set('/a', { content: 'a', timestamp: 1 });

      const stats = dataCache.getStats();

      expect(stats.hitRate).toBe('75.00%');
      expect(stats.cacheSize.fileContent).toBe(1);
      expect(stats.cacheSize.parsedConversations).toBe(0);
      expect(stats.memoryUsage).toHaveProperty('heapUsed');
    });
  });

  describe('needsWarming', () => {
    it('is true with fewer than 10 samples', () => {
      dataCache.metrics.hits = 4;
      dataCache.metrics.misses = 2;
      expect(dataCache.needsWarming()).toBe(true);
    });

    it('is true when the hit rate is under 50%', () => {
      dataCache.metrics.hits = 4;
      dataCache.metrics.misses = 16;
      expect(dataCache.needsWarming()).toBe(true);
    });

    it('is false once the hit rate is healthy', () => {
      dataCache.metrics.hits = 18;
      dataCache.metrics.misses = 2;
      expect(dataCache.needsWarming()).toBe(false);
    });
  });

  describe('configure', () => {
    it('merges over existing config without dropping keys', () => {
      dataCache.configure({ maxCacheSize: 5 });

      expect(dataCache.config.maxCacheSize).toBe(5);
      expect(dataCache.config.fileContentTTL).toBe(60000);
    });
  });

  describe('clearAll', () => {
    it('empties every cache bucket and resets counters', () => {
      dataCache.caches.fileContent.set('/a', { content: 'a', timestamp: 1 });
      dataCache.caches.sessions.data = ['x'];
      dataCache.metrics.hits = 5;

      dataCache.clearAll();

      expect(dataCache.caches.fileContent.size).toBe(0);
      expect(dataCache.caches.sessions.data).toBeNull();
      expect(dataCache.metrics.hits).toBe(0);
      expect(dataCache.metrics.misses).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('stops the housekeeping timer and clears caches', () => {
      dataCache.caches.fileContent.set('/a', { content: 'a', timestamp: 1 });

      dataCache.cleanup();

      expect(dataCache.cleanupInterval).toBeNull();
      expect(dataCache.caches.fileContent.size).toBe(0);
    });
  });
});
