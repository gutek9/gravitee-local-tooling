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
// The customer map is fetched from GitHub; the stub below answers that fetch
// with CUSTOMERS_CSV. A token must be set or the map skips GitHub and reads the
// local customers-snapshot.json, which holds real customers on some machines.
process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "test-token";

// server.js only starts the stdio transport when run as the entrypoint, so this
// import is side-effect-free apart from registering the tools. `tools` exposes the
// registered handler for each tool so we can drive the orchestration directly.
const { tools } = await import("./server.js");
const { resetCustomerMapCache } = await import("./customerMap.js");

// Made-up Gravitee Cloud customers, with the real CSV header. None of these names
// match the hosted customers used elsewhere in this file (april, orbit, ...), so
// those tests resolve through the namespace label alone, as before.
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
// lookup used for the map's age (an empty list means "age unknown").
function githubResponse(u) {
  const body = u.includes("/commits?") ? "[]" : CUSTOMERS_CSV;
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  });
}

// Install a fetch stub that answers each Loki endpoint from `routes` (keyed by a
// substring of the request path) and records every Loki URL it saw. `routes`
// values are the JSON `data` array Loki would return under `{ status, data }`.
// The customer map is reloaded through the stub on every call, so each test
// starts from CUSTOMERS_CSV rather than a map cached by an earlier test.
function withLokiStub(routes, fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  resetCustomerMapCache();
  globalThis.fetch = (url) => {
    if (String(url).startsWith("https://api.github.com/")) return githubResponse(String(url));
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
// grafana_logs_link: Gravitee Cloud customers through the customer map
// ---------------------------------------------------------------------------

test("grafana_logs_link: a Cloud customer resolves to its data-plane namespaces through the map", async () => {
  // beacon's namespace carries ids only, so the namespace label cannot find it.
  await withLokiStub(
    {
      [NS_VALUES]: ["april-prod", "apim-dp-cp2222-dp0001", "apim-cp-cp2222"],
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

test("grafana_logs_link: an env word matching no deployment widens to all, and says so", async () => {
  // Regression: the map computed this note and resolveNamespaces dropped it, so
  // the caller got every environment's logs with no sign that "staging" was
  // ignored.
  await withLokiStub(
    {
      [NS_VALUES]: ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp1111-dp0003"],
      [SERIES]: [stream("apim-dp-cp1111-dp0001", "apim-gateway")],
    },
    async () => {
      const out = await callTool("grafana_logs_link", { client: "acme staging" });
      assert.equal(out.resolved_namespaces.length, 3);
      assert.equal(out.env_filter_applied, false);
      assert.deepEqual(out.unknown_qualifiers, ["staging"]);
      assert.deepEqual(out.known_environments, ["dev", "prod", "qa"]);
      assert.match(out.qualifier_note, /"staging" does not describe any deployment of acme/);
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

test("grafana_logs_link: a fragment matching several Cloud customers contributes nothing from the map", async () => {
  // "beac" matches beacon AND beaconlabs. Merging them would return one
  // customer's logs under the other's name, so the map withholds both.
  await withLokiStub(
    { [NS_VALUES]: ["apim-dp-cp2222-dp0001", "apim-dp-cp3333-dp0001"], [SERIES]: [], [SVC_VALUES]: [] },
    async (calls) => {
      const out = await callTool("grafana_logs_link", { client: "beac" });
      assert.deepEqual(out.resolved_namespaces, []);
      assert.equal(out.ambiguous_customer, true);
      assert.deepEqual(out.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
      assert.match(out.customer_note, /matches 2 different customers/);
      const series = decodeURIComponent(calls.find((u) => u.includes(SERIES)));
      assert.ok(!series.includes("apim-dp-"), series);
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
  // april is hosted: no Cockpit organizations to narrow. Ignoring the id would
  // search april-prod, or every service_name, as if the id had been applied.
  await withLokiStub({ [NS_VALUES]: ["april-prod"], [SERIES]: [], [SVC_VALUES]: [] }, async (calls) => {
    const out = await callTool("grafana_logs_link", { client: "april", control_plane_id: "cp1111" });
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
  await withLokiStub({ [NS_VALUES]: ["april-prod"] }, async () => {
    const out = await callTool("grafana_find_customer", { query: "zzxqq" });
    assert.deepEqual(out.gravitee_cloud_customers, []);
    assert.deepEqual(out.hosted_namespaces, []);
    assert.match(out.note, /No Gravitee Cloud customer/);
  });
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

