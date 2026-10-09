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

test("grafana_logs_link: a pinned namespace does not repeat the environment against service_name", async () => {
  // Customers call production `plt-live` or `multitenant`, so a service_name
  // filter of ".*prod.*" matched nothing and the tool retried without it. The
  // namespace list already expresses the environment, so there is nothing to
  // repeat and nothing to retry.
  await withLokiStub(
    { [NS_VALUES]: ["orbit-plt-live"], [SERIES]: [stream("orbit-plt-live", "by-live-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "orbit prod", component: "gateway" });
      assert.deepEqual(out.resolved_namespaces, ["orbit-plt-live"]);
      assert.ok(!/prod/.test(out.query), out.query);
      assert.equal(calls.filter((u) => u.includes(SERIES)).length, 1, "no retry should be needed");
      assert.equal(out.env_filter_dropped, undefined);
      // The word the namespaces could not account for is still reported.
      assert.equal(out.namespace_match_ignored, "prod");
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
  globalThis.fetch = (url) => {
    // assertReadOnly resuelve primero el type del uid; respondemos esa llamada con
    // un type read-only (pasa el guardián) y la de /ds/query con los frames.
    const body = String(url).includes("/datasources/uid/")
      ? { uid: "ds", name: "test prometheus", type: "prometheus" }
      : payload;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    });
  };

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


// ---------------------------------------------------------------------------
// Viewer-scoped token: /api/datasources is Admin-only, everything must degrade
// ---------------------------------------------------------------------------

// Grafana's built-in Viewer role can QUERY a datasource but cannot read its
// configuration, so /api/datasources and /api/datasources/uid/:uid return 403.
// We have no Viewer token to test with, so simulate one: refuse exactly those
// two endpoints and serve /api/frontend/settings, which any authenticated user
// can read. `privileged: true` restores an Admin-scoped token.
function withTokenStub({ privileged, settings, onQuery }, fn) {
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, init) => {
    const u = String(url);
    seen.push(u);
    const reply = (body, status = 200) =>
      Promise.resolve({
        ok: status < 400,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: { get: () => null },
      });

    if (u.includes("/api/frontend/settings")) return reply(settings);
    if (u.includes("/api/datasources")) {
      if (!privileged) return reply({ message: "Forbidden" }, 403);
      return reply(
        u.includes("/datasources/uid/")
          ? { uid: "grafanacloud-logs", name: "gravitee-logs", type: "loki" }
          : [{ uid: "grafanacloud-logs", name: "gravitee-logs", type: "loki", isDefault: true }],
      );
    }
    if (u.includes("/ds/query")) return reply(onQuery ?? { results: {} }, 200);
    return reply({}, 404);
  };
  return Promise.resolve(fn(seen)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

// Shape mirrors the live instance: real entries carry uid/name/type; the UI
// pseudo-datasources carry neither and must be skipped.
const SETTINGS = {
  defaultDatasource: "gravitee-prom",
  datasources: {
    "gravitee-logs": { uid: "grafanacloud-logs", name: "gravitee-logs", type: "loki" },
    "gravitee-prom": { uid: "grafanacloud-prom", name: "gravitee-prom", type: "prometheus" },
    // Action-capable: k6 can trigger load test runs, so it must never be queryable.
    "grafanacloud-k6": { uid: "k6-uid", name: "grafanacloud-k6", type: "k6-datasource" },
    "-- Mixed --": { type: "datasource" },
    "-- Dashboard --": { type: "datasource" },
  },
};

test("grafana_health: stays healthy on a Viewer token and reports the missing permission", async () => {
  // Regression: health used to probe via /api/datasources, so a correctly
  // Viewer-scoped token made the adapter report itself unhealthy — failing on
  // privilege rather than reachability, and contradicting its own advice to run
  // as a Viewer.
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    const out = await callTool("grafana_health", {});
    assert.equal(out.status, "ok");
    assert.equal(out.reachable, true);
    assert.equal(out.datasources_readable, false);
    assert.match(out.note, /Viewer/);
    // Counted from the catalogue, skipping the uid-less pseudo-datasources.
    assert.equal(out.datasource_count, 3);
  });
});

test("grafana_health: reports the permission as present on a privileged token", async () => {
  await withTokenStub({ privileged: true, settings: SETTINGS }, async () => {
    const out = await callTool("grafana_health", {});
    assert.equal(out.datasources_readable, true);
    assert.equal(out.note, undefined);
    assert.equal(out.datasource_count, 1);
  });
});

test("grafana_list_datasources: falls back to the catalogue and says so", async () => {
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    const out = await callTool("grafana_list_datasources", {});
    assert.equal(out.source, "frontend_settings");
    assert.match(out.note, /Viewer-scoped token/);
    assert.equal(out.count, 3);
    const byUid = Object.fromEntries(out.datasources.map((d) => [d.uid, d]));
    assert.equal(byUid["grafanacloud-logs"].type, "loki");
    // is_default resolves against defaultDatasource, which is keyed by NAME.
    assert.equal(byUid["grafanacloud-prom"].is_default, true);
    assert.equal(byUid["grafanacloud-logs"].is_default, false);
  });
});

test("grafana_query: the read-only guard still passes when datasource config is forbidden", async () => {
  // The guard resolves the datasource TYPE. Reading it from /api/datasources
  // needs Admin, so on a Viewer token the guard used to fail and take
  // grafana_query down with it — a far worse failure than health reporting 403.
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(2)] } } };
  await withTokenStub({ privileged: false, settings: SETTINGS, onQuery: payload }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "grafanacloud-logs", expr: '{a="b"}' });
    assert.equal(out.results.A.line_count, 2);
  });
});

test("grafana_query: the fallback still refuses a datasource outside the allowlist", async () => {
  // Degrading the permission requirement must not degrade the safety property:
  // k6 resolved via the fallback is still refused.
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "k6-uid", expr: "x" }, {}),
      /not in the read-only allowlist/,
    );
  });
});

test("grafana_query: fails closed when neither source can identify the datasource", async () => {
  await withTokenStub({ privileged: false, settings: SETTINGS }, async () => {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "does-not-exist", expr: "x" }, {}),
      /could not be verified read-only/,
    );
  });
});

test("grafana_query: fails closed when the catalogue itself is unreachable", async () => {
  // Uses a uid no catalogue has, so the lookup cannot be answered from cache and
  // must go to the network — which is refused. Both sources failing must reject.
  const origFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve("{}"), headers: { get: () => null } });
  try {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "uid-in-no-catalogue", expr: "x" }, {}),
      /could not be verified read-only.*fallback failed/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafana_query: a cached datasource type survives a transient permission failure", async () => {
  // Deliberate: once the type is known, a Viewer-token 403 on the privileged
  // endpoint should not take querying down. The cache is TTL-bounded so this
  // resilience cannot mask a lasting configuration change.
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(1)] } } };
  await withTokenStub({ privileged: false, settings: SETTINGS, onQuery: payload }, async () => {
    await callTool("grafana_query", { datasource_uid: "grafanacloud-logs", expr: "x" });
  });
  // Catalogue now warm; refuse every network call and query again.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) =>
    Promise.resolve(
      String(url).includes("/ds/query")
        ? { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(payload)), headers: { get: () => null } }
        : { ok: false, status: 403, text: () => Promise.resolve("{}"), headers: { get: () => null } },
    );
  try {
    const out = await callTool("grafana_query", { datasource_uid: "grafanacloud-logs", expr: "x" });
    assert.equal(out.results.A.line_count, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// grafana_query: log-line cap (maxLines) and truncation signalling
// ---------------------------------------------------------------------------

// Stub that answers assertReadOnly with a loki datasource and /ds/query with
// `payload`, recording the JSON body of every /ds/query request so we can assert
// on what was actually sent to Grafana.
function withDsQueryStub(payload, fn) {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    const body = isQuery ? payload : { uid: "ds", name: "loki", type: "loki" };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(bodies)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

// Minimal Loki log frame (see helpers.test.js for the full field list).
function serverLogFrame(count) {
  const rows = Array.from({ length: count }, (_, i) => i);
  return {
    schema: {
      meta: { custom: { frameType: "LabeledTimeValues" } },
      fields: [
        { name: "labels", type: "other" },
        { name: "Time", type: "time" },
        { name: "Line", type: "string" },
      ],
    },
    data: {
      values: [
        rows.map(() => ({ namespace: "ns" })),
        rows.map((i) => 1700000000000 + i),
        rows.map((i) => `line ${i}`),
      ],
    },
  };
}

test("grafana_query: sends maxLines so the log-line cap is explicit, not Grafana's hidden default", async () => {
  // maxDataPoints only sets METRIC resolution — Grafana's Loki backend ignores
  // it for log queries and caps them with maxLines (defaulting to 100 when
  // nothing sets it). Without maxLines the cap is invisible and uncontrollable.
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(2)] } } };
  await withDsQueryStub(payload, async (bodies) => {
    await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}', max_lines: 250 });
    assert.equal(bodies[0].queries[0].maxLines, 250);

    await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}' });
    assert.equal(bodies[1].queries[0].maxLines, 100);
  });
});

