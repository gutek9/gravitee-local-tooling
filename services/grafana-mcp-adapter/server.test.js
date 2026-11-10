import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

// server.js imports grafanaClient.js, which reads env at import time and refuses
// to make calls unless configured. Set a deterministic config before importing so
// the tool handlers run and buildExploreUrl/buildDrilldownUrl are predictable.
process.env.GRAFANA_ENABLED = "true";
process.env.GRAFANA_BASE_URL = "https://g.example.com";
process.env.GRAFANA_TOKEN = "glsa_test";
// Pin the Loki datasource uid so the proxy path is predictable in assertions.
process.env.GRAFANA_LOGS_DATASOURCE_UID = "grafanacloud-logs";
// The customer map is fetched from GitHub; the stub below answers that fetch
// with CUSTOMERS_CSV. A token must be set or the map skips GitHub. When GitHub
// fails the map falls back to the local customers-snapshot.json, which holds
// real customers on some machines, so the snapshot path points at a file that
// does not exist: a test with GitHub down then sees the map as unavailable.
process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "test-token";
process.env.GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH = join(tmpdir(), `grafana-server-test-${process.pid}`, "customers-snapshot.json");

// server.js only starts the stdio transport when run as the entrypoint, so this
// import is side-effect-free apart from registering the tools. `tools` exposes the
// registered handler for each tool so we can drive the orchestration directly.
const { tools, toolInputSchemas, startupWarmUp } = await import("./server.js");
const { resetCustomerMapCache, loadCustomerMap } = await import("./customerMapLoader.js");

