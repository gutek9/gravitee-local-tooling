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

test("requireDatasourceUid: returns the configured uid", async () => {
  const { requireDatasourceUid } = await freshClient({});
  assert.equal(requireDatasourceUid("grafanacloud-logs"), "grafanacloud-logs");
  assert.equal(requireDatasourceUid("  padded-uid  "), "padded-uid");
});

test("requireDatasourceUid: unset/blank fails with an actionable message", async () => {
  const { requireDatasourceUid } = await freshClient({});
  for (const bad of [undefined, null, "", "   "]) {
    assert.throws(() => requireDatasourceUid(bad), /GRAFANA_LOGS_DATASOURCE_UID is not set/);
  }
  // The message must say the uid can differ from the display name — the exact
  // assumption that cost time on this instance.
  assert.throws(() => requireDatasourceUid(""), /not always the same as the display name/);
  // Regression: it said to run `docker compose up -d --force-recreate`, which
  // never reaches the container the agent starts for each session.
  assert.throws(
    () => requireDatasourceUid(""),
    (err) => /restart your agent/.test(err.message) && !/force-recreate/.test(err.message),
  );
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

test("grafanaGet: a failed request carries its HTTP status, never the token or the response body", async () => {
  // The status lets a caller tell a failure a retry may fix from one it will
  // not; the body stays out of the message because it may echo request details.
  const { grafanaGet } = await freshClient({
    GRAFANA_ENABLED: "true",
    GRAFANA_BASE_URL: "https://g.example.com",
    GRAFANA_TOKEN: "glsa_secret",
  });
  const path = "/datasources/proxy/uid/logs/loki/api/v1/label/namespace/values";
  const origFetch = globalThis.fetch;
  try {
    for (const [status, retryAfter] of [
      [404, null],
      [503, "30"],
    ]) {
      globalThis.fetch = () =>
        Promise.resolve({
          ok: false,
          status,
          text: () => Promise.resolve('{"message":"body echoing glsa_secret"}'),
          headers: { get: (name) => (name === "retry-after" ? retryAfter : null) },
        });
      await assert.rejects(
        () => grafanaGet(path),
        (err) => {
          assert.equal(err.status, status);
          assert.ok(err.message.startsWith(`Grafana GET ${path} failed with HTTP ${status}`), err.message);
          assert.doesNotMatch(err.message, /glsa_secret|body echoing/);
          return true;
        },
      );
    }
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

// ---------------------------------------------------------------------------
// Read-only enforcement at the HTTP boundary
// ---------------------------------------------------------------------------

function stubFetch() {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve("{}"),
      headers: { get: () => null },
    });
  };
  return { calls, restore: () => (globalThis.fetch = origFetch) };
}

const ENABLED_ENV = {
  GRAFANA_ENABLED: "true",
  GRAFANA_BASE_URL: "https://g.example.com",
  GRAFANA_TOKEN: "glsa_secret",
};

test("grafanaPost: refuses any path other than /ds/query without calling fetch", async () => {
  const { grafanaPost } = await freshClient(ENABLED_ENV);
  const { calls, restore } = stubFetch();
  try {
    for (const path of [
      "/dashboards/db",
      "/annotations",
      "/alertmanager/grafana/api/v2/silences",
      "/datasources/proxy/uid/loki/loki/api/v1/push",
      "/ds/query/../dashboards/db",
      "/ds/query/",
      "/ds/query?x=1",
      "/DS/QUERY",
    ]) {
      await assert.rejects(() => grafanaPost(path, {}), /read-only: refusing POST/, path);
    }
  } finally {
    restore();
  }
  assert.equal(calls.length, 0, "a refused request must never reach the network");
});

test("grafanaPost and grafanaGet: allowed requests reach fetch", async () => {
  const { grafanaPost, grafanaGet, grafanaDatasourceProxyGet } = await freshClient(ENABLED_ENV);
  const { calls, restore } = stubFetch();
  try {
    await grafanaPost("/ds/query", { queries: [] });
    await grafanaGet("/datasources");
    await grafanaDatasourceProxyGet("loki-uid", "loki/api/v1/query_range", { query: "{a=\"b\"}" });
  } finally {
    restore();
  }
  assert.deepEqual(
    calls.map((c) => [c.opts.method, new URL(c.url).pathname]),
    [
      ["POST", "/api/ds/query"],
      ["GET", "/api/datasources"],
      ["GET", "/api/datasources/proxy/uid/loki-uid/loki/api/v1/query_range"],
    ],
  );
});

test("assertReadOnlyRequest: mutating verbs are refused on every path", async () => {
  const { assertReadOnlyRequest } = await freshClient(ENABLED_ENV);
  for (const verb of ["PUT", "PATCH", "DELETE", "put", undefined]) {
    assert.throws(() => assertReadOnlyRequest(verb, "/ds/query"), /read-only/, String(verb));
  }
  assert.doesNotThrow(() => assertReadOnlyRequest("get", "/anything"));
  assert.doesNotThrow(() => assertReadOnlyRequest("POST", "/ds/query"));
});

test("read-only check runs before config validation", async () => {
  const { grafanaPost } = await freshClient({ GRAFANA_ENABLED: "false" });
  await assert.rejects(() => grafanaPost("/dashboards/db", {}), /read-only/);
});