test("grafana_query: digests a log query by line count instead of reporting no series", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(3)] } } };
  await withDsQueryStub(payload, async () => {
    const digest = await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}' });
    assert.equal(digest.results.A.frame_type, "logs");
    assert.equal(digest.results.A.line_count, 3);
  });
});

test("grafana_query: flags a log result that hit the line cap as partial", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(5)] } } };
  await withDsQueryStub(payload, async () => {
    const digest = await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="ns"}', max_lines: 5 });
    assert.equal(digest.results.A.limit_reached, true);
  });
});

test("grafana_query: raw=true still flags the line cap rather than returning a silent partial page", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(5)] } } };
  await withDsQueryStub(payload, async () => {
    const raw = await callTool("grafana_query", {
      datasource_uid: "ds",
      expr: '{namespace="ns"}',
      max_lines: 5,
      raw: true,
    });
    assert.equal(raw.results.A.limit_reached, true);
    assert.match(raw.results.A.note, /max_lines/);
    // The frames themselves stay verbatim — only a note is added.
    assert.equal(raw.results.A.frames[0].data.values[2].length, 5);
  });
});

test("grafana_query: raw=true adds no note when the result is under the cap", async () => {
  const payload = { results: { A: { status: 200, frames: [serverLogFrame(2)] } } };
  await withDsQueryStub(payload, async () => {
    const raw = await callTool("grafana_query", {
      datasource_uid: "ds",
      expr: '{namespace="ns"}',
      max_lines: 100,
      raw: true,
    });
    assert.equal(raw.results.A.limit_reached, undefined);
    assert.equal(raw.results.A.note, undefined);
  });
});

// ---------------------------------------------------------------------------
// grafana_query: native `query` for non-Prometheus/Loki datasource types
// ---------------------------------------------------------------------------

test("grafana_query: forwards native query fields for types that do not use expr", async () => {
  // Verified against the live instance: Elasticsearch rejects `expr` with HTTP
  // 400 and Tempo with 500. Allowlisting a type without this would produce a
  // datasource that is permitted but unusable.
  const payload = { results: { A: { status: 200, frames: [] } } };
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify(isQuery ? payload : { uid: "es", name: "es", type: "elasticsearch" })),
      headers: { get: () => null },
    });
  };
  try {
    await callTool("grafana_query", {
      datasource_uid: "es",
      query: { query: "*", timeField: "@timestamp", metrics: [{ id: "1", type: "count" }] },
    });
    const q = bodies[0].queries[0];
    assert.equal(q.query, "*");
    assert.equal(q.timeField, "@timestamp");
    assert.deepEqual(q.metrics, [{ id: "1", type: "count" }]);
    // expr must be absent, not undefined-but-present.
    assert.ok(!("expr" in q), "expr must not be sent when it was not supplied");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafana_query: a caller-supplied query cannot redirect to another datasource", async () => {
  // Security: assertReadOnly verifies datasource_uid. If a field inside `query`
  // could replace the datasource, the guard would be verifying one datasource
  // while Grafana queried another - including a blocked, action-capable one.
  const payload = { results: { A: { status: 200, frames: [] } } };
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(JSON.stringify(isQuery ? payload : { uid: "es", name: "es", type: "elasticsearch" })),
      headers: { get: () => null },
    });
  };
  try {
    await callTool("grafana_query", {
      datasource_uid: "es",
      query: { query: "*", refId: "Z", datasource: { uid: "k6-datasource", type: "k6-datasource" } },
    });
    const q = bodies[0].queries[0];
    assert.deepEqual(q.datasource, { uid: "es", type: "elasticsearch" }, "datasource must stay pinned to the verified uid");
    assert.equal(q.refId, "A");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("grafana_query: requires either expr or query", async () => {
  await assert.rejects(
    () => tools.grafana_query({ datasource_uid: "ds" }, {}),
    /either expr .* or query .* is required/,
  );
});

// ---------------------------------------------------------------------------
// CloudWatch: allowed for metrics, refused for billable Logs Insights
// ---------------------------------------------------------------------------

function withCloudwatchStub(fn) {
  const origFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (url, init) => {
    const isQuery = String(url).includes("/ds/query");
    if (isQuery) bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify(isQuery ? { results: { A: { status: 200, frames: [] } } } : { uid: "cw", name: "cw", type: "cloudwatch" }),
        ),
      headers: { get: () => null },
    });
  };
  return Promise.resolve(fn(bodies)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

test("grafana_query: every CloudWatch result carries a billable warning", async () => {
  // The guard blocks the UNBOUNDED cost, but CloudWatch is never free: AWS meters
  // GetMetricData per request. A caller used to free Loki/Prometheus reads must
  // not have to know that, so the result says it.
  await withCloudwatchStub(async () => {
    const digest = await callTool("grafana_query", {
      datasource_uid: "cw",
      query: { queryMode: "Metrics", namespace: "AWS/S3" },
    });
    assert.match(digest.billing_notice, /BILLABLE/);
    assert.match(digest.billing_notice, /not free/);
    assert.ok(digest.results, "the notice must not displace the results");
  });

  // ...on the raw path too, which returns Grafana's payload almost verbatim.
  await withCloudwatchStub(async () => {
    const raw = await callTool("grafana_query", {
      datasource_uid: "cw",
      query: { queryMode: "Metrics", namespace: "AWS/S3" },
      raw: true,
    });
    assert.match(raw.billing_notice, /BILLABLE/);
  });
});

test("grafana_query: non-CloudWatch results carry no billing notice", async () => {
  // The warning must mean something — attaching it to free datasources would
  // train the reader to ignore it.
  const payload = { results: { A: { status: 200, frames: [] } } };
  await withDsQueryStub(payload, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: '{a="b"}' });
    assert.equal(out.billing_notice, undefined);
  });
});

test("grafana_query: CloudWatch metrics queries are allowed", async () => {
  await withCloudwatchStub(async (bodies) => {
    await callTool("grafana_query", {
      datasource_uid: "cw",
      query: { queryMode: "Metrics", region: "eu-west-1", namespace: "AWS/S3", metricName: "BucketSizeBytes", statistic: "Average" },
    });
    assert.equal(bodies[0].queries[0].metricName, "BucketSizeBytes");
  });
  // queryMode omitted defaults to Metrics and is likewise allowed.
  await withCloudwatchStub(async (bodies) => {
    await callTool("grafana_query", { datasource_uid: "cw", query: { region: "eu-west-1", namespace: "AWS/S3" } });
    assert.equal(bodies.length, 1);
  });
});

