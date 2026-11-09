import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GRAFANA_BASE_URL = "https://g.example.com";

const {
  parseCsv,
  groupByCustomer,
  extractEnv,
  parseCustomerCsv,
  matchCustomers,
  lookupById,
  resolveCustomerNamespaces,
  dataPlaneNamespace,
  controlPlaneNamespace,
} = await import("./customerMap.js");

// A faithful slice of the real file, including the parts that break naive
// parsing: quoted URL lists containing commas, an N/A trial row, and a customer
// whose slug is a prefix of another's.
const CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,"callback.acme.example, api.acme.example","api.acme.example, callback.acme.example, prod-org-acme.us-aws-us-east-1.gateway.gravitee.io"
acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,dev-org-acme.us-aws-us-east-1.gateway.gravitee.io
orbit,cp2222,cp2222-dp0004,europe,az,westeurope,None,dev-org-orbit.eu-az-westeurope.gateway.gravitee.io
orbitalis,cp2222,cp2222-999999,europe,az,westeurope,None,dev-org-orbitalis.eu-az-westeurope.gateway.gravitee.io
beacon,cp1111,cp1111-dp0003,unitedstates,aws,us-east-1,None,dev-org-beacon-1700000000000.us-aws-us-east-1.gateway.gravitee.io
N/A,trial,trial-tt0001-dp0011,apac,az,australiaeast,None,*.au.trial-tt0001.gateway.gravitee.io
`;

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

test("parseCsv: a quoted field containing commas stays one field", () => {
  // The URLs column is a quoted comma-separated list. Splitting on "," would
  // shift every column after it, silently mis-assigning ids to customers.
  const rows = parseCsv('a,b,"c,d,e",f\n1,2,"3,4",5\n');
  assert.deepEqual(rows[0], ["a", "b", "c,d,e", "f"]);
  assert.deepEqual(rows[1], ["1", "2", "3,4", "5"]);
});

test("parseCsv: handles escaped quotes and blank lines", () => {
  const rows = parseCsv('a,"say ""hi""",c\n\n\nx,y,z\n');
  assert.deepEqual(rows[0], ["a", 'say "hi"', "c"]);
  assert.deepEqual(rows[1], ["x", "y", "z"]);
  assert.equal(rows.length, 2);
});

// ---------------------------------------------------------------------------
// extractEnv
// ---------------------------------------------------------------------------

test("extractEnv: reads the env from the gravitee gateway host", () => {
  assert.equal(extractEnv("prod-org-acme.us-aws-us-east-1.gateway.gravitee.io"), "prod");
  assert.equal(extractEnv("data-development-org-globex-1749828047293.eu-gcp-europe-west3.gateway.gravitee.io"), "data-development");
});

test("extractEnv: ignores custom DNS and picks the gravitee host from a list", () => {
  // Custom DNS entries sort first in the real file; the env only exists on the
  // gravitee.io host, so the customer's own domain must not be mistaken for it.
  assert.equal(
    extractEnv("api.acme.example, callback.acme.example, prod-org-acme.us-aws-us-east-1.gateway.gravitee.io"),
    "prod",
  );
  assert.equal(extractEnv("None"), null);
  assert.equal(extractEnv("*.au.trial-tt0001.gateway.gravitee.io"), null);
});

// ---------------------------------------------------------------------------
// parseCustomerCsv
// ---------------------------------------------------------------------------

test("parseCustomerCsv: extracts the ids needed to build a namespace", () => {
  const rows = parseCustomerCsv(CSV);
  const prod = rows.find((r) => r.customer === "acme" && r.env === "prod");
  assert.deepEqual(prod, {
    customer: "acme",
    control_plane_id: "cp1111",
    data_plane_id: "cp1111-dp0001",
    region: "unitedstates",
    provider: "aws",
    env: "prod",
  });
});

test("parseCustomerCsv: keeps no customer hostnames", () => {
  // The snapshot is committed to a repo. Resolving a namespace never needs a
  // customer's DNS, so none of it is carried.
  const serialised = JSON.stringify(parseCustomerCsv(CSV));
  assert.ok(!serialised.includes("acme.example"), "customer DNS must not be retained");
  assert.ok(!serialised.includes("gateway.gravitee.io"), "gateway hostnames must not be retained");
});

test("parseCustomerCsv: keeps trials, named by the id they actually have", () => {
  // The CSV has no customer for a trial ("N/A"). Dropping the row made a whole
  // population invisible; instead it is keyed by the trial identifier embedded in
  // the data plane id, which is what someone would search for.
  const trial = parseCustomerCsv(CSV).find((r) => r.is_trial);
  assert.equal(trial.customer, "trial-tt0001");
  assert.equal(trial.data_plane_id, "trial-tt0001-dp0011");
  // Verified against Loki: apim-cp-trial-<id> is the real namespace, so the CSV's
  // literal "trial" control plane id must not be carried through - it would build
  // `apim-cp-trial`, which does not exist.
  assert.equal(trial.control_plane_id, "trial-tt0001");
  assert.equal(controlPlaneNamespace(trial.control_plane_id), "apim-cp-trial-tt0001");
  assert.equal(dataPlaneNamespace(trial.data_plane_id), "apim-dp-trial-tt0001-dp0011");
});

test("resolveCustomerNamespaces: a trial resolves by its identifier", () => {
  const rows = parseCustomerCsv(CSV);
  const out = resolveCustomerNamespaces(rows, { core: "trial-tt0001" });
  assert.ok(out.namespaces.includes("apim-dp-trial-tt0001-dp0011"));
  // ...and by a fragment of it, via the substring fallback.
  assert.ok(resolveCustomerNamespaces(rows, { core: "tt0001" }).namespaces.includes("apim-dp-trial-tt0001-dp0011"));
});

test("resolveCustomerNamespaces: a trial's control plane is searched, a shared one is not", () => {
  // Verified against Loki: every apim-cp-trial-<id> hosts exactly one trial, so
  // it is single-tenant and safe. apim-cp-cp1111 carries three customers and must
  // stay out. The difference is encoded, not left to the namespace matcher.
  const rows = parseCustomerCsv(CSV);
  const trial = resolveCustomerNamespaces(rows, { core: "trial-tt0001" });
  assert.ok(trial.namespaces.includes("apim-cp-trial-tt0001"));
  assert.equal(trial.control_plane_is_single_tenant, true);

  const shared = resolveCustomerNamespaces(rows, { core: "acme" });
  assert.ok(!shared.namespaces.some((n) => n.startsWith("apim-cp-")));
  assert.equal(shared.control_plane_is_single_tenant, undefined);
});

test("parseCustomerCsv: tolerates junk instead of throwing", () => {
  assert.deepEqual(parseCustomerCsv(""), []);
  assert.deepEqual(parseCustomerCsv("nothing,useful\n1,2\n"), []);
});

// ---------------------------------------------------------------------------
// matching + resolution
// ---------------------------------------------------------------------------

test("matchCustomers: an exact slug wins over a substring of another slug", () => {
  // "orbit" must not drag in "orbitalis" - a customer-scoped query returning another
  // customer's logs is a data-boundary problem, not a ranking nicety.
  const rows = parseCustomerCsv(CSV);
  const matched = matchCustomers(rows, "orbit");
  assert.deepEqual([...new Set(matched.map((r) => r.customer))], ["orbit"]);
});

test("matchCustomers: falls back to substring when nothing matches exactly", () => {
  const rows = parseCustomerCsv(CSV);
  assert.deepEqual([...new Set(matchCustomers(rows, "acm").map((r) => r.customer))], ["acme"]);
  assert.deepEqual(matchCustomers(rows, "nosuchcustomer"), []);
  assert.deepEqual(matchCustomers(rows, ""), []);
});

test("resolveCustomerNamespaces: maps a customer to its data-plane namespaces", () => {
  const rows = parseCustomerCsv(CSV);
  const out = resolveCustomerNamespaces(rows, { core: "acme" });
  assert.deepEqual(out.namespaces.sort(), ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002"]);
});

test("resolveCustomerNamespaces: env words narrow to that deployment", () => {
  const rows = parseCustomerCsv(CSV);
  const out = resolveCustomerNamespaces(rows, { core: "acme", envs: ["prod"] });
  assert.deepEqual(out.namespaces, ["apim-dp-cp1111-dp0001"]);
  assert.equal(out.env_filter_applied, true);
});

test("resolveCustomerNamespaces: an env that matches nothing returns all deployments, not none", () => {
  // A customer whose envs are named differently is better served by all of its
  // deployments than by an empty result that reads as "no such customer".
  const rows = parseCustomerCsv(CSV);
  const out = resolveCustomerNamespaces(rows, { core: "acme", envs: ["qa"] });
  assert.equal(out.namespaces.length, 2);
  assert.equal(out.env_filter_applied, false);
});

test("resolveCustomerNamespaces: never searches shared control-plane namespaces by default", () => {
  // apim-cp-cp1111 carries beacon AND acme. Searching it under one
  // customer's name would return the other's logs.
  const rows = parseCustomerCsv(CSV);
  const out = resolveCustomerNamespaces(rows, { core: "acme" });
  assert.ok(!out.namespaces.some((n) => n.startsWith("apim-cp-")), "control plane must not be searched implicitly");
  // ...but it is reported, so the caller knows it exists.
  assert.deepEqual(out.control_plane_namespaces, ["apim-cp-cp1111"]);

  const optedIn = resolveCustomerNamespaces(rows, { core: "acme", includeControlPlane: true });
  assert.ok(optedIn.namespaces.includes("apim-cp-cp1111"));
});

test("resolveCustomerNamespaces: unknown customer resolves to nothing", () => {
  const out = resolveCustomerNamespaces(parseCustomerCsv(CSV), { core: "definitely-not-a-customer" });
  assert.deepEqual(out.namespaces, []);
  assert.deepEqual(out.matched, []);
});

test("namespace builders match the live Loki naming", () => {
  // Verified against the instance: apim-dp-cp1111-dp0001 and apim-cp-cp1111 exist.
  assert.equal(dataPlaneNamespace("cp1111-dp0001"), "apim-dp-cp1111-dp0001");
  assert.equal(controlPlaneNamespace("cp1111"), "apim-cp-cp1111");
});

// ---------------------------------------------------------------------------
// ambiguity
// ---------------------------------------------------------------------------

// Two distinct customers whose slugs share a fragment, plus one customer that
// spans two control planes (i.e. two Cockpit organizations under one name).
const AMBIG = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
northwind,cp3333,cp3333-dp0006,europe,az,westeurope,None,dev-org-northwind.eu-az-westeurope.gateway.gravitee.io
southwind,cp4444,cp4444-dp0007,unitedstates,az,westus2,None,dev-org-southwind.us-az-westus2.gateway.gravitee.io
matt,cp5555,cp5555-dp0008,unitedstates,az,westus2,None,dev-org-matt-a.us.gateway.gravitee.io
matt,cp6666,cp6666-dp0010,unitedstates,az,westus2,None,prod-org-matt-b.us-az-westus2.gateway.gravitee.io
`;

