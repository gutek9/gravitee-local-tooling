import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The adapter with Grafana disabled, as Compose starts it by default. Its own
// file because grafanaClient.js reads GRAFANA_ENABLED once, at import time;
// node --test runs each file in a separate process. Everything else is set as
// for an enabled adapter, so only GRAFANA_ENABLED stands between the tools and
// the network, including the GitHub token the customer map would be read with.
process.env.GRAFANA_ENABLED = "false";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";
process.env.GRAFANA_LOGS_DATASOURCE_UID = "grafanacloud-logs";
process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "test-token";
process.env.GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH = join(tmpdir(), `grafana-disabled-test-${process.pid}`, "none.json");

const { tools, startupWarmUp } = await import("./server.js");
const { resetCustomerMapCache } = await import("./customerMapLoader.js");

// Record every request, answer none of them usefully.
async function withRecordedFetch(fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  resetCustomerMapCache();
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// Long enough for a fire-and-forget load to reach fetch, if one was started.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("disabled: starting up does not read the customer map from GitHub", async () => {
  // Regression: startup warmed the map whatever GRAFANA_ENABLED said, so every
  // `local-tooling up` read the private repository with the user's token.
  await withRecordedFetch(async (calls) => {
    startupWarmUp();
    await settle();
    assert.deepEqual(calls, []);
  });
});

test("disabled: the map tools say Grafana is disabled, and make no request at all", async () => {
  // Regression: find_customer returned customers from the map (two GitHub
  // calls), and logs_link read the map before failing on Grafana.
  await withRecordedFetch(async (calls) => {
    await assert.rejects(tools.grafana_find_customer({ query: "acme" }, {}), /Grafana is disabled/);
    await assert.rejects(tools.grafana_logs_link({ client: "acme" }, {}), /Grafana is disabled/);
    assert.deepEqual(calls, []);
  });
});