test("grafana_query: CloudWatch Logs Insights is refused before any request is sent", async () => {
  // Logs Insights bills per GB SCANNED — an unbounded cost a single query can run
  // up. The refusal must happen before the request leaves, not after.
  for (const bad of [
    { queryMode: "Logs", expression: "fields @message" },
    { queryMode: "Metrics", logGroups: ["/aws/lambda/x"] },
    { queryMode: "Metrics", logGroupNames: ["/aws/lambda/x"] },
    { queryMode: "Metrics", subtype: "StartQuery" },
    { queryMode: "Metrics", queryLanguage: "CWLI" },
  ]) {
    await withCloudwatchStub(async (bodies) => {
      await assert.rejects(
        () => tools.grafana_query({ datasource_uid: "cw", query: bad }, {}),
        /refused/,
        `should refuse ${JSON.stringify(bad)}`,
      );
      assert.equal(bodies.length, 0, "no /ds/query request may be sent for a refused CloudWatch query");
    });
  }
});

test("grafana_query: the CloudWatch guard applies only to CloudWatch", async () => {
  // A loki query carrying an unrelated field named logGroups must not be refused.
  const payload = { results: { A: { status: 200, frames: [] } } };
  await withDsQueryStub(payload, async (bodies) => {
    await callTool("grafana_query", { datasource_uid: "ds", expr: '{a="b"}' });
    assert.equal(bodies.length, 1);
  });
});

// ---------------------------------------------------------------------------
// grafana_query read-only guard (comentario #1 de gutek): solo types allowlisted
// ---------------------------------------------------------------------------

test("grafana_query: rejects a datasource whose type is not in the read-only allowlist", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    // El uid resuelve a un type que SÍ escribe; el guardián debe denegar antes de consultar.
    const body = String(url).includes("/datasources/uid/")
      ? { uid: "am", name: "Alertmanager", type: "alertmanager" }
      : { results: {} };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: { get: () => null },
    });
  };
  try {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "am", expr: "up" }, {}),
      /not in the read-only allowlist/,
    );
    // Clave: corta ANTES de hacer POST a /ds/query.
    assert.ok(!calls.some((u) => u.includes("/ds/query")), "must not query a non-read-only datasource");
  } finally {
    globalThis.fetch = origFetch;
  }
});


test("grafana_query: fails closed when the datasource cannot be resolved", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(String(url));
    // La resolución del uid falla (uid desconocido -> 403). Se deniega igualmente.
    return Promise.resolve({
      ok: false,
      status: 403,
      text: () => Promise.resolve(""),
      headers: { get: () => null },
    });
  };
  try {
    await assert.rejects(
      () => tools.grafana_query({ datasource_uid: "nope", expr: "up" }, {}),
      /could not be verified read-only/,
    );
    assert.ok(!calls.some((u) => u.includes("/ds/query")), "must not query when the type is unknown");
  } finally {
    globalThis.fetch = origFetch;
  }
});


// ---------------------------------------------------------------------------
// grafana_http_requests: the data no namespace-scoped tool can reach
// ---------------------------------------------------------------------------

// Route /series by what is being asked for: "which cluster holds these
// namespaces" and "what else runs on this cluster" are the same endpoint with
// different matchers.
function seriesRouter({ namespaceToCluster = {}, clusterNamespaces = {} }) {
  return (url) => {
    const u = decodeURIComponent(String(url));
    const byCluster = /match\[\]=\{cluster/.test(u);
    if (byCluster) {
      const cluster = /cluster=`([^`]+)`/.exec(u)?.[1];
      return (clusterNamespaces[cluster] || []).map((namespace) => ({ namespace, cluster }));
    }
    return Object.entries(namespaceToCluster).map(([namespace, cluster]) => ({ namespace, cluster }));
  };
}

test("grafana_http_requests: a dedicated cluster is queried whole, with no upstream filter", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "acme-uat"],
      [SERIES]: seriesRouter({
        namespaceToCluster: { "acme-prod": "gravitee-acme-aks-cluster", "acme-uat": "gravitee-acme-aks-cluster" },
        // Only this customer's namespaces, plus infrastructure that runs on
        // every cluster and says nothing about tenancy.
        clusterNamespaces: {
          "gravitee-acme-aks-cluster": ["acme-prod", "acme-uat", "ingress-nginx", "kube-system"],
        },
      }),
    },
    async () => {
      const out = await callTool("grafana_http_requests", { client: "acme", from: "now-1h" });
      assert.equal(out.cluster, "gravitee-acme-aks-cluster");
      assert.equal(out.scope.single_tenant_cluster, true);
      assert.equal(out.scope.tenancy, "dedicated");
      // Nothing to narrow to: the cluster's ingress stream IS this customer's
      // request log, including requests rejected before an upstream was chosen.
      assert.ok(!out.queries.counts.includes("upstream =~"), out.queries.counts);
      // Both ingress controllers by default: bridge traffic never touches ingress-nginx.
      assert.ok(out.queries.counts.includes("flow/ingress-nginx-ingress-nginx"), out.queries.counts);
      assert.ok(out.queries.counts.includes("flow/app-routing-system-"), out.queries.counts);
    },
  );
});

test("grafana_http_requests: a shared cluster is narrowed to the customer's upstreams", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod"],
      [SERIES]: seriesRouter({
        namespaceToCluster: { "acme-prod": "shared-core-us-prod" },
        clusterNamespaces: {
          "shared-core-us-prod": ["acme-prod", "orbit-prod", "beacon-prod", "ingress-nginx"],
        },
      }),
    },
    async () => {
      const out = await callTool("grafana_http_requests", { client: "acme", from: "now-1h" });
      assert.equal(out.scope.single_tenant_cluster, false);
      assert.equal(out.scope.tenancy, "shared");
      assert.equal(out.scope.other_tenants_on_cluster, 2);
      // The boundary that matters: a cluster-wide ingress query here would
      // return orbit's and beacon's requests under acme's name.
      assert.ok(out.queries.counts.includes("| upstream =~ `(acme-prod)-.*`"), out.queries.counts);
      // ...and the cost of that filter is stated rather than hidden.
      assert.match(out.scope.note, /before an upstream was chosen/);
    },
  );
});

test("grafana_http_requests: refuses to aggregate two clusters into one distribution", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "acme-apac"],
      [SERIES]: seriesRouter({
        namespaceToCluster: { "acme-prod": "gravitee-acme-aks-cluster", "acme-apac": "gravitee-acme-apac-aks-cluster" },
      }),
    },
    async () => {
      const out = await callTool("grafana_http_requests", { client: "acme", from: "now-1h" });
      assert.deepEqual(out.clusters, ["gravitee-acme-aks-cluster", "gravitee-acme-apac-aks-cluster"]);
      assert.match(out.note, /describe neither/);
      assert.equal(out.queries, undefined, "no query should have run");
    },
  );
});

test("grafana_http_requests: says so when the cluster cannot be resolved", async () => {
  await withLokiStub({ [NS_VALUES]: [], [SERIES]: [] }, async () => {
    const out = await callTool("grafana_http_requests", { client: "nosuchcustomer", from: "now-1h" });
    // Not an empty result set dressed as an answer.
    assert.match(out.note, /Could not resolve a cluster/);
  });
});

test("grafana_http_requests: requires a customer or a cluster", async () => {
  await assert.rejects(() => callTool("grafana_http_requests", { from: "now-1h" }), /client .* or cluster/);
});

// ---------------------------------------------------------------------------
// grafana_find_customer: the cluster label, and what it unlocks
// ---------------------------------------------------------------------------

test("grafana_find_customer: returns the cluster and points at the ingress job", async () => {
  // The gap this closes: every other tool takes `client` and scopes to these
  // namespaces, which hold application logs only. Without the cluster there is
  // no route at all from a customer name to their HTTP request logs.
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "acme-uat"],
      [SERIES]: seriesRouter({
        namespaceToCluster: { "acme-prod": "gravitee-acme-aks-cluster", "acme-uat": "gravitee-acme-aks-cluster" },
      }),
    },
    async () => {
      const out = await callTool("grafana_find_customer", { query: "acme" });
      assert.deepEqual(out.hosted_namespaces, ["acme-prod", "acme-uat"]);
      assert.deepEqual(out.hosted_clusters, ["gravitee-acme-aks-cluster"]);
      assert.deepEqual(out.clusters, ["gravitee-acme-aks-cluster"]);
      assert.match(out.http_request_logs_note, /flow\/ingress-nginx-ingress-nginx/);
      assert.match(out.http_request_logs_note, /grafana_http_requests/);
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_http_requests: failures, retries, both ingresses, explicit scope
// ---------------------------------------------------------------------------

function jsonResponse(data, { status = 200 } = {}) {
  const body = typeof data === "string" ? data : JSON.stringify({ status: "success", data });
  return Promise.resolve({
    ok: status < 400,
    status,
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  });
}

// A fetch stub that answers namespace values, /series and Loki instant queries
// separately. `instant(query)` returns { result } or { status, body } to fail.
async function withIngressStub({ nsValues, series, instant = () => ({ result: [] }) }, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes(NS_VALUES)) return jsonResponse(nsValues);
    if (u.includes(SERIES)) return jsonResponse(series(u));
    if (u.includes("loki/api/v1/query_range")) return jsonResponse({ resultType: "matrix", result: [] });
    if (u.includes("loki/api/v1/query")) {
      const query = new URL(u).searchParams.get("query");
      const r = instant(query, new URL(u).searchParams);
      if (r.status) return jsonResponse(r.body, { status: r.status });
      return jsonResponse({ resultType: "vector", result: r.result });
    }
    return jsonResponse([]);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const DEDICATED = {
  nsValues: ["acme-prod"],
  series: seriesRouter({
    namespaceToCluster: { "acme-prod": "gravitee-acme-aks-cluster" },
    clusterNamespaces: { "gravitee-acme-aks-cluster": ["acme-prod", "ingress-nginx", "app-routing-system"] },
  }),
};
const LOKI_400 =
  "pipeline error: 'SampleExtractionErr' for series: '{__error__=\"SampleExtractionErr\", " +
  "__error_details__=\"strconv.ParseFloat: parsing \\\"0,\\\": invalid syntax\"}'";

test("grafana_http_requests: every unwrap is guarded, so a retried request cannot fail the query", async () => {
  await withIngressStub(DEDICATED, async () => {
    const out = await callTool("grafana_http_requests", { client: "acme", from: "now-6h" });
    for (const [part, q] of Object.entries(out.queries)) {
      for (const m of q.matchAll(/\| unwrap (\w+)/g)) {
        const guard = `| ${m[1]} =~ \`[0-9]+(?:\\.[0-9]+)?\` | unwrap ${m[1]}`;
        assert.ok(q.includes(guard), `${part}: unguarded unwrap of ${m[1]}`);
      }
    }
  });
});

