import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The adapter enabled and configured, except for GRAFANA_LOGS_DATASOURCE_UID.
// Its own file because server.js reads the uid once, at import time; node --test
// runs each file in a separate process.
process.env.GRAFANA_ENABLED = "true";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";
delete process.env.GRAFANA_LOGS_DATASOURCE_UID;
process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "test-token";
process.env.GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH = join(tmpdir(), `grafana-no-uid-test-${process.pid}`, "none.json");

const { tools } = await import("./server.js");
const { resetCustomerMapCache } = await import("./customerMapLoader.js");

test("no datasource uid: the map tools say so, and make no request at all", async () => {
  // Without the check, grafana_logs_link reads the customer map from GitHub, asks
  // Grafana for /datasources/proxy/uid//loki/..., and answers with a failed
  // namespace lookup (HTTP 404) instead of naming the missing setting.
  const calls = [];
  const origFetch = globalThis.fetch;
  resetCustomerMapCache();
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
  };
  try {
    await assert.rejects(tools.grafana_logs_link({ client: "acme" }, {}), /GRAFANA_LOGS_DATASOURCE_UID is not set/);
    await assert.rejects(tools.grafana_find_customer({ query: "acme" }, {}), /GRAFANA_LOGS_DATASOURCE_UID is not set/);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.deepEqual(calls, []);
});
