import { test } from "node:test";
import assert from "node:assert/strict";

// grafanaClient.js reads its config at import time and refuses to make calls
// unless configured, so set a deterministic config before importing.
process.env.GRAFANA_ENABLED = "true";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";

const { fetchMatchingStreams, fetchLabelValues, suggestClients } = await import("./lokiDiscovery.js");

// Answer every request with Loki's `{ status, data }` (or an HTTP error when
// `status` is not 200) and record the URLs requested.
function withFetch({ data = [], status = 200 }, fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: status === 200,
      status,
      text: () => Promise.resolve(status === 200 ? JSON.stringify({ status: "success", data }) : ""),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

test("fetchMatchingStreams: asks /series through the datasource proxy and keeps namespace + service_name", async () => {
  await withFetch({ data: [{ namespace: "april-prod", service_name: "april-gw", pod: "a" }, { pod: "b" }] }, async (calls) => {
    const streams = await fetchMatchingStreams("logs-uid", { query: '{namespace="april-prod"}', from: "now-1h", to: "now" });
    assert.deepEqual(streams, [
      { namespace: "april-prod", service_name: "april-gw" },
      { namespace: null, service_name: null },
    ]);
    const url = new URL(calls[0]);
    assert.equal(url.pathname, "/api/datasources/proxy/uid/logs-uid/loki/api/v1/series");
    assert.equal(url.searchParams.get("match[]"), '{namespace="april-prod"}');
    assert.ok(url.searchParams.get("start"));
    assert.ok(url.searchParams.get("end"));
  });
});

test("fetchLabelValues: reads the label's values through the datasource proxy", async () => {
  await withFetch({ data: ["april-prod", "april-rec"] }, async (calls) => {
    const values = await fetchLabelValues("logs-uid", "namespace", { from: "now-1h" });
    assert.deepEqual(values, ["april-prod", "april-rec"]);
    assert.equal(new URL(calls[0]).pathname, "/api/datasources/proxy/uid/logs-uid/loki/api/v1/label/namespace/values");
  });
});

test("fetchLabelValues: a failed call throws, so the caller decides what it means", async () => {
  await withFetch({ status: 502 }, async () => {
    await assert.rejects(() => fetchLabelValues("logs-uid", "namespace", { from: "now-1h" }), /HTTP 502/);
  });
});

test("suggestClients: ranks service_name values close to the client text", async () => {
  await withFetch({ data: ["graviteeio-ae-april-rec-engine", "graviteeio-ae-alliander-ui"] }, async (calls) => {
    const suggestions = await suggestClients("logs-uid", "aprl", { from: "now-1h" });
    assert.ok(suggestions.includes("graviteeio-ae-april-rec-engine"));
    assert.ok(calls[0].includes("label/service_name/values"));
  });
});

test("suggestClients: a failed call gives no suggestions instead of failing the tool", async () => {
  await withFetch({ status: 502 }, async () => {
    assert.deepEqual(await suggestClients("logs-uid", "aprl", { from: "now-1h" }), []);
  });
});