test("grafana_http_requests: a failing refinement is reported, not allowed to take down the answer", async () => {
  await withIngressStub(
    {
      ...DEDICATED,
      instant: (q) => {
        if (q.includes("unwrap upstream_time")) return { status: 400, body: LOKI_400 };
        if (q.startsWith("sum by (job, status,")) {
          return {
            result: [
              { metric: { job: "flow/ingress-nginx-ingress-nginx", status: "200" }, value: [0, "90"] },
              { metric: { job: "flow/app-routing-system-", status: "499", __adaptive_logs_sampled__: "91.00" }, value: [0, "10"] },
            ],
          };
        }
        return { result: [] };
      },
    },
    async () => {
      const out = await callTool("grafana_http_requests", { client: "acme", from: "now-6h" });
      assert.equal(out.total_requests, 100);
      // Two controllers, reported separately — never averaged together.
      assert.deepEqual(out.by_ingress.map((e) => e.ingress).sort(), ["app-routing", "nginx"]);
      assert.equal(out.adaptive_logs_sampling.sampled_share_pct, 10);
      const failure = out.partial_failures.find((f) => f.part === "upstream_latency_p95");
      // The reason Loki gave, and the query it gave it for.
      assert.match(failure.error, /SampleExtractionErr/);
      assert.match(failure.query, /unwrap upstream_time/);
    },
  );
});

test("grafana_http_requests: a failing count names the query and Loki's reason", async () => {
  await withIngressStub(
    { ...DEDICATED, instant: (q) => (q.startsWith("sum by (job, status,") ? { status: 400, body: LOKI_400 } : { result: [] }) },
    async () => {
      await assert.rejects(
        () => callTool("grafana_http_requests", { client: "acme", from: "now-6h" }),
        (err) => {
          assert.match(err.message, /counts query failed/);
          assert.match(err.message, /HTTP 400: pipeline error/);
          assert.match(err.message, /LogQL: sum by \(job, status/);
          return true;
        },
      );
    },
  );
});

test("grafana_http_requests: failures are attributed per upstream pod, retries split pairwise", async () => {
  await withIngressStub(
    {
      ...DEDICATED,
      instant: (q) =>
        q.startsWith("sum by (job, upstream_addr")
          ? {
              result: [
                { metric: { job: "flow/ingress-nginx-ingress-nginx", upstream_addr: "10.0.1.12:8082", upstream_status: "200" }, value: [0, "50"] },
                {
                  metric: { job: "flow/ingress-nginx-ingress-nginx", upstream_addr: "10.0.1.11:8082, 10.0.1.12:8082", upstream_status: "502, 200" },
                  value: [0, "7"],
                },
              ],
            }
          : { result: [] },
    },
    async () => {
      const out = await callTool("grafana_http_requests", { client: "acme", from: "now-6h" });
      assert.equal(out.by_upstream[0].upstream_addr, "10.0.1.11:8082");
      assert.equal(out.by_upstream[0].failed_attempts, 7);
      assert.equal(out.by_upstream[1].failed_attempts, 0);
      // Without a metrics datasource the pods are not resolved — and it says how to fix that.
      assert.match(out.pod_resolution_note, /GRAFANA_METRICS_DATASOURCE_UID/);
    },
  );
});

test("grafana_http_requests: an explicit cluster running none of the customer's namespaces is refused", async () => {
  // The call that returned a clean, meaningless zero during an incident: the
  // customer's data planes were on one cluster, the query named another.
  await withIngressStub(
    {
      nsValues: ["acme-prod"],
      series: seriesRouter({
        namespaceToCluster: { "acme-prod": "shared-worker-us-east-prod" },
        clusterNamespaces: { "shared-worker-us-prod": ["orbit-prod", "ingress-nginx"] },
      }),
    },
    async (calls) => {
      const out = await callTool("grafana_http_requests", { client: "acme", cluster: "shared-worker-us-prod", from: "now-1h" });
      assert.match(out.note, /None of this customer's namespaces run on shared-worker-us-prod/);
      assert.deepEqual(out.customer_clusters, ["shared-worker-us-east-prod"]);
      assert.match(out.note, /control_plane_id/);
      assert.ok(!calls.some((u) => u.includes("loki/api/v1/query")), "no ingress query may run");
    },
  );
});

test("grafana_http_requests: control_plane_id brings in bridge traffic, and only when asked", async () => {
  const stub = {
    nsValues: ["acme-prod"],
    series: seriesRouter({
      namespaceToCluster: { "acme-prod": "shared-worker-us-east-prod", "apim-cp-cp1111": "shared-worker-us-prod" },
      clusterNamespaces: { "shared-worker-us-prod": ["apim-cp-cp1111", "apim-cp-cp2222", "app-routing-system"] },
    }),
  };
  await withIngressStub(stub, async () => {
    // Control plane and data planes on different clusters: refuse to blend them.
    const split = await callTool("grafana_http_requests", { client: "acme", control_plane_id: "cp1111", from: "now-1h" });
    assert.equal(split.clusters.length, 2);
    assert.match(split.note, /control plane \(bridge traffic\)/);

    const bridge = await callTool("grafana_http_requests", {
      client: "acme",
      control_plane_id: "cp1111",
      cluster: "shared-worker-us-prod",
      from: "now-1h",
    });
    assert.equal(bridge.scope.control_plane_namespace, "apim-cp-cp1111");
    assert.match(bridge.scope.control_plane_note, /shared by every customer/);
    // Narrowed to that control plane, not every tenant on the cluster.
    assert.ok(bridge.queries.counts.includes("| upstream =~ `(apim-cp-cp1111)-.*`"), bridge.queries.counts);
  });
});

test("grafana_logs_trend: a sampled stream is reported in the same read", async () => {
  await withIngressStub(
    { nsValues: ["acme-prod"], series: () => [] },
    async (calls) => {
      const orig = globalThis.fetch;
      globalThis.fetch = (url) => {
        const u = String(url);
        if (u.includes("loki/api/v1/query_range")) {
          calls.push(u);
          return jsonResponse({
            resultType: "matrix",
            result: [{ metric: { __adaptive_logs_sampled__: "95.00" }, values: [[Math.floor(Date.now() / 1000) - 60, "4"]] }],
          });
        }
        return orig(url);
      };
      try {
        const out = await callTool("grafana_logs_trend", { client: "acme", from: "now-1h", interval: "5m" });
        assert.match(out.query, /^sum by \(__adaptive_logs_sampled__\)/);
        assert.equal(out.adaptive_logs_sampling.sampled_share_pct, 100);
      } finally {
        globalThis.fetch = orig;
      }
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_query: step, timeline, Loki-only scope note, sampling on negatives
// ---------------------------------------------------------------------------

async function withQueryEndpointStub({ type, payload, lokiInstant, series }, fn) {
  const orig = globalThis.fetch;
  const bodies = [];
  const instantQueries = [];
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    let body = {};
    if (u.includes("/datasources/uid/")) body = { uid: "ds", name: `test ${type}`, type };
    else if (u.includes("/ds/query")) {
      bodies.push(JSON.parse(opts.body));
      body = payload;
    } else if (u.includes("loki/api/v1/series")) {
      body = { status: "success", data: series ? series(u) : [] };
    } else if (u.includes("loki/api/v1/query")) {
      const q = new URL(u).searchParams.get("query");
      instantQueries.push(q);
      body = { status: "success", data: { resultType: "vector", result: lokiInstant ? lokiInstant(q) : [] } };
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)), headers: { get: () => null } });
  };
  try {
    return await fn({ bodies, instantQueries });
  } finally {
    globalThis.fetch = orig;
  }
}

const SERIES_PAYLOAD = {
  results: {
    A: {
      status: 200,
      frames: [
        {
          schema: { meta: { type: "timeseries-multi" }, fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels: { status: "499" } }] },
          data: { values: [[0, 60_000, 120_000], [2, 4, 6]] },
        },
      ],
    },
  },
};

