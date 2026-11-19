/**
 * Cache-Aside Layer
 *
 * Provides a unified in-memory/Redis cache with TTL expiration and hit/miss metrics.
 * - If REDIS_URL is set: uses ioredis with per-key TTL.
 * - Otherwise: uses an in-memory Map with a default TTL of 300s.
 */

let redisClient = null;
let cacheMode = "in-memory";

let inMemoryCache = new Map();
const defaultTTL = 300 * 1000; // 300 seconds = 5 minutes
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Initialize the cache layer.
 * @param {import('ioredis')} [client] - ioredis instance (optional)
 */
async function initCache(client) {
  if (client) {
    try {
      await client.ping();
      redisClient = client;
      cacheMode = "redis";
      console.log("[cache] Redis connected.");
      return;
    } catch (err) {
      console.warn(
        `[cache] Redis connection failed, falling back to in-memory: ${err.message}`
      );
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  redisClient = null;
  cacheMode = "in-memory";
  inMemoryCache = new Map();
  cacheHits = 0;
  cacheMisses = 0;
  console.log(`[cache] Using in-memory cache with TTL = ${defaultTTL / 1000}s`);
}

/**
 * Get a value from the cache.
 * @param {string} key
 * @returns {Promise<{found: boolean, value: any}>}
 */
async function get(key) {
  if (redisClient) {
    try {
      const value = await redisClient.get(key);
      if (value !== null) {
        cacheHits++;
        return { found: true, value: JSON.parse(value) };
      }
      cacheMisses++;
      return { found: false, value: null };
    } catch (err) {
      console.error("[cache] Redis GET error:", err.message);
      cacheMisses++;
      return { found: false, value: null };
    }
  }

  const entry = inMemoryCache.get(key);
  if (entry && entry.expiry > Date.now()) {
    cacheHits++;
    return { found: true, value: entry.value };
  }
  if (entry) inMemoryCache.delete(key);
  cacheMisses++;
  return { found: false, value: null };
}

/**
 * Set a value in the cache with a TTL.
 * @param {string} key
 * @param {any} value
 * @param {number} [ttlMs] - override default TTL
 */
async function set(key, value, ttlMs) {
  const ttl = ttlMs || defaultTTL;
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), "PX", ttl);
      return;
    } catch (err) {
      console.error("[cache] Redis SET error:", err.message);
    }
  }
  inMemoryCache.set(key, { expiry: Date.now() + ttl, value });
}

/**
 * Delete a key from the cache.
 * @param {string} key
 */
async function del(key) {
  if (redisClient) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error("[cache] Redis DEL error:", err.message);
    }
  }
  inMemoryCache.delete(key);
}

/**
 * Increment a counter in the cache.
 * @param {string} key
 * @param {number} [ttlMs] - TTL applied when the key is first created
 * @returns {Promise<number>} value after increment
 */
async function incr(key, ttlMs) {
  const ttl = ttlMs || defaultTTL;
  if (redisClient) {
    try {
      const value = await redisClient.incr(key);
      if (value === 1) {
        await redisClient.pexpire(key, ttl);
      }
      return value;
    } catch (err) {
      console.error("[cache] Redis INCR error:", err.message);
    }
  }

  const entry = inMemoryCache.get(key);
  if (entry && entry.expiry > Date.now()) {
    const newVal = (entry.value || 0) + 1;
    inMemoryCache.set(key, { expiry: entry.expiry, value: newVal });
    return newVal;
  }
  inMemoryCache.set(key, { value: 1, expiry: Date.now() + ttl });
  return 1;
}

/**
 * Get cache metrics.
 * @returns {{hits: number, misses: number, hitRatio: string|number, mode: string}}
 */
function getStats() {
  const total = cacheHits + cacheMisses;
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRatio: total > 0 ? ((cacheHits / total) * 100).toFixed(2) : "0.00",
    mode: cacheMode,
  };
}

/**
 * Test helper: clear the in-memory cache and counters.
 */
function resetInMemory() {
  inMemoryCache = new Map();
  cacheHits = 0;
  cacheMisses = 0;
}

/* --- Export --- */

module.exports = {
  initCache,
  get,
  set,
  del,
  incr,
  getStats,
  resetInMemory,
};
