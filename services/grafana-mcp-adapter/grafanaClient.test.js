import { test } from "node:test";
import assert from "node:assert/strict";

// These tests exercise config validation and the param-building behavior of the
// Grafana client without making real network calls. We import lazily inside each
// test after setting env, since the module reads env at import time.

async function freshClient(env) {
  // Reset relevant env, apply overrides, then import a fresh module instance.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GRAFANA_")) delete process.env[key];
  }
  Object.assign(process.env, env);
  // Cache-bust the ESM import so module-level env reads re-run.
  return import(`./grafanaClient.js?t=${Date.now()}-${Math.random()}`);
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test("requireConfig: throws when disabled", async () => {
  const { requireConfig } = await freshClient({ GRAFANA_ENABLED: "false" });
  assert.throws(() => requireConfig(), /disabled/);
});

test("requireConfig: throws when enabled but no base url", async () => {
  const { requireConfig } = await freshClient({ GRAFANA_ENABLED: "true", GRAFANA_TOKEN: "glsa_x", GRAFANA_BASE_URL: "" });
  assert.throws(() => requireConfig(), /GRAFANA_BASE_URL is required/);
});

test("requireConfig: throws when enabled but no token", async () => {
  const { requireConfig } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "",
  });
  assert.throws(() => requireConfig(), /GRAFANA_TOKEN is required/);
});

test("requireConfig: passes when enabled with base url + token", async () => {
  const { requireConfig } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "glsa_secret",
  });
  assert.doesNotThrow(() => requireConfig());
});

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

test("authHeaders: sends the token as a Bearer Authorization header", async () => {
  const { authHeaders } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "glsa_secret",
  });
  assert.deepEqual(authHeaders(), { Authorization: "Bearer glsa_secret" });
});

// ---------------------------------------------------------------------------
// grafanaGet param handling (no real network: stub fetch)
// ---------------------------------------------------------------------------

test("grafanaGet: prefixes /api, drops empty params and expands arrays", async () => {
  const { grafanaGet } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "glsa_secret",
  });

  let capturedUrl = null;
  let capturedHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    capturedUrl = url;
    capturedHeaders = opts.headers;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify([])),
      headers: { get: () => null },
    });
  };

  try {
    await grafanaGet("/search", {
      query: "cpu",
      type: "",
      limit: undefined,
      tag: ["prod", "db"],
    });
  } finally {
    globalThis.fetch = origFetch;
  }

  const u = new URL(capturedUrl);
  assert.equal(u.pathname, "/api/search");
  assert.equal(u.searchParams.get("query"), "cpu");
  assert.equal(u.searchParams.has("type"), false, "empty param must be dropped");
  assert.equal(u.searchParams.has("limit"), false, "undefined param must be dropped");
  assert.deepEqual(u.searchParams.getAll("tag"), ["prod", "db"]);
  assert.equal(capturedHeaders["Authorization"], "Bearer glsa_secret");
});

test("grafanaGet: throws on non-OK HTTP status", async () => {
  const { grafanaGet } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "glsa_secret",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve(""),
      headers: { get: () => null },
    });
  try {
    await assert.rejects(() => grafanaGet("/search"), /HTTP 401/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafanaPost: sends JSON body with Content-Type", async () => {
  const { grafanaPost } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "glsa_secret",
  });

  let capturedOpts = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (_url, opts) => {
    capturedOpts = opts;
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ results: {} })),
      headers: { get: () => null },
    });
  };

  try {
    await grafanaPost("/ds/query", { from: "now-1h", to: "now", queries: [] });
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(capturedOpts.method, "POST");
  assert.equal(capturedOpts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(capturedOpts.body), { from: "now-1h", to: "now", queries: [] });
});