const EMPTY_LOG_PAYLOAD = {
  results: {
    A: {
      status: 200,
      frames: [
        {
          schema: {
            meta: {
              custom: { frameType: "LabeledTimeValues" },
              stats: [{ displayName: "Summary: total bytes processed", value: 123456 }],
            },
            fields: [{ name: "labels", type: "other" }, { name: "Time", type: "time" }, { name: "Line", type: "string" }],
          },
          data: { values: [[], [], []] },
        },
      ],
    },
  },
};

test("grafana_query: derives the metric step from max_data_points instead of evaluating every second", async () => {
  await withQueryEndpointStub({ type: "prometheus", payload: SERIES_PAYLOAD }, async ({ bodies }) => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: "up", from: "now-1h", to: "now", max_data_points: 60 });
    assert.equal(bodies[0].queries[0].intervalMs, 60_000);
    assert.equal(out.window.step_seconds, 60);
    await callTool("grafana_query", { datasource_uid: "ds", expr: "up", from: "now-1h", to: "now", step: "15m" });
    assert.equal(bodies[1].queries[0].intervalMs, 900_000);
  });
});

test("grafana_query: output=timeline returns the points", async () => {
  await withQueryEndpointStub({ type: "prometheus", payload: SERIES_PAYLOAD }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: "up", output: "timeline" });
    assert.deepEqual(out.results.A.series[0].points, [
      [new Date(0).toISOString(), 2],
      [new Date(60_000).toISOString(), 4],
      [new Date(120_000).toISOString(), 6],
    ]);
  });
});

test("grafana_query: the log scope note is not attached to a Prometheus query", async () => {
  // It told a kube_pod_info query it had searched "APPLICATION logs only".
  await withQueryEndpointStub({ type: "prometheus", payload: SERIES_PAYLOAD }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: 'kube_pod_info{namespace="acme-prod"}' });
    assert.equal(out.scope_note, undefined);
  });
});

test("grafana_query: an empty lookup on a sampled stream is not reported as a trustworthy negative", async () => {
  // A request-id lookup came back EMPTY_BUT_SCANNED when the line had most
  // likely been discarded by Adaptive Logs before it reached Loki.
  await withQueryEndpointStub(
    {
      type: "loki",
      payload: EMPTY_LOG_PAYLOAD,
      lokiInstant: () => [
        { metric: { __adaptive_logs_sampled__: "91.00" }, value: [0, "900"] },
        { metric: {}, value: [0, "100"] },
      ],
    },
    async ({ instantQueries }) => {
      const out = await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="acme-prod"} |= "0123456789abcdef"' });
      assert.equal(out.results.A.coverage, "EMPTY_BUT_SAMPLED");
      assert.match(out.results.A.coverage_warning, /NOT proof/);
      // The check reads the stream selector alone — the filter found nothing to read.
      assert.match(instantQueries[0], /count_over_time\(\{namespace="acme-prod"\} \[/);
    },
  );
});

test("grafana_query: an empty lookup on an unsampled stream stays a trustworthy negative", async () => {
  await withQueryEndpointStub(
    { type: "loki", payload: EMPTY_LOG_PAYLOAD, lokiInstant: () => [{ metric: {}, value: [0, "100"] }] },
    async () => {
      const out = await callTool("grafana_query", { datasource_uid: "ds", expr: '{namespace="acme-prod"} |= "nope"' });
      assert.equal(out.results.A.coverage, "EMPTY_BUT_SCANNED");
    },
  );
});

// ---------------------------------------------------------------------------
// compare_offset: the same window, earlier
// ---------------------------------------------------------------------------

async function withTrendStub(rangeFor, fn, { seriesExists = true } = {}) {
  const orig = globalThis.fetch;
  const starts = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes(NS_VALUES)) return jsonResponse(["acme-prod"]);
    if (u.includes(SERIES)) return jsonResponse(seriesExists ? [{ namespace: "acme-prod", service_name: "gw" }] : []);
    if (u.includes("loki/api/v1/query_range")) {
      const start = Number(BigInt(new URL(u).searchParams.get("start")) / 1000000000n);
      starts.push(start);
      return jsonResponse({ resultType: "matrix", result: rangeFor(start, starts.length) });
    }
    return jsonResponse([]);
  };
  try {
    return await fn(starts);
  } finally {
    globalThis.fetch = orig;
  }
}

test("grafana_logs_trend: compare_offset shows a chronic pattern as already present", async () => {
  // The analysis error: a pattern that had run for days, read as incident
  // impact because the baseline came from a quiet hour earlier the same day.
  await withTrendStub(
    (start, n) => [{ metric: {}, values: [[start + 7200, n === 1 ? "215" : "210"]] }],
    async (starts) => {
      const out = await callTool("grafana_logs_trend", { client: "acme", from: "now-6h", interval: "1h", compare_offset: "1d" });
      assert.equal(starts.length, 2);
      assert.equal(starts[0] - starts[1], 86400);
      assert.equal(out.comparison.total.change, "similar");
      assert.match(out.comparison.note, /already happening then/);
      assert.ok(out.buckets.some((b) => b.baseline === 210), JSON.stringify(out.buckets));
    },
  );
});

test("grafana_logs_trend: an empty baseline with no streams is no_baseline, not 'new'", async () => {
  await withTrendStub(
    (start, n) => (n === 1 ? [{ metric: {}, values: [[start + 7200, "40"]] }] : []),
    async () => {
      const out = await callTool("grafana_logs_trend", { client: "acme", from: "now-6h", interval: "1h", compare_offset: "7d" });
      assert.equal(out.comparison.total.change, "no_baseline");
      assert.match(out.comparison.note, /not evidence/);
    },
    { seriesExists: false },
  );
});

