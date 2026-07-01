import { test } from "node:test";
import assert from "node:assert/strict";

// server.js imports grafanaClient.js, which reads env at import time and refuses
// to make calls unless configured. Set a deterministic config before importing so
// the tool handlers run and buildExploreUrl/buildDrilldownUrl are predictable.
process.env.GRAFANA_ENABLED = "true";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";
// Pin the Loki datasource uid so the proxy path is predictable in assertions.
process.env.GRAFANA_LOGS_DATASOURCE_UID = "grafanacloud-logs";

// server.js only starts the stdio transport when run as the entrypoint, so this
// import is side-effect-free apart from registering the tools. `tools` exposes the
// registered handler for each tool so we can drive the orchestration directly.
const { tools } = await import("./server.js");

// ---------------------------------------------------------------------------
// fetch stub: route Loki proxy calls by path and record the URLs seen.
// ---------------------------------------------------------------------------

// Install a fetch stub that answers each Loki endpoint from `routes` (keyed by a
// substring of the request path) and records every URL it saw. `routes` values
// are the JSON `data` array Loki would return under `{ status, data }`.
function withLokiStub(routes, fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    const u = String(url);
    let data = [];
    for (const [needle, value] of Object.entries(routes)) {
      if (u.includes(needle)) {
        data = typeof value === "function" ? value(u) : value;
        break;
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ status: "success", data })),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

// Invoke a registered tool handler and parse the JSON textResult back out.
async function callTool(name, args) {
  const res = await tools[name](args, {});
  return JSON.parse(res.content[0].text);
}

// Loki /series returns one object per stream (full label set); the tool only
// reads namespace + service_name.
function stream(namespace, service_name, extra = {}) {
  return { namespace, service_name, ...extra };
}

const SERIES = "loki/api/v1/series";
const NS_VALUES = "label/namespace/values";
const SVC_VALUES = "label/service_name/values";

// ---------------------------------------------------------------------------
// grafana_logs_link: namespace-resolved customer (drilldown, per-namespace links)
// ---------------------------------------------------------------------------

test("grafana_logs_link: resolves customer namespaces and groups drilldown links per namespace", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod", "april-rec", "other-prod"],
      [SERIES]: [
        stream("april-prod", "graviteeio-apim-april-prod-gateway", { pod: "a" }),
        stream("april-prod", "graviteeio-apim-april-prod-gateway", { pod: "b" }),
        stream("april-rec", "graviteeio-apim-april-rec-gateway"),
      ],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april", component: "gateway" });

      // Resolved to the customer's own namespaces (env-agnostic core "april").
      assert.deepEqual(out.resolved_namespaces, ["april-prod", "april-rec"]);
      assert.equal(out.link_style, "drilldown");
      // matched_streams is the raw label sets (namespace + service_name only).
      assert.equal(out.matched_count, 3);
      // One drilldown link per namespace, scoped to that namespace's exact
      // service_name values (deduped).
      assert.equal(out.links.length, 2);
      const april = out.links.find((l) => l.namespace === "april-prod");
      assert.deepEqual(april.service_names, ["graviteeio-apim-april-prod-gateway"]);
      assert.ok(april.url.includes("/explore/namespace/april-prod/logs"));
      // No line_filter -> no explore_url fallback attached.
      assert.equal(april.explore_url, undefined);
    },
  );
});

test("grafana_logs_link: line_filter attaches an explore_url fallback per drilldown link", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["ghd-prod"],
      [SERIES]: [stream("ghd-prod", "graviteeio-apim3-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", {
        client: "ghd",
        component: "gateway",
        line_filter: "Connection refused",
      });
      const link = out.links[0];
      assert.ok(link.explore_url, "explore_url must be attached when line_filter is set");
      // The explore fallback carries the exact-selector LogQL with the |= filter.
      const panes = JSON.parse(decodeURIComponent(new URL(link.explore_url).searchParams.get("panes")));
      assert.ok(panes.logs.queries[0].expr.includes("Connection refused"));
      assert.ok(panes.logs.queries[0].expr.includes('service_name="graviteeio-apim3-gateway"'));
      // The reported query also carries the line filter (discovery query omits it).
      assert.ok(out.query.includes("Connection refused"));
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: env auto-retry
// ---------------------------------------------------------------------------

test("grafana_logs_link: drops the env token and retries when the env-narrowed query is empty", async () => {
  // Customer 'blueyonder' resolves to namespace 'blueyonder-plt-live'. The env
  // 'prod' isn't in service_name (prod lives as 'plt-live'), so the first
  // /series (env-narrowed) returns nothing; dropping 'prod' finds streams.
  let seriesCall = 0;
  await withLokiStub(
    {
      [NS_VALUES]: ["blueyonder-plt-live"],
      [SERIES]: () => {
        seriesCall += 1;
        // First discovery (with the env token) is empty; the retry (env dropped)
        // returns streams.
        return seriesCall === 1 ? [] : [stream("blueyonder-plt-live", "by-live-gateway")];
      },
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "blueyonder prod", component: "gateway" });
      assert.equal(seriesCall, 2, "should have retried /series once");
      assert.equal(out.env_filter_dropped, true);
      assert.equal(out.matched_count, 1);
      assert.deepEqual(out.resolved_namespaces, ["blueyonder-plt-live"]);
    },
  );
});