test("resolveCustomerNamespaces: refuses to merge two different customers", () => {
  // "wind" matches northwind AND southwind. Searching both together would return
  // one customer's logs under the other's name.
  const rows = parseCustomerCsv(AMBIG);
  const out = resolveCustomerNamespaces(rows, { core: "wind" });
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.namespaces, [], "nothing may be searched while ambiguous");
  assert.deepEqual(out.candidates.map((c) => c.customer), ["northwind", "southwind"]);
  assert.match(out.reason, /under another's name/);
});

test("resolveCustomerNamespaces: candidates carry enough to choose between them", () => {
  const out = resolveCustomerNamespaces(parseCustomerCsv(AMBIG), { core: "wind" });
  const northwind = out.candidates.find((c) => c.customer === "northwind");
  assert.equal(northwind.deployments, 1);
  assert.deepEqual(northwind.control_planes, ["cp3333"]);
  assert.deepEqual(northwind.regions, ["europe"]);
});

test("resolveCustomerNamespaces: an exact name is never ambiguous", () => {
  const out = resolveCustomerNamespaces(parseCustomerCsv(AMBIG), { core: "northwind" });
  assert.equal(out.ambiguous, undefined);
  assert.deepEqual(out.namespaces, ["apim-dp-cp3333-dp0006"]);
});