test("grafana_logs_trend: refuses an offset that would overlap the window", async () => {
  await withTrendStub(() => [], async () => {
    await assert.rejects(
      () => callTool("grafana_logs_trend", { client: "acme", from: "now-6h", compare_offset: "1h" }),
      /overlap/,
    );
  });
});

test("grafana_query: compare_offset runs the same query over the shifted window and labels each series", async () => {
  await withQueryEndpointStub({ type: "prometheus", payload: SERIES_PAYLOAD }, async ({ bodies }) => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: "up", from: "now-1h", to: "now", compare_offset: "1d" });
    assert.equal(bodies.length, 2);
    const [current, baseline] = bodies;
    // Same step, same window length, a day earlier.
    assert.equal(baseline.queries[0].intervalMs, current.queries[0].intervalMs);
    assert.equal(Number(baseline.to) - Number(baseline.from), 3_600_000);
    assert.ok(Math.abs(Date.now() - 86_400_000 - Number(baseline.to)) < 60_000, baseline.to);
    assert.equal(out.comparison.results.A.series[0].avg.change, "similar");
    assert.equal(out.comparison.baseline_available, true);
  });
});

test("grafana_query: compare_offset with raw=true is refused, not silently ignored", async () => {
  await withQueryEndpointStub({ type: "prometheus", payload: SERIES_PAYLOAD }, async () => {
    await assert.rejects(
      () => callTool("grafana_query", { datasource_uid: "ds", expr: "up", raw: true, compare_offset: "1d" }),
      /raw=true/,
    );
  });
});

test("grafana_http_requests: compare_offset labels each status against the same window earlier", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  await withIngressStub(
    {
      ...DEDICATED,
      instant: (q, params) => {
        if (!q.startsWith("sum by (job, status,")) return { result: [] };
        const t = Number(BigInt(params.get("time")) / 1000000000n);
        const isBaseline = t < nowS - 7200;
        return {
          result: [
            { metric: { job: "flow/ingress-nginx-ingress-nginx", status: "499" }, value: [0, isBaseline ? "2100" : "2150"] },
            ...(isBaseline ? [] : [{ metric: { job: "flow/ingress-nginx-ingress-nginx", status: "502" }, value: [0, "40"] }]),
          ],
        };
      },
    },
    async () => {
      const out = await callTool("grafana_http_requests", { client: "acme", from: "now-6h", compare_offset: "1d" });
      const rows = Object.fromEntries(out.by_ingress[0].by_status.map((r) => [r.status, r]));
      // The chronic 499s were already there; the 502s were not.
      assert.equal(rows["499"].change, "similar");
      assert.equal(rows["499"].baseline_count, 2100);
      assert.equal(rows["502"].change, "new");
      // Presence is answered separately from level.
      assert.equal(rows["499"].already_present, true);
      assert.equal(rows["502"].already_present, false);
      assert.equal(out.comparison.total.change, "similar");
    },
  );
});

test("grafana_http_requests: compare_offset in sample mode is refused", async () => {
  await withIngressStub(DEDICATED, async () => {
    await assert.rejects(
      () => callTool("grafana_http_requests", { client: "acme", mode: "sample", compare_offset: "1d" }),
      /mode='aggregate'/,
    );
  });
});

// ---------------------------------------------------------------------------
// grafana_first_occurrence, and trend bucket semantics
// ---------------------------------------------------------------------------

const ONSET_FROM = "2026-09-10T14:00:00Z";
const ONSET_TO = "2026-09-10T20:00:00Z";
const atS = (isoStr) => Date.parse(isoStr) / 1000;
const nsOf = (isoStr) => (BigInt(Date.parse(isoStr)) * 1000000n).toString();

async function withOnsetStub({ coarse = [], first = null, ramp = [], preWindow = 0 }, fn) {
  const orig = globalThis.fetch;
  const calls = { coarse: 0, narrow: [], ramp: 0, instant: [] };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes(NS_VALUES)) return jsonResponse(["acme-prod"]);
    if (u.includes(SERIES)) return jsonResponse([]);
    if (u.includes("loki/api/v1/query_range")) {
      const p = new URL(u).searchParams;
      if (p.get("direction") === "forward" && p.get("limit") === "1") {
        calls.narrow.push({
          start: Number(BigInt(p.get("start")) / 1000000000n),
          end: Number(BigInt(p.get("end")) / 1000000000n),
        });
        return jsonResponse({ resultType: "streams", result: first ? [{ stream: first.labels, values: [[first.ns, first.line]] }] : [] });
      }
      if (p.get("step") === "60") {
        calls.ramp++;
        return jsonResponse({ resultType: "matrix", result: ramp.length ? [{ metric: {}, values: ramp }] : [] });
      }
      calls.coarse++;
      return jsonResponse({ resultType: "matrix", result: coarse.length ? [{ metric: {}, values: coarse }] : [] });
    }
    if (u.includes("loki/api/v1/query")) {
      calls.instant.push(new URL(u).searchParams.get("query"));
      return jsonResponse({ resultType: "vector", result: preWindow ? [{ metric: {}, value: [0, String(preWindow)] }] : [] });
    }
    return jsonResponse([]);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const FIRST_LINE = {
  ns: nsOf("2026-09-10T17:13:33.676Z"),
  line: "java.lang.OutOfMemoryError: Java heap space",
  labels: { namespace: "acme-prod", pod: "gw-a" },
};

test("grafana_first_occurrence: the exact first line inside the onset bucket, not the bucket's end", async () => {
  await withOnsetStub(
    {
      // Loki stamps a 15m count at the END of its interval: 17:15 holds (17:00, 17:15].
      coarse: [[atS("2026-09-10T17:15:00Z"), "1"], [atS("2026-09-10T18:00:00Z"), "4"]],
      first: FIRST_LINE,
      ramp: [[atS("2026-09-10T17:14:00Z"), "1"], [atS("2026-09-10T17:16:00Z"), "3"]],
    },
    async (calls) => {
      const out = await callTool("grafana_first_occurrence", { client: "acme", line_filter: "OutOfMemoryError", from: ONSET_FROM, to: ONSET_TO });
      assert.equal(out.first_occurrence.time, "2026-09-10T17:13:33.676Z");
      assert.equal(out.first_occurrence.ns, FIRST_LINE.ns);
      assert.equal(out.search.onset_bucket, "2026-09-10T17:00:00.000Z");
      // The narrow search spans the whole onset interval.
      const n = calls.narrow[0];
      assert.ok(n.start <= atS("2026-09-10T17:00:00Z") && n.end >= atS("2026-09-10T17:15:00Z"), JSON.stringify(n));
      const byTime = Object.fromEntries(out.ramp.buckets.map((b) => [b.time, b.count]));
      assert.equal(byTime["2026-09-10T17:13:00.000Z"], 1);
      assert.equal(byTime["2026-09-10T17:12:00.000Z"], 0);
      assert.equal(out.already_present_before_window, false);
      assert.match(out.note, /First occurrence: 2026-09-10T17:13:33.676Z/);
      assert.match(out.first_occurrence.next_step, /grafana_logs_context/);
    },
  );
});

test("grafana_first_occurrence: a pattern already running before the window is not called an onset", async () => {
  await withOnsetStub(
    {
      coarse: [[atS("2026-09-10T14:15:00Z"), "9"]],
      first: { ...FIRST_LINE, ns: nsOf("2026-09-10T14:00:02.000Z") },
      preWindow: 42,
    },
    async () => {
      const out = await callTool("grafana_first_occurrence", { client: "acme", line_filter: "OutOfMemoryError", from: ONSET_FROM, to: ONSET_TO });
      assert.equal(out.already_present_before_window, true);
      assert.equal(out.before_window.lines, 42);
      assert.match(out.note, /Not an onset/);
    },
  );
});

test("grafana_first_occurrence: no matching lines is said plainly, and nothing is narrowed", async () => {
  await withOnsetStub({}, async (calls) => {
    const out = await callTool("grafana_first_occurrence", { client: "acme", line_filter: "never-logged", from: ONSET_FROM, to: ONSET_TO });
    assert.equal(out.first_occurrence, null);
    assert.match(out.note, /No matching lines/);
    assert.equal(calls.narrow.length, 0);
  });
});