test("grafana_logs_link: no retry when the first env-narrowed query already matched", async () => {
  let seriesCall = 0;
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod"],
      [SERIES]: () => {
        seriesCall += 1;
        return [stream("april-prod", "graviteeio-apim-april-prod-gateway")];
      },
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april prod", component: "gateway" });
      assert.equal(seriesCall, 1, "must not retry when the first query matched");
      assert.equal(out.env_filter_dropped, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: empty-result branches (note / suggestions)
// ---------------------------------------------------------------------------

test("grafana_logs_link: namespace resolved but empty range -> note, no suggestions", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod", "april-rec"],
      [SERIES]: [],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april" });
      assert.equal(out.matched_count, 0);
      assert.deepEqual(out.resolved_namespaces, ["april-prod", "april-rec"]);
      // Customer identified via namespace -> tell them it's a quiet range, and do
      // NOT offer service_name suggestions (the client wasn't the problem).
      assert.match(out.note, /No log streams in this range for namespace\(s\) april-prod, april-rec/);
      assert.equal(out.suggestions, undefined);
    },
  );
});

test("grafana_logs_link: no namespace + no streams -> suggestions from service_name values", async () => {
  await withLokiStub(
    {
      // 'aprl' resolves to no namespace...
      [NS_VALUES]: ["april-prod", "other-prod"],
      [SERIES]: [],
      // ...and no streams, so suggestClients pulls service_name values to rank.
      [SVC_VALUES]: ["graviteeio-ae-april-rec-engine", "graviteeio-ae-alliander-ui"],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "aprl" });
      assert.equal(out.matched_count, 0);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.match(out.note, /Did you mean/);
      // The close typo 'aprl' -> the 'april' service_name surfaces.
      assert.ok(out.suggestions.includes("graviteeio-ae-april-rec-engine"));
    },
  );
});

test("grafana_logs_link: no namespace, no streams, no suggestions -> generic note", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["other-prod"],
      [SERIES]: [],
      [SVC_VALUES]: ["totally-unrelated-service"],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "zzxqq" });
      assert.equal(out.matched_count, 0);
      assert.equal(out.suggestions, undefined);
      assert.match(out.note, /Try widening from\/to or adjusting client\/component/);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: explore link style
// ---------------------------------------------------------------------------

test("grafana_logs_link: link_style=explore returns a single raw Explore deep link", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod"],
      [SERIES]: [stream("april-prod", "graviteeio-apim-april-prod-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "april", link_style: "explore" });
      assert.equal(out.link_style, "explore");
      assert.equal(out.links.length, 1);
      assert.ok(out.links[0].url.includes("/explore?"));
      // Explore links carry no per-namespace grouping.
      assert.equal(out.links[0].namespace, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: /series discovery is called without a line filter
// ---------------------------------------------------------------------------

test("grafana_logs_link: /series discovery selector omits the line filter", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod"],
      [SERIES]: [stream("april-prod", "graviteeio-apim-april-prod-gateway")],
    },
    async (calls) => {
      await callTool("grafana_logs_link", { client: "april", line_filter: "boom" });
      const seriesCall = calls.find((u) => u.includes(SERIES));
      const match = new URL(seriesCall).searchParams.get("match[]");
      // The discovery selector must not carry the |= line filter (that's applied
      // in the generated link, not in /series).
      assert.ok(!match.includes("boom"), "discovery selector must omit the line filter");
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_query digest vs raw
// ---------------------------------------------------------------------------

test("grafana_query: returns the per-series digest by default and raw frames with raw=true", async () => {
  const payload = {
    results: {
      A: {
        status: 200,
        frames: [
          {
            schema: { fields: [{ type: "time" }, { type: "number", labels: { job: "api" } }] },
            data: { values: [[0, 1, 2], [2, 4, 6]] },
          },
        ],
      },
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      headers: { get: () => null },
    });
  try {
    const digest = await callTool("grafana_query", { datasource_uid: "ds", expr: "up" });
    assert.equal(digest.results.A.series_count, 1);
    assert.deepEqual(digest.results.A.series[0], {
      labels: { job: "api" },
      count: 3,
      first: 2,
      last: 6,
      min: 2,
      max: 6,
      avg: 4,
    });

    const raw = await callTool("grafana_query", { datasource_uid: "ds", expr: "up", raw: true });
    // raw=true returns the untouched frames payload.
    assert.deepEqual(raw, payload);
  } finally {
    globalThis.fetch = origFetch;
  }
});