// Made-up Gravitee Cloud customers, with the real CSV header. None of these names
// match a hosted customer used elsewhere in this file, so those tests resolve
// through the namespace label alone, as before.
//   acme        one Cockpit organization, three data planes (prod, dev, qa)
//   beacon,     two distinct customers that a fragment like "beac" matches
//   beaconlabs  together
//   northwind   one customer name across two Cockpit organizations
const CUSTOMERS_CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-acme.us-aws-us-east-1.gateway.gravitee.io
acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,dev-org-acme.us-aws-us-east-1.gateway.gravitee.io
acme,cp1111,cp1111-dp0003,unitedstates,aws,us-east-1,None,qa-org-acme.us-aws-us-east-1.gateway.gravitee.io
beacon,cp2222,cp2222-dp0001,europe,az,westeurope,None,prod-org-beacon.eu-az-westeurope.gateway.gravitee.io
beaconlabs,cp3333,cp3333-dp0001,europe,az,westeurope,None,prod-org-beaconlabs.eu-az-westeurope.gateway.gravitee.io
northwind,cp4444,cp4444-dp0001,europe,az,westeurope,None,prod-org-northwind-a.eu-az-westeurope.gateway.gravitee.io
northwind,cp5555,cp5555-dp0001,europe,az,westeurope,None,prod-org-northwind-b.eu-az-westeurope.gateway.gravitee.io
`;

// ---------------------------------------------------------------------------
// fetch stub: route Loki proxy calls by path and record the URLs seen.
// ---------------------------------------------------------------------------

// Answer the customer map's two GitHub calls: the CSV itself, and the commit
// lookup used for the map's age (an empty list means "age unknown", a
// `commitDate` gives the map that date).
function githubResponse(u, commitDate) {
  const commits = commitDate ? [{ commit: { committer: { date: commitDate } } }] : [];
  const body = u.includes("/commits?") ? JSON.stringify(commits) : CUSTOMERS_CSV;
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  });
}

// A route answered with this fails with HTTP 502, as Loki does when it is down.
const LOKI_DOWN = { lokiDown: true };

// Install a fetch stub that answers each Loki endpoint from `routes` (keyed by a
// substring of the request path) and records every Loki URL it saw. `routes`
// values are the JSON `data` array Loki would return under `{ status, data }`,
// or LOKI_DOWN. The customer map is reloaded through the stub on every call, so
// each test starts from CUSTOMERS_CSV rather than a map cached by an earlier test.
// `githubDown: true` makes GitHub answer 503 instead; `commitDate` is the date
// GitHub gives for the map's last commit.
function withLokiStub(routes, fn, { githubDown = false, commitDate } = {}) {
  const calls = [];
  const origFetch = globalThis.fetch;
  resetCustomerMapCache();
  globalThis.fetch = (url) => {
    if (String(url).startsWith("https://api.github.com/")) {
      if (githubDown) return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
      return githubResponse(String(url), commitDate);
    }
    calls.push(String(url));
    const u = String(url);
    let data = [];
    for (const [needle, value] of Object.entries(routes)) {
      if (u.includes(needle)) {
        data = typeof value === "function" ? value(u) : value;
        break;
      }
    }
    if (data === LOKI_DOWN) {
      return Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve(""), headers: { get: () => null } });
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
      const out = await callTool("grafana_logs_link", { client: "orbit plt live", component: "gateway" });
      assert.deepEqual(out.resolved_namespaces, ["orbit-plt-live"]);
      // service_name only carries the component, not the environment words.
      assert.ok(!/service_name=~"[^"]*(plt|live)/.test(out.query), out.query);
      assert.equal(calls.filter((u) => u.includes(SERIES)).length, 1, "no retry should be needed");
      assert.equal(out.env_filter_dropped, undefined);
    },
  );
});

test("tool schemas: a blank client or query is refused before the handler runs", () => {
  // Regression: client "   " passed the schema and became
  // {service_name=~"(?i).*.*"}, a /series query over every stream in Loki.
  const logs = toolInputSchemas.grafana_logs_link;
  const find = toolInputSchemas.grafana_find_customer;
  for (const blank of ["", "   ", "\t\n"]) {
    assert.equal(logs.safeParse({ client: blank }).success, false, `client ${JSON.stringify(blank)}`);
    assert.equal(find.safeParse({ query: blank }).success, false, `query ${JSON.stringify(blank)}`);
  }
  // Surrounding spaces are trimmed, not refused.
  assert.equal(logs.safeParse({ client: "  acme  " }).data.client, "acme");
  assert.equal(find.safeParse({ query: " acme " }).data.query, "acme");
});

test("startup: an enabled adapter warms the customer map from GitHub", async () => {
  // The control for server.disabled.test.js: the same check sees the request
  // when Grafana is enabled, so "no request" there is not an artefact.
  const calls = [];
  const origFetch = globalThis.fetch;
  resetCustomerMapCache();
  globalThis.fetch = (url) => {
    calls.push(String(url));
    return githubResponse(String(url));
  };
  try {
    startupWarmUp();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.some((u) => u.startsWith("https://api.github.com/") && u.includes("/contents/")), calls.join(", "));
    // Let the load started above finish under the stub, so nothing it does
    // later reaches the real fetch.
    await loadCustomerMap();
  } finally {
    globalThis.fetch = origFetch;
    resetCustomerMapCache();
  }
});

test("grafana_logs_link: a blank client that reaches the handler never queries /series", async () => {
  // Called directly the schema is skipped, so the handler must still not turn a
  // blank client into a query over every stream (or every customer's gateway).
  await withLokiStub(
    { [NS_VALUES]: ["kestrel-prod"], [SERIES]: [stream("kestrel-prod", "graviteeio-apim-kestrel-prod-gateway")] },
    async (calls) => {
      for (const args of [{ client: "   " }, { client: "   ", component: "gateway" }]) {
        await assert.rejects(tools.grafana_logs_link(args, {}), /client is required/);
      }
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: a word no namespace carries is refused, listing the namespaces that exist", async () => {
  // Regression: the label route dropped "prod" to find something and searched
  // orbit-plt-live as if it were what was asked for. The same path made
  // "kestrel staging" search every kestrel namespace.
  await withLokiStub(
    { [NS_VALUES]: ["orbit-plt-live"], [SERIES]: [stream("orbit-plt-live", "by-live-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "orbit prod" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.deepEqual(out.links, []);
      assert.deepEqual(out.unknown_qualifiers, ["prod"]);
      assert.deepEqual(out.skipped_namespaces, ["orbit-plt-live"]);
      assert.match(out.note, /"prod" is in none of the namespaces found for "orbit" \(orbit-plt-live\)/);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
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
// grafana_logs_link: Gravitee Cloud customers through the customer map
// ---------------------------------------------------------------------------

test("grafana_logs_link: a Cloud customer resolves to its data-plane namespaces through the map", async () => {
  // beacon's namespace carries ids only, so the namespace label cannot find it.
  await withLokiStub(
    {
      [NS_VALUES]: ["kestrel-prod", "apim-dp-cp2222-dp0001", "apim-cp-cp2222"],
      [SERIES]: [stream("apim-dp-cp2222-dp0001", "apim-gateway")],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "beacon" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp2222-dp0001"]);
      assert.equal(out.resolved_via, "customer_map");
      assert.equal(out.map_source, "github");
      assert.equal(out.matched_deployments[0].customer, "beacon");
      // The control-plane namespace is shared with other customers: reported,
      // never searched under beacon's name.
      assert.deepEqual(out.shared_control_plane_namespaces, ["apim-cp-cp2222"]);
      const series = decodeURIComponent(calls.find((u) => u.includes(SERIES)));
      assert.ok(series.includes('namespace=~"^apim-dp-cp2222-dp0001$"'), series);
      assert.equal(out.links[0].namespace, "apim-dp-cp2222-dp0001");
    },
  );
});

test("grafana_logs_link: a customer that is both hosted and Cloud is searched through both routes", async () => {
  // acme has a hosted `acme-prod` namespace AND Cockpit data planes. Stopping at
  // the first route would search half of its logs.
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"],
      [SERIES]: [stream("acme-prod", "acme-gateway"), stream("apim-dp-cp1111-dp0001", "apim-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "acme" });
      assert.equal(out.resolved_via, "namespace_label+customer_map");
      assert.deepEqual(out.label_namespaces, ["acme-prod"]);
      assert.deepEqual(
        [...out.resolved_namespaces].sort(),
        ["acme-prod", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp1111-dp0003"],
      );
      // dp0003 is in the map but not in Loki for this range: flagged, not hidden.
      assert.deepEqual(out.mapped_namespaces_absent_in_range, ["apim-dp-cp1111-dp0003"]);
      // Streams matched, so no "empty result" note.
      assert.equal(out.note, undefined);
    },
  );
});

test("grafana_logs_link: an unavailable map is reported when only the hosted namespace is found", async () => {
  // Regression: with GitHub and the snapshot both gone, acme's hosted namespace
  // still resolved by name, but the response dropped the map's source and
  // warning, so acme-prod alone read as all of acme. Its Cloud data planes, in
  // Loki but tied to acme only by the map, were never searched.
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001"],
      [SERIES]: [stream("acme-prod", "acme-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "acme" });
      assert.deepEqual(out.resolved_namespaces, ["acme-prod"]);
      assert.equal(out.resolved_via, "namespace_label");
      assert.equal(out.map_source, "unavailable");
      assert.match(out.map_warning, /Customer mapping is unavailable/);
      // The warning must not call the hosted result complete: acme is on Cloud too.
      assert.match(out.map_warning, /gets only its hosted part/);
    },
    { githubDown: true },
  );
});

test("grafana_logs_link: an env word narrows the map to that deployment", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"],
      [SERIES]: [stream("apim-dp-cp1111-dp0002", "apim-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "acme dev" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp1111-dp0002"]);
      assert.equal(out.env_filter_applied, true);
      assert.equal(out.matched_deployments[0].env, "dev");
    },
  );
});

test("grafana_logs_link: an env word does not drag in a hosted namespace it does not describe", async () => {
  // Regression: "acme dev" also searched the hosted acme-prod, which the label
  // route found only by dropping "dev".
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"],
      [SERIES]: [stream("apim-dp-cp1111-dp0002", "apim-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "acme dev" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp1111-dp0002"]);
      assert.equal(out.resolved_via, "customer_map");
      assert.deepEqual(out.skipped_namespaces, ["acme-prod"]);
      assert.match(out.skipped_namespaces_note, /not for "dev", so not searched/);
    },
  );
});

test("grafana_logs_link: prod is not read inside nonprod or preprod, and Loki is never queried", async () => {
  // Regression: "orbit prod" searched orbit-nonprod and orbit-preprod as if they
  // were orbit's prod.
  await withLokiStub(
    { [NS_VALUES]: ["orbit-nonprod", "orbit-preprod"], [SERIES]: [stream("orbit-nonprod", "orbit-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "orbit prod" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.deepEqual(out.links, []);
      assert.deepEqual(out.skipped_namespaces, ["orbit-nonprod", "orbit-preprod"]);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: hosted namespaces of two customers are refused, and Loki is never queried", async () => {
  // Regression: "plt live" searched two customers' namespaces together.
  await withLokiStub(
    { [NS_VALUES]: ["nova-plt-live", "vega-plt-live"], [SERIES]: [stream("nova-plt-live", "nova-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "plt live" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.equal(out.ambiguous_customer, true);
      assert.deepEqual(out.candidates.map((c) => c.customer), ["nova", "vega"]);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: a hosted name that only contains a Cloud customer's is not searched", async () => {
  // Regression: "acme" searched another customer's acmecorp-prod with acme's data plane.
  await withLokiStub(
    {
      [NS_VALUES]: ["acmecorp-prod", "apim-dp-cp1111-dp0001"],
      [SERIES]: [stream("apim-dp-cp1111-dp0001", "acme-gateway")],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "acme" });
      // acme's three mapped data planes (two absent from Loki are flagged, not dropped).
      assert.deepEqual(out.resolved_namespaces, [
        "apim-dp-cp1111-dp0001",
        "apim-dp-cp1111-dp0002",
        "apim-dp-cp1111-dp0003",
      ]);
      assert.deepEqual(out.similar_names_not_searched, [{ customer: "acmecorp", kind: "hosted" }]);
      const series = decodeURIComponent(calls.find((u) => u.includes(SERIES)));
      assert.ok(!series.includes("acmecorp"), series);
    },
  );
});

test("grafana_logs_link: part of a name with the map unavailable is refused, and Loki is never queried", async () => {
  // Without the map, "acme" could be a Cloud customer's whole name; searching the
  // hosted acmecorp-prod would answer for the wrong customer.
  await withLokiStub(
    { [NS_VALUES]: ["acmecorp-prod"], [SERIES]: [stream("acmecorp-prod", "acmecorp-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "acme" });
      assert.equal(out.refused, true);
      assert.equal(out.partial_match_unchecked, true);
      assert.equal(out.map_source, "unavailable");
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
    { githubDown: true },
  );
});

test("grafana_logs_link: a control-plane id typed into client is refused, and Loki is never queried", async () => {
  // Regression: "cp1111" searched the shared apim-cp-cp1111 and the data planes on it.
  await withLokiStub(
    {
      [NS_VALUES]: ["apim-cp-cp1111", "apim-dp-cp1111-dp0001"],
      [SERIES]: [stream("apim-cp-cp1111", "management-api")],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "cp1111" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.equal(out.matched_by_id.kind, "control_plane");
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: a data-plane id searches that data plane only, and names its customer", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["apim-cp-cp1111", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"],
      [SERIES]: [stream("apim-dp-cp1111-dp0001", "acme-gateway")],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "apim-dp-cp1111-dp0001" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp1111-dp0001"]);
      assert.equal(out.matched_by_id.customer, "acme");
      const series = decodeURIComponent(calls.find((u) => u.includes(SERIES)));
      assert.ok(series.includes('namespace=~"^apim-dp-cp1111-dp0001$"'), series);
      assert.ok(!series.includes("apim-cp-cp1111") && !series.includes("dp0002"), series);
    },
  );
});

test("grafana_logs_link: a data plane's own id alone is refused, and Loki /series is never queried", async () => {
  await withLokiStub(
    {
      [NS_VALUES]: ["apim-cp-cp1111", "apim-dp-cp1111-dp0002"],
      [SERIES]: [stream("apim-dp-cp1111-dp0002", "prod-apim-dp-cp1111-dp0002-gateway")],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "dp0002", component: "gateway" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.matched_by_id.data_planes, [{ namespace: "apim-dp-cp1111-dp0002", customer: "acme" }]);
      assert.deepEqual(out.links, []);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: the service_name search leaves Gravitee Cloud namespaces out", async () => {
  // Regression: "cp11" named no customer, and the service_name search reached
  // the shared apim-cp-cp1111 and data planes of two customers through the ids
  // in their service names.
  await withLokiStub(
    {
      [NS_VALUES]: ["apim-cp-cp1111", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "prod"],
      [SERIES]: [],
      [SVC_VALUES]: [],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "cp11" });
      assert.equal(out.resolved_via, "none");
      const match = new URL(calls.find((u) => u.includes(SERIES))).searchParams.get("match[]");
      assert.equal(match, '{namespace!~"(?i)apim-(dp|cp)-.+", service_name=~"(?i).*cp11.*"}');
      assert.equal(out.query, match);
    },
  );
});

test("grafana_logs_link: an env word matching none of the customer's deployments is refused, and Loki is never queried", async () => {
  // Regression (#9 review): "acme staging" with only prod, dev and qa searched all
  // of them, and the hosted acme-prod too, with no staging constraint at all.
  await withLokiStub(
    { [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"], [SERIES]: [] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "acme staging" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.deepEqual(out.links, []);
      assert.deepEqual(out.unknown_qualifiers, ["staging"]);
      assert.deepEqual(out.known_environments, ["dev", "prod", "qa"]);
      assert.deepEqual(out.skipped_namespaces, ["acme-prod"]);
      assert.match(out.note, /"staging" does not describe any deployment of acme/);
      assert.match(out.note, /Retry without it/);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: a refusal says how old the customer map is", async () => {
  // Regression: refusals carried map_source but not the map's age, although the
  // answers that searched something did.
  await withLokiStub(
    { [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001"], [SERIES]: [] },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "acme staging" });
      assert.equal(out.refused, true);
      assert.equal(out.map_source, "github");
      assert.equal(out.map_generated_at, "2026-10-01T00:00:00Z");
      assert.equal(typeof out.map_generated_days_ago, "number");
    },
    { commitDate: "2026-10-01T00:00:00Z" },
  );
});

test("grafana_logs_link: a hosted customer with a word none of its namespaces carries is refused", async () => {
  await withLokiStub({ [NS_VALUES]: ["kestrel-prod", "kestrel-rec"], [SERIES]: [] }, async (calls) => {
    const out = await callTool("grafana_logs_link", { client: "kestrel staging" });
    assert.equal(out.refused, true);
    assert.deepEqual(out.skipped_namespaces, ["kestrel-prod", "kestrel-rec"]);
    assert.equal(out.known_environments, undefined);
    assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
  });
});

test("grafana_logs_link: a component typed into client is refused with a pointer to component", async () => {
  // A model may type the component into client, as below. The refusal must say
  // where "gateway" belongs, so the retry narrows to the gateway rather than
  // dropping the word and getting every service.
  await withLokiStub(
    {
      [NS_VALUES]: ["lumen-prod"],
      [SERIES]: [stream("lumen-prod", "graviteeio-apim3-gateway")],
    },
    async (calls) => {
      const refused = await callTool("grafana_logs_link", { client: "lumen prod gateway" });
      assert.equal(refused.refused, true);
      assert.deepEqual(refused.unknown_qualifiers, ["gateway"]);
      assert.match(refused.note, /pass it as component instead/);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");

      const retried = await callTool("grafana_logs_link", { client: "lumen prod", component: "gateway" });
      assert.deepEqual(retried.resolved_namespaces, ["lumen-prod"]);
      assert.match(retried.query, /service_name=~"[^"]*gateway/);
    },
  );
});

test("grafana_logs_link: no streams for a mapped namespace Loki does not know -> stale-map note", async () => {
  // acme qa maps to dp0003, which Loki has never seen in this range. "No logs for
  // this customer" would be a false negative; the likelier cause is a stale map.
  await withLokiStub(
    { [NS_VALUES]: ["apim-dp-cp1111-dp0001"], [SERIES]: [], [SVC_VALUES]: ["should-not-be-asked"] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "acme qa" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp1111-dp0003"]);
      assert.match(out.note, /customer map is stale/);
      assert.equal(out.suggestions, undefined);
      assert.ok(!calls.some((u) => u.includes(SVC_VALUES)), "no service_name suggestions for a resolved customer");
    },
  );
});

test("grafana_logs_link: a failed namespace lookup is reported, not blamed on a stale map", async () => {
  // Regression: the failure was swallowed as "no namespaces", so every mapped
  // namespace looked absent from Loki and an empty result blamed a stale map.
  await withLokiStub({ [NS_VALUES]: LOKI_DOWN, [SERIES]: [] }, async () => {
    const out = await callTool("grafana_logs_link", { client: "acme" });
    assert.equal(out.resolved_namespaces.length, 3);
    assert.equal(out.namespace_lookup_failed, true);
    assert.match(out.namespace_lookup_note, /Loki did not return its namespace list/);
    assert.equal(out.mapped_namespaces_absent_in_range, undefined);
    assert.doesNotMatch(out.note, /stale/);
    assert.match(out.note, /No log streams in this range for namespace/);
  });
});

test("grafana_logs_link: nothing found with a source down is refused, and Loki /series is never queried", async () => {
  // Regression: "orbit dev" with Loki's namespace list down fell to a
  // service_name search, which linked another customer's orbitalpay-dev.
  await withLokiStub(
    { [NS_VALUES]: LOKI_DOWN, [SERIES]: [stream("prod", "graviteeio-apim-orbitalpay-dev-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "orbit dev" });
      assert.equal(out.refused, true);
      assert.equal(out.namespace_lookup_failed, true);
      assert.match(out.customer_note, /Loki did not return its namespace list/);
      assert.deepEqual(out.links, []);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
  // The map unavailable, and no hosted namespace for the phrase.
  await withLokiStub(
    { [NS_VALUES]: ["kestrel-prod", "prod"], [SERIES]: [stream("prod", "graviteeio-apim-zzxqq-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "zzxqq" });
      assert.equal(out.refused, true);
      assert.equal(out.map_source, "unavailable");
      assert.match(out.customer_note, /customer map could not be read/);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
    { githubDown: true },
  );
});

test("grafana_logs_link: a fragment matching several Cloud customers is refused, and Loki is never queried", async () => {
  // "beac" matches beacon AND beaconlabs. Merging them would return one
  // customer's logs under the other's name, so the map withholds both.
  // Regression: the tool then searched service_name for "beac" across all of
  // Loki, while its note said nothing was searched.
  await withLokiStub(
    { [NS_VALUES]: ["apim-dp-cp2222-dp0001", "apim-dp-cp3333-dp0001"], [SERIES]: [], [SVC_VALUES]: [] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "beac" });
      assert.equal(out.refused, true);
      assert.deepEqual(out.resolved_namespaces, []);
      assert.deepEqual(out.links, []);
      assert.equal(out.ambiguous_customer, true);
      assert.deepEqual(out.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
      assert.match(out.customer_note, /matches 2 different customers/);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
  );
});

test("grafana_logs_link: an ambiguous fragment still searches a hosted namespace that carries it whole", async () => {
  await withLokiStub(
    { [NS_VALUES]: ["beac-prod", "apim-dp-cp2222-dp0001"], [SERIES]: [stream("beac-prod", "beac-gateway")] },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "beac" });
      assert.equal(out.refused, undefined);
      assert.deepEqual(out.resolved_namespaces, ["beac-prod"]);
      assert.equal(out.ambiguous_customer, true);
      assert.match(out.customer_note, /none of them was searched/);
      assert.match(out.customer_note, /Only the namespaces named after "beac" \(beac-prod\) were searched/);
      assert.equal(out.links[0].namespace, "beac-prod");
    },
  );
});

// ---------------------------------------------------------------------------
// grafana_logs_link: control_plane_id only ever narrows
// ---------------------------------------------------------------------------

const NORTHWIND_NS = ["apim-dp-cp4444-dp0001", "apim-dp-cp5555-dp0001"];

test("grafana_logs_link: a matching control_plane_id narrows to that organization", async () => {
  await withLokiStub(
    { [NS_VALUES]: NORTHWIND_NS, [SERIES]: [stream("apim-dp-cp5555-dp0001", "apim-gateway")] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "northwind", control_plane_id: "cp5555" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp5555-dp0001"]);
      assert.equal(out.refused, undefined);
      const series = decodeURIComponent(calls.find((u) => u.includes(SERIES)));
      assert.ok(series.includes("apim-dp-cp5555-dp0001") && !series.includes("cp4444"), series);
    },
  );
});

test("grafana_logs_link: a control_plane_id leaves out hosted namespaces, which are on no organization", async () => {
  // Regression: acme + cp1111 also searched the hosted acme-prod, so the id
  // widened past the organization it names.
  await withLokiStub(
    {
      [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp1111-dp0003"],
      [SERIES]: [stream("apim-dp-cp1111-dp0001", "apim-gateway")],
    },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "acme", control_plane_id: "cp1111" });
      assert.deepEqual(out.resolved_namespaces, ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp1111-dp0003"]);
      assert.equal(out.resolved_via, "customer_map");
      assert.deepEqual(out.skipped_namespaces, ["acme-prod"]);
      assert.match(out.skipped_namespaces_note, /control_plane_id "cp1111" leaves it out/);
      const series = decodeURIComponent(calls.find((u) => u.includes(SERIES)));
      assert.ok(!series.includes("acme-prod"), series);
    },
  );
});

test("grafana_logs_link: an unmatched control_plane_id is refused and Loki is never queried", async () => {
  // Regression: an id matching none of the customer's organizations fell back to
  // every deployment, so a mistyped id searched both of northwind's tenants.
  await withLokiStub({ [NS_VALUES]: NORTHWIND_NS, [SERIES]: [], [SVC_VALUES]: [] }, async (calls) => {
    const out = await callTool("grafana_logs_link", { client: "northwind", control_plane_id: "cp9999" });
    assert.equal(out.refused, true);
    assert.deepEqual(out.resolved_namespaces, []);
    assert.deepEqual(out.links, []);
    assert.equal(out.unknown_control_plane, true);
    assert.equal(out.requested_control_plane_id, "cp9999");
    assert.deepEqual(out.control_plane_ids, ["cp4444", "cp5555"]);
    assert.match(out.note, /not one of northwind's Cockpit organizations/);
    assert.ok(!calls.some((u) => u.includes(SERIES) || u.includes(SVC_VALUES)), calls.join("\n"));
  });
});

test("grafana_logs_link: control_plane_id on a customer the map does not have is refused", async () => {
  // kestrel is hosted: no Cockpit organizations to narrow. Ignoring the id would
  // search kestrel-prod, or every service_name, as if the id had been applied.
  await withLokiStub({ [NS_VALUES]: ["kestrel-prod"], [SERIES]: [], [SVC_VALUES]: [] }, async (calls) => {
    const out = await callTool("grafana_logs_link", { client: "kestrel", control_plane_id: "cp1111" });
    assert.equal(out.refused, true);
    assert.deepEqual(out.control_plane_ids, []);
    assert.match(out.note, /only narrows a Gravitee Cloud customer/);
    assert.ok(!calls.some((u) => u.includes(SERIES)), calls.join("\n"));
  });
});

test("grafana_logs_link: control_plane_id with an ambiguous name is refused, with the candidates", async () => {
  await withLokiStub({ [NS_VALUES]: [], [SERIES]: [], [SVC_VALUES]: [] }, async (calls) => {
    const out = await callTool("grafana_logs_link", { client: "beac", control_plane_id: "cp2222" });
    assert.equal(out.refused, true);
    assert.equal(out.ambiguous_customer, true);
    assert.deepEqual(out.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
    assert.match(out.note, /was not applied to any of them/);
    assert.ok(!calls.some((u) => u.includes(SERIES)), calls.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// grafana_find_customer: who is this, and what do they have (no log queries)
// ---------------------------------------------------------------------------

test("grafana_find_customer: a name returns the customer's deployments in both populations", async () => {
  await withLokiStub(
    { [NS_VALUES]: ["acme-prod", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"] },
    async (calls) => {
      const out = await callTool("grafana_find_customer", { query: "acme" });
      assert.equal(out.map_source, "github");
      assert.equal(out.gravitee_cloud_customers.length, 1);
      const acme = out.gravitee_cloud_customers[0];
      assert.equal(acme.customer, "acme");
      assert.equal(acme.deployments, 3);
      assert.deepEqual(acme.organizations, ["cp1111"]);
      assert.deepEqual(acme.envs, ["dev", "prod", "qa"]);
      assert.deepEqual(acme.namespaces, ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp1111-dp0003"]);
      assert.deepEqual(acme.shared_control_plane_namespaces, ["apim-cp-cp1111"]);
      // The hosted namespace that carries the name is found too.
      assert.deepEqual(out.hosted_namespaces, ["acme-prod"]);
      assert.equal(out.note, undefined);
      // It only reads label values: no log lines, no stream discovery.
      assert.ok(!calls.some((u) => u.includes(SERIES) || u.includes("query_range")), calls.join("\n"));
    },
  );
});

test("grafana_find_customer: an id from an alert or pod name finds its owner", async () => {
  await withLokiStub({ [NS_VALUES]: ["apim-dp-cp1111-dp0001"] }, async () => {
    const out = await callTool("grafana_find_customer", { query: "apim-dp-cp1111-dp0001" });
    assert.equal(out.matched_by_id.kind, "data_plane");
    assert.equal(out.matched_by_id.customer, "acme");
  });
});

test("grafana_find_customer: a fragment matching several customers says so", async () => {
  await withLokiStub({ [NS_VALUES]: [] }, async () => {
    const out = await callTool("grafana_find_customer", { query: "beac" });
    assert.deepEqual(out.gravitee_cloud_customers.map((c) => c.customer), ["beacon", "beaconlabs"]);
    assert.match(out.note, /matches 2 different Gravitee Cloud customers/);
  });
});

test("grafana_find_customer: max_results caps the namespace lists too, and Cloud ones are not hosted", async () => {
  await withLokiStub(
    { [NS_VALUES]: ["apim-cp-cp1111", "apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"] },
    async () => {
      const out = await callTool("grafana_find_customer", { query: "cp1111", max_results: 1 });
      assert.deepEqual(out.hosted_namespaces, []);
      assert.deepEqual(out.cloud_namespaces, ["apim-cp-cp1111"]);
      assert.equal(out.cloud_namespaces_truncated, 2);
    },
  );
});

test("grafana_find_customer: an unmapped data plane on the customer's control plane is reported, not claimed", async () => {
  // dp9999 is live on acme's control plane but the map does not attribute it.
  // A control plane is shared, so it may be someone else's: reported apart,
  // never added to acme's namespaces.
  await withLokiStub(
    { [NS_VALUES]: ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp9999"] },
    async () => {
      const out = await callTool("grafana_find_customer", { query: "acme" });
      const acme = out.gravitee_cloud_customers[0];
      assert.deepEqual(acme.unattributed_namespaces_on_same_control_plane, ["apim-dp-cp1111-dp9999"]);
      assert.match(acme.unattributed_note, /NOT searched as this customer/);
      assert.ok(!acme.namespaces.includes("apim-dp-cp1111-dp9999"));
    },
  );
});

test("grafana_find_customer: a live id the map cannot attribute is reported as real but ownerless", async () => {
  await withLokiStub({ [NS_VALUES]: ["apim-dp-cp9999-dp0001"] }, async () => {
    const out = await callTool("grafana_find_customer", { query: "cp9999-dp0001" });
    assert.equal(out.matched_by_id, undefined);
    assert.match(out.note, /Neither cp9999-dp0001 nor its control plane appears in the customer map/);
    assert.match(out.note, /does exist in Loki/);
  });
});

test("grafana_find_customer: nothing matched -> says so", async () => {
  await withLokiStub({ [NS_VALUES]: ["kestrel-prod"] }, async () => {
    const out = await callTool("grafana_find_customer", { query: "zzxqq" });
    assert.deepEqual(out.gravitee_cloud_customers, []);
    assert.deepEqual(out.hosted_namespaces, []);
    assert.match(out.note, /No Gravitee Cloud customer/);
  });
});

test("grafana_find_customer: a failed namespace lookup says hosted namespaces could not be checked", async () => {
  // Regression: it answered "no hosted namespace matched" for a lookup that never
  // happened.
  await withLokiStub({ [NS_VALUES]: LOKI_DOWN }, async () => {
    const out = await callTool("grafana_find_customer", { query: "kestrel" });
    assert.deepEqual(out.hosted_namespaces, []);
    assert.equal(out.namespace_lookup_failed, true);
    assert.match(out.note, /hosted namespaces could not be checked/);
    assert.doesNotMatch(out.note, /hosted namespace, or known id matched/);
  });
});

test("map tools: an unreadable map is said to be unreadable, with GitHub's reason, never 'not in the map'", async () => {
  // Regression: with GitHub down and no snapshot, find_customer answered "No
  // Gravitee Cloud customer ... matched", and a control_plane_id was refused as
  // "not one in the customer map ... Drop control_plane_id".
  await withLokiStub(
    { [NS_VALUES]: ["kestrel-prod"], [SERIES]: [] },
    async (calls) => {
      const found = await callTool("grafana_find_customer", { query: "orbitalis" });
      assert.equal(found.map_source, "unavailable");
      assert.match(found.note, /customer map could not be read/);
      assert.match(found.map_warning, /GitHub could not be read \(GitHub responded 503\)/);
      const logs = await callTool("grafana_logs_link", { client: "acme", control_plane_id: "cp1111" });
      assert.equal(logs.refused, true);
      assert.match(logs.customer_note, /could not be applied: the customer map could not be read/);
      assert.doesNotMatch(logs.customer_note, /Drop control_plane_id/);
      assert.ok(!calls.some((u) => u.includes(SERIES)), "Loki /series must not be queried");
    },
    { githubDown: true },
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