test("grafana_first_occurrence: requires a line filter", async () => {
  await assert.rejects(() => callTool("grafana_first_occurrence", { client: "acme" }), /line_filter is required/);
});

test("grafana_logs_trend: requests one extra step, so the final interval's count is returned", async () => {
  const orig = globalThis.fetch;
  let endParam = null;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes(NS_VALUES)) return jsonResponse(["acme-prod"]);
    if (u.includes("loki/api/v1/query_range")) {
      endParam = Number(BigInt(new URL(u).searchParams.get("end")) / 1000000000n);
      return jsonResponse({ resultType: "matrix", result: [] });
    }
    return jsonResponse([]);
  };
  try {
    const out = await callTool("grafana_logs_trend", { client: "acme", from: ONSET_FROM, to: ONSET_TO, interval: "1h" });
    assert.equal(endParam, atS(ONSET_TO) + 3600);
    assert.match(out.bucket_covers, /START of the interval/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("grafana_logs_trend: edge buckets count only the part of the interval inside the window", async () => {
  // Live: a 1h trend from 14:34 reported onset 14:00 and 18 lines for a window
  // that held 6, because the first bucket's count included 14:00-14:34.
  const FROM = "2026-09-10T14:34:00Z";
  const TO = "2026-09-10T20:30:00Z";
  const edgeQueries = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes(NS_VALUES)) return jsonResponse(["acme-prod"]);
    if (u.includes("loki/api/v1/query_range")) {
      return jsonResponse({
        resultType: "matrix",
        result: [{ metric: {}, values: [[atS("2026-09-10T15:00:00Z"), "12"], [atS("2026-09-10T18:00:00Z"), "6"], [atS("2026-09-10T21:00:00Z"), "5"]] }],
      });
    }
    if (u.includes("loki/api/v1/query")) {
      const p = new URL(u).searchParams;
      const range = Number(/\[(\d+)s\]\)\)$/.exec(p.get("query"))?.[1]);
      edgeQueries.push({ range, at: Number(BigInt(p.get("time")) / 1000000000n) });
      // 14:34-15:00 held nothing; 20:00-20:30 held 2.
      const count = range === 1560 ? "0" : range === 1800 ? "2" : "0";
      return jsonResponse({ resultType: "vector", result: [{ metric: {}, value: [0, count] }] });
    }
    return jsonResponse([]);
  };
  try {
    const out = await callTool("grafana_logs_trend", { client: "acme", from: FROM, to: TO, interval: "1h" });
    assert.deepEqual(
      edgeQueries.sort((a, b) => a.at - b.at),
      [{ range: 1560, at: atS("2026-09-10T15:00:00Z") }, { range: 1800, at: atS(TO) }],
    );
    assert.equal(out.buckets[0].time, "2026-09-10T14:00:00.000Z");
    assert.equal(out.buckets[0].count, 0);
    assert.equal(out.buckets[0].partial.from, "2026-09-10T14:34:00.000Z");
    assert.equal(out.onset, "2026-09-10T17:00:00.000Z");
    assert.equal(out.total, 8);
    assert.equal(out.buckets.at(-1).count, 2);
    assert.equal(out.buckets.at(-1).partial.count_exact, true);
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------------------------------------------------------------------------
// grafana_query: owner rollup
// ---------------------------------------------------------------------------

function namespaceSeriesPayload(entries) {
  return {
    results: {
      A: {
        status: 200,
        frames: entries.map(([namespace, cluster, v]) => ({
          schema: {
            meta: { type: "timeseries-multi" },
            fields: [{ name: "Time", type: "time" }, { name: "Value", type: "number", labels: { namespace, cluster } }],
          },
          data: { values: [[0, 60_000], [v, v]] },
        })),
      },
    },
  };
}

const CONTROL_PLANE_SERIES = () => [
  { namespace: "apim-cp-cp1111", cluster: "core-us" },
  { namespace: "apim-cp-cp2222", cluster: "core-us" },
];

test("grafana_query: a spread over data-plane namespaces rolls up to the control planes that own them", async () => {
  // The misread: errors on many namespaces across many clusters looked global,
  // when every one belonged to control planes running in one place.
  const payload = namespaceSeriesPayload([
    ["apim-dp-cp1111-dp0001", "eu-a", 10],
    ["apim-dp-cp1111-dp0002", "us-b", 20],
    ["apim-dp-cp1111-dp0003", "ap-c", 5],
    ["apim-dp-cp2222-dp0001", "us-b", 1],
    ["acme-prod", "eu-a", 3],
  ]);
  await withQueryEndpointStub({ type: "prometheus", payload, series: CONTROL_PLANE_SERIES }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: "sum by (namespace, cluster) (x)" });
    const r = out.owner_rollup;
    assert.equal(r.data_plane_namespaces, 4);
    assert.equal(r.data_plane_clusters, 3);
    assert.equal(r.control_planes, 2);
    assert.equal(r.by_control_plane[0].control_plane_id, "cp1111");
    assert.deepEqual(r.by_control_plane[0].control_plane_clusters, ["core-us"]);
    assert.deepEqual(r.by_control_plane_cluster, [{ cluster: "core-us", control_planes: 2, data_planes: 4 }]);
    assert.match(r.note, /check the control-plane side/);
  });
});

test("grafana_query: the rollup counts every namespace, not just the 50 series the digest keeps", async () => {
  const entries = Array.from({ length: 60 }, (_, i) => [`apim-dp-cp${1111 + (i % 3)}-dp${String(i).padStart(4, "0")}`, "eu-a", 1]);
  await withQueryEndpointStub({ type: "prometheus", payload: namespaceSeriesPayload(entries), series: () => [] }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: "sum by (namespace) (x)" });
    assert.equal(out.results.A.truncated, 10);
    assert.equal(out.owner_rollup.data_plane_namespaces, 60);
    assert.equal(out.owner_rollup.control_planes, 3);
  });
});

test("grafana_query: no rollup for a result that is not broad", async () => {
  const payload = namespaceSeriesPayload([["apim-dp-cp1111-dp0001", "eu-a", 1], ["apim-dp-cp1111-dp0002", "eu-a", 1]]);
  await withQueryEndpointStub({ type: "prometheus", payload, series: CONTROL_PLANE_SERIES }, async () => {
    const out = await callTool("grafana_query", { datasource_uid: "ds", expr: "sum by (namespace) (x)" });
    assert.equal(out.owner_rollup, undefined);
  });
});

// ---------------------------------------------------------------------------
// grafana_failure_topology
// ---------------------------------------------------------------------------

const TOPOLOGY_CLUSTER = "shared-worker-us-east-prod";

function topologyFixture(spec) {
  return {
    series: spec.map(([pod]) => ({ cluster: TOPOLOGY_CLUSTER, namespace: "acme-prod", pod, service_name: "gw" })),
    errorRows: spec
      .filter(([, , e]) => e > 0)
      .map(([pod, , e]) => ({ metric: { cluster: TOPOLOGY_CLUSTER, namespace: "acme-prod", pod }, value: [0, String(e)] })),
    podInfo: spec.map(([pod, node]) => ({ cluster: TOPOLOGY_CLUSTER, namespace: "acme-prod", pod, node, host_ip: `10.0.0.${node.slice(-1)}` })),
  };
}