test("resolveCustomerNamespaces: one name over several organizations resolves but says so", () => {
  // Distinct from the case above: every row really is "matt", so refusing would
  // block a valid lookup. It resolves - and reports that the name covers two
  // separate Cockpit tenants.
  const out = resolveCustomerNamespaces(parseCustomerCsv(AMBIG), { core: "matt" });
  assert.equal(out.ambiguous, undefined);
  assert.equal(out.namespaces.length, 2);
  assert.equal(out.spans_multiple_organizations, true);
  assert.deepEqual(out.control_plane_ids.sort(), ["cp5555", "cp6666"]);
  assert.match(out.organizations_note, /separate Cockpit/);
});

test("resolveCustomerNamespaces: control_plane_id narrows to one organization", () => {
  const out = resolveCustomerNamespaces(parseCustomerCsv(AMBIG), { core: "matt", controlPlaneId: "cp5555" });
  assert.deepEqual(out.namespaces, ["apim-dp-cp5555-dp0008"]);
  assert.equal(out.spans_multiple_organizations, undefined);
});

test("groupByCustomer: groups rows by slug", () => {
  const groups = groupByCustomer(parseCustomerCsv(AMBIG));
  assert.equal(groups.size, 3);
  assert.equal(groups.get("matt").length, 2);
});

