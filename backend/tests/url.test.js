/**
 * Integration tests for the URL shortener API.
 * Runs against the JSON file store with an isolated temp data file.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const request = require("supertest");

const DATA_FILE = path.join(os.tmpdir(), `url-shortener-test-${process.pid}.json`);

process.env.NODE_ENV = "test";
process.env.DATA_FILE = DATA_FILE;
process.env.RATE_LIMIT_MAX = "30";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const { app, initializeApp } = require("../src/app");
const cache = require("../src/cache/cacheManager");
const rateLimiter = require("../src/middleware/rateLimiter");

let server;

beforeAll(async () => {
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  await initializeApp();
  server = app.listen(0);
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
});

beforeEach(() => {
  rateLimiter.reset();
});

describe("URL shortener API", () => {
  test("GET /api/health reports storage and cache modes", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.storageMode).toBe("json-file");
    expect(res.body.cacheMode).toBe("in-memory");
    expect(res.body).toHaveProperty("cacheHitRatio");
  });

  test("POST /api/urls creates a short URL and honours a custom alias", async () => {
    const res = await request(app)
      .post("/api/urls")
      .send({ originalUrl: "https://www.example.com/docs", customAlias: "my-docs" });

    expect(res.status).toBe(201);
    expect(res.body.shortCode).toBe("my-docs");
    expect(res.body.shortUrl).toMatch(/\/my-docs$/);
    expect(res.body.originalUrl).toBe("https://www.example.com/docs");
  });

  test("POST /api/urls rejects invalid URLs and duplicate aliases", async () => {
    const invalid = await request(app)
      .post("/api/urls")
      .send({ originalUrl: "not-a-url" });
    expect(invalid.status).toBe(400);

    await request(app)
      .post("/api/urls")
      .send({ originalUrl: "https://example.org", customAlias: "taken" });

    const duplicate = await request(app)
      .post("/api/urls")
      .send({ originalUrl: "https://example.net", customAlias: "taken" });
    expect(duplicate.status).toBe(409);
  });

  test("GET /:shortCode redirects and reports X-Cache HIT/MISS", async () => {
    const created = await request(app)
      .post("/api/urls")
      .send({ originalUrl: "https://www.example.com/redirect-target" });
    const { shortCode } = created.body;

    // Creating a URL warms the cache.
    const warm = await request(app).get(`/${shortCode}`);
    expect(warm.status).toBe(302);
    expect(warm.headers.location).toBe("https://www.example.com/redirect-target");
    expect(warm.headers["x-cache"]).toBe("HIT");

    // Simulate cache eviction -> first read is a MISS, next is a HIT.
    await cache.del(`url:${shortCode}`);
    const miss = await request(app).get(`/${shortCode}`);
    expect(miss.status).toBe(302);
    expect(miss.headers["x-cache"]).toBe("MISS");

    const hit = await request(app).get(`/${shortCode}`);
    expect(hit.headers["x-cache"]).toBe("HIT");

    const missing = await request(app).get("/does-not-exist");
    expect(missing.status).toBe(404);
  });

  test("GET /api/urls/:shortCode/analytics returns click aggregates", async () => {
    const created = await request(app)
      .post("/api/urls")
      .send({ originalUrl: "https://www.example.com/analytics" });
    const { shortCode } = created.body;

    await request(app).get(`/${shortCode}`);
    await request(app).get(`/${shortCode}`);

    const res = await request(app).get(`/api/urls/${shortCode}/analytics`);

    expect(res.status).toBe(200);
    expect(res.body.totalClicks).toBe(2);
    expect(Array.isArray(res.body.clicksByDay)).toBe(true);
    expect(Array.isArray(res.body.clicksByHour)).toBe(true);
    expect(res.body.browserBreakdown).toBeDefined();
    expect(res.body.osBreakdown).toBeDefined();
    expect(res.body.deviceBreakdown).toBeDefined();
  });

  test("POST /api/urls returns 429 after the rate limit is exhausted", async () => {
    const max = Number(process.env.RATE_LIMIT_MAX);

    for (let i = 0; i < max; i++) {
      const res = await request(app)
        .post("/api/urls")
        .send({ originalUrl: `https://www.example.com/rate/${i}` });
      expect(res.status).toBe(201);
    }

    const blocked = await request(app)
      .post("/api/urls")
      .send({ originalUrl: "https://www.example.com/rate/blocked" });

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Too Many Requests");
    expect(blocked.headers["retry-after"]).toBeDefined();
  });
});