async function withTopologyStub({ series = [], errorRows = [], podInfo = [], metricsUid = "prom-ds" }, fn) {
  const orig = globalThis.fetch;
  const before = process.env.GRAFANA_METRICS_DATASOURCE_UID;
  if (metricsUid) process.env.GRAFANA_METRICS_DATASOURCE_UID = metricsUid;
  else delete process.env.GRAFANA_METRICS_DATASOURCE_UID;
  const calls = { loki: [], prom: [] };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes("/datasources/uid/")) return jsonResponse(JSON.stringify({ uid: "prom-ds", name: "prom", type: "prometheus" }));
    if (u.includes("loki/api/v1/series")) return jsonResponse(series);
    if (u.includes("loki/api/v1/query")) {
      calls.loki.push(new URL(u).searchParams.get("query"));
      return jsonResponse({ resultType: "vector", result: errorRows });
    }
    if (u.includes("/api/v1/query")) {
      calls.prom.push(new URL(u).searchParams.get("query"));
      return jsonResponse({ resultType: "vector", result: podInfo.map((metric) => ({ metric, value: [0, "1"] })) });
    }
    return jsonResponse([]);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
    if (before === undefined) delete process.env.GRAFANA_METRICS_DATASOURCE_UID;
    else process.env.GRAFANA_METRICS_DATASOURCE_UID = before;
  }
}

test("grafana_failure_topology: failing pods on one node, healthy siblings elsewhere", async () => {
  const fx = topologyFixture([
    ["gw-a", "node-1", 30], ["gw-b", "node-1", 25], ["gw-c", "node-1", 20],
    ["gw-d", "node-2", 0], ["gw-e", "node-2", 1], ["gw-f", "node-3", 0], ["gw-g", "node-4", 0],
  ]);
  await withTopologyStub(fx, async (calls) => {
    const out = await callTool("grafana_failure_topology", { namespace: "acme-prod", line_filter: "MongoTimeoutException", from: "now-1h" });
    assert.equal(out.verdict, "node_concentrated");
    assert.equal(out.by_node[0].node, "node-1");
    assert.equal(out.pods_in_scope, 7);
    assert.equal(out.healthy_pods, 3);
    // Errors counted per pod, grouped by the sampling label as well.
    assert.match(calls.loki[0], /^sum by \(cluster, namespace, pod, __adaptive_logs_sampled__\)/);
    assert.match(calls.loki[0], /MongoTimeoutException/);
    // Placement for the pods in scope, not a whole-cluster dump.
    assert.ok(calls.prom[0].includes("namespace=~`^(?:acme-prod)$`"), calls.prom[0]);
    assert.ok(calls.prom[0].includes(`cluster="${TOPOLOGY_CLUSTER}"`), calls.prom[0]);
  });
});

test("grafana_failure_topology: without a metrics datasource it says what is missing", async () => {
  const fx = topologyFixture([["gw-a", "node-1", 5], ["gw-b", "node-2", 0]]);
  await withTopologyStub({ ...fx, metricsUid: null }, async (calls) => {
    const out = await callTool("grafana_failure_topology", { namespace: "acme-prod", line_filter: "boom" });
    assert.equal(out.verdict, "insufficient");
    assert.match(out.node_placement_note, /GRAFANA_METRICS_DATASOURCE_UID/);
    assert.equal(out.pods_without_node.length, 2);
    assert.equal(calls.prom.length, 0);
  });
});

test("grafana_failure_topology: validates its scope", async () => {
  await withTopologyStub({}, async () => {
    await assert.rejects(() => callTool("grafana_failure_topology", { namespace: "acme-prod" }), /line_filter is required/);
    await assert.rejects(
      () => callTool("grafana_failure_topology", { namespace: "acme-prod", client: "acme", line_filter: "x" }),
      /exactly one of client, namespace or namespace_pattern/,
    );
    await assert.rejects(
      () => callTool("grafana_failure_topology", { namespace_pattern: ".*", line_filter: "x" }),
      /matches every namespace/,
    );
  });
});

test("grafana_failure_topology: a namespace pattern keeps its backslashes", async () => {
  await withTopologyStub({}, async (calls) => {
    const out = await callTool("grafana_failure_topology", { namespace_pattern: String.raw`apim-cp-\w+`, line_filter: "x" });
    assert.equal(out.scope_applied, String.raw`{namespace=~"apim-cp-\\w+"}`);
    assert.ok(calls.loki[0].includes(String.raw`namespace=~"apim-cp-\\w+"`), calls.loki[0]);
  });
});

// ---------------------------------------------------------------------------
// grafana_explore_link
// ---------------------------------------------------------------------------

async function withDatasourceTypes(types, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    const m = /\/datasources\/uid\/([^/?]+)/.exec(u);
    if (m) {
      const uid = decodeURIComponent(m[1]);
      if (!types[uid]) return jsonResponse("not found", { status: 404 });
      return jsonResponse(JSON.stringify({ uid, name: `${uid} name`, type: types[uid] }));
    }
    return jsonResponse([]);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const EXPLORE_TYPES = { "ex-logs": "loki", "ex-prom": "prometheus", "ex-k6": "k6-datasource", "ex-cw": "cloudwatch" };
const panesOf = (url) => JSON.parse(decodeURIComponent(new URL(url).searchParams.get("panes")));

test("grafana_explore_link: split puts each query in its own pane with its datasource type", async () => {
  await withDatasourceTypes(EXPLORE_TYPES, async () => {
    const out = await callTool("grafana_explore_link", {
      queries: [
        { datasource_uid: "ex-logs", expr: 'sum(count_over_time({namespace="acme-prod"}[5m]))' },
        { datasource_uid: "ex-prom", expr: 'sum(kube_pod_info{namespace="acme-prod"})' },
      ],
      split: true,
      from: "now-1h",
    });
    const panes = panesOf(out.url);
    assert.deepEqual(Object.keys(panes), ["p1", "p2"]);
    assert.equal(panes.p1.queries[0].datasource.type, "loki");
    assert.equal(panes.p2.queries[0].datasource.type, "prometheus");
    // Absolute by default, so a link in a ticket shows the same window tomorrow.
    assert.match(panes.p1.range.from, /^\d{13}$/);
    assert.equal(out.absolute, true);
    assert.match(out.timezone_note, /viewer's own time-zone/);
  });
});

test("grafana_explore_link: queries for two datasources in one pane use Mixed", async () => {
  await withDatasourceTypes(EXPLORE_TYPES, async () => {
    const out = await callTool("grafana_explore_link", {
      queries: [{ datasource_uid: "ex-logs", expr: "x" }, { datasource_uid: "ex-prom", expr: "y" }],
      from: "now-15m",
      absolute: false,
    });
    const panes = panesOf(out.url);
    assert.equal(panes.p1.datasource, "-- Mixed --");
    assert.deepEqual(panes.p1.range, { from: "now-15m", to: "now" });
    assert.match(out.timezone_note, /RELATIVE/);
  });
});

test("grafana_explore_link: refuses what it should not link", async () => {
  await withDatasourceTypes(EXPLORE_TYPES, async () => {
    await assert.rejects(
      () => callTool("grafana_explore_link", { queries: [{ datasource_uid: "ex-k6", query: { x: 1 } }] }),
      /not in the read-only allowlist/,
    );
    await assert.rejects(
      () => callTool("grafana_explore_link", { queries: [{ datasource_uid: "ex-logs", expr: "a" }], panes: [{ queries: [{ datasource_uid: "ex-logs", expr: "a" }] }] }),
      /either queries .* or panes/,
    );
    await assert.rejects(
      () => callTool("grafana_explore_link", { queries: [1, 2, 3].map(() => ({ datasource_uid: "ex-logs", expr: "a" })), split: true }),
      /Explore shows two/,
    );
    await assert.rejects(() => callTool("grafana_explore_link", { queries: [{ datasource_uid: "ex-logs" }] }), /needs expr/);
  });
});

test("grafana_explore_link: a CloudWatch link carries the billing notice, and Logs Insights is refused", async () => {
  await withDatasourceTypes(EXPLORE_TYPES, async () => {
    const out = await callTool("grafana_explore_link", {
      queries: [{ datasource_uid: "ex-cw", query: { namespace: "AWS/S3", metricName: "BucketSizeBytes", queryMode: "Metrics" } }],
    });
    assert.ok(out.billing_notice, JSON.stringify(out));
    await assert.rejects(
      () => callTool("grafana_explore_link", { queries: [{ datasource_uid: "ex-cw", query: { queryMode: "Logs", expression: "fields @message" } }] }),
    );
  });
});