// ---------------------------------------------------------------------------
// lookupById — "whose is this?" from an id seen in an alert
// ---------------------------------------------------------------------------

test("lookupById: a data plane id resolves to its customer", () => {
  const rows = parseCustomerCsv(CSV);
  for (const q of ["cp1111-dp0001", "apim-dp-cp1111-dp0001", "  cp1111-dp0001  "]) {
    const out = lookupById(rows, q);
    assert.equal(out.kind, "data_plane", `failed for ${q}`);
    assert.equal(out.customer, "acme");
  }
});

test("lookupById: a control plane id names every customer on it", () => {
  // apim-cp-cp1111 carries acme AND beacon, so the answer is both, with a
  // warning - not a single customer.
  const out = lookupById(parseCustomerCsv(CSV), "apim-cp-cp1111");
  assert.equal(out.kind, "control_plane");
  assert.deepEqual(out.customers, ["acme", "beacon"]);
  assert.match(out.note, /shared by 2 customers/);
});

test("lookupById: an unlisted data plane falls back to control-plane candidates", () => {
  // The CSV does not list every live data plane. When the specific id is absent
  // but its control plane is known, the field narrows to the customers sharing
  // that control plane - offered as a lead, never as an attribution.
  const out = lookupById(parseCustomerCsv(CSV), "apim-dp-cp1111-ffffff");
  assert.equal(out.kind, "unlisted_data_plane");
  assert.equal(out.control_plane_id, "cp1111");
  assert.deepEqual(out.candidate_customers, ["acme", "beacon"]);
  assert.match(out.note, /a lead, not an attribution/);
});

test("lookupById: a wholly unknown id says so rather than guessing", () => {
  const out = lookupById(parseCustomerCsv(CSV), "apim-dp-zzzzzz-123456");
  assert.equal(out.kind, "unknown");
  assert.match(out.note, /Neither/);
  assert.equal(lookupById(parseCustomerCsv(CSV), ""), null);
});

// ---------------------------------------------------------------------------
// Name and tail, decided by the map rather than a word list
// ---------------------------------------------------------------------------

const { splitNameAndTail } = await import("./customerMap.js");

test("splitNameAndTail: the map decides where the name ends", () => {
  const rows = parseCustomerCsv(CSV);
  assert.deepEqual(splitNameAndTail(rows, "acme"), { core: "acme", tail: [] });
  assert.deepEqual(splitNameAndTail(rows, "acme prod"), { core: "acme", tail: ["prod"] });
  // The point of the change: an environment nobody listed is still a tail.
  assert.deepEqual(splitNameAndTail(rows, "acme gatewaytesting"), { core: "acme", tail: ["gatewaytesting"] });
  assert.deepEqual(splitNameAndTail(rows, "nosuchcustomer at all"), { core: "nosuchcustomer at all", tail: [] });
});

test("resolveCustomerNamespaces: a qualifier narrows by environment, region or provider", () => {
  const rows = parseCustomerCsv(CSV);
  const prod = resolveCustomerNamespaces(rows, { core: "acme", qualifiers: ["prod"] });
  assert.deepEqual(prod.namespaces, ["apim-dp-cp1111-dp0001"]);
  assert.equal(prod.env_filter_applied, true);
  const byRegion = resolveCustomerNamespaces(rows, { core: "acme", qualifiers: ["unitedstates"] });
  assert.equal(byRegion.namespaces.length, 2);
});

test("resolveCustomerNamespaces: a tail that describes nothing is reported, not silently dropped", () => {
  // Enrique's question: what if the removed string matches no environment?
  const rows = parseCustomerCsv(CSV);
  const out = resolveCustomerNamespaces(rows, { core: "acme", qualifiers: ["gatewaytesting"] });
  assert.equal(out.namespaces.length, 2, "all of the customer's deployments, not none");
  assert.deepEqual(out.unknown_qualifiers, ["gatewaytesting"]);
  assert.deepEqual(out.known_environments, ["dev", "prod"]);
  assert.match(out.qualifier_note, /does not describe any deployment of acme/);
});
