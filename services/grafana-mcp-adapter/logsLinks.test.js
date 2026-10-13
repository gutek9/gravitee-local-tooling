import { test } from "node:test";
import assert from "node:assert/strict";

// The link builders prefix grafanaClient.js's BASE_URL, which is read at import
// time, so set a deterministic config before importing.
process.env.GRAFANA_ENABLED = "true";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";

const { linksForStreams, explainNoStreams } = await import("./logsLinks.js");

const RANGE = { datasourceUid: "logs-uid", from: "now-1h", to: "now" };

test("linksForStreams: explore gives one raw Explore link, with no per-namespace grouping", () => {
  const links = linksForStreams({
    ...RANGE,
    linkStyle: "explore",
    query: '{namespace="april-prod"}',
    streams: [
      { namespace: "april-prod", service_name: "april-gw" },
      { namespace: "april-rec", service_name: "april-rec-gw" },
    ],
  });
  assert.equal(links.length, 1);
  assert.ok(links[0].url.includes("/explore?"));
  assert.equal(links[0].namespace, undefined);
});

test("linksForStreams: drilldown gives one link per namespace, with its exact service_names deduped", () => {
  const links = linksForStreams({
    ...RANGE,
    linkStyle: "drilldown",
    streams: [
      { namespace: "april-prod", service_name: "april-gw" },
      { namespace: "april-prod", service_name: "april-gw" },
      { namespace: "april-rec", service_name: "april-rec-gw" },
      { namespace: null, service_name: "orphan" },
    ],
  });
  assert.deepEqual(
    links.map((l) => [l.namespace, l.service_names]),
    [
      ["april-prod", ["april-gw"]],
      ["april-rec", ["april-rec-gw"]],
    ],
  );
  assert.ok(links[0].url.includes("/explore/namespace/april-prod/logs"));
  assert.equal(links[0].explore_url, undefined);
});

test("linksForStreams: a line filter adds an explore_url with the exact selector and the filter", () => {
  const [link] = linksForStreams({
    ...RANGE,
    linkStyle: "drilldown",
    lineFilter: "Connection refused",
    streams: [{ namespace: "ghd-prod", service_name: "graviteeio-apim3-gateway" }],
  });
  const panes = JSON.parse(decodeURIComponent(new URL(link.explore_url).searchParams.get("panes")));
  assert.ok(panes.logs.queries[0].expr.includes("Connection refused"));
  assert.ok(panes.logs.queries[0].expr.includes('service_name="graviteeio-apim3-gateway"'));
});

test("explainNoStreams: mapped namespaces Loki has not seen point at a stale map, not a quiet customer", async () => {
  const out = await explainNoStreams({
    ...RANGE,
    namespaces: ["apim-dp-cp1111-dp0003"],
    absentNamespaces: ["apim-dp-cp1111-dp0003"],
    client: "acme qa",
  });
  assert.match(out.note, /1 of the mapped namespace\(s\) \(apim-dp-cp1111-dp0003\) do not appear in Loki/);
  assert.match(out.note, /customer map is stale/);
});

test("explainNoStreams: resolved namespaces mean a quiet range, and Loki is not asked for suggestions", async () => {
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error("must not fetch");
  };
  try {
    const out = await explainNoStreams({ ...RANGE, namespaces: ["april-prod", "april-rec"], client: "april" });
    assert.match(out.note, /No log streams in this range for namespace\(s\) april-prod, april-rec/);
    assert.equal(out.suggestions, undefined);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
