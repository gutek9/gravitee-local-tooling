import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCustomerCsv } from "./customerCsv.js";
import { resolveClient, resolutionReport, findCustomerMatches } from "./customerResolver.js";

// Made-up Gravitee Cloud customers, with the real CSV header (same names as
// server.test.js, plus one customer on two organizations).
//   acme        one Cockpit organization, three data planes (prod, dev, qa)
//   beacon,     two distinct customers that a fragment like "beac" matches
//   beaconlabs  together
//   northwind   one name, two Cockpit organizations
const CUSTOMERS_CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-acme.us-aws-us-east-1.gateway.gravitee.io
acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,dev-org-acme.us-aws-us-east-1.gateway.gravitee.io
acme,cp1111,cp1111-dp0003,unitedstates,aws,us-east-1,None,qa-org-acme.us-aws-us-east-1.gateway.gravitee.io
beacon,cp2222,cp2222-dp0001,europe,az,westeurope,None,prod-org-beacon.eu-az-westeurope.gateway.gravitee.io
beaconlabs,cp3333,cp3333-dp0001,europe,az,westeurope,None,prod-org-beaconlabs.eu-az-westeurope.gateway.gravitee.io
northwind,cp5555,cp5555-dp0001,europe,az,westeurope,None,prod-org-northwind.eu-az-westeurope.gateway.gravitee.io
northwind,cp6666,cp6666-dp0001,unitedstates,aws,us-east-1,None,dev-org-northwind-b.us-aws-us-east-1.gateway.gravitee.io
`;

const MAP = {
  rows: parseCustomerCsv(CUSTOMERS_CSV),
  source: "github",
  generated_at: "2026-10-11T00:00:00Z",
  generated_days_ago: 2,
};

const ACME_DATA_PLANES = ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp1111-dp0003"];

const resolve = (phrase, namespaceValues = [], extra = {}) => resolveClient({ phrase, namespaceValues, map: MAP, ...extra });

test("resolveClient: a customer both hosted and on Cloud is searched through both routes", () => {
  const out = resolve("acme", ["acme-prod", ...ACME_DATA_PLANES]);
  assert.deepEqual(out.namespaces.sort(), ["acme-prod", ...ACME_DATA_PLANES].sort());
  assert.equal(out.via, "namespace_label+customer_map");
  assert.deepEqual(out.label_namespaces, ["acme-prod"]);
  assert.equal(out.matched_deployments.length, 3);
  assert.equal(out.map_source, "github");
});

test("resolveClient: a Cloud-only customer resolves through the map", () => {
  const out = resolve("beacon", ["apim-dp-cp2222-dp0001"]);
  assert.deepEqual(out.namespaces, ["apim-dp-cp2222-dp0001"]);
  assert.equal(out.via, "customer_map");
  assert.deepEqual(out.label_namespaces, []);
});

test("resolveClient: a hosted-only customer resolves through the label, with no map details", () => {
  const out = resolve("april", ["april-prod", "april-rec", "other-prod"]);
  assert.deepEqual(out.namespaces, ["april-prod", "april-rec"]);
  assert.equal(out.via, "namespace_label");
  assert.equal(out.map_source, undefined);
});

test("resolveClient: an env word narrows the map to that deployment", () => {
  const out = resolve("acme dev", ACME_DATA_PLANES);
  assert.deepEqual(out.namespaces, ["apim-dp-cp1111-dp0002"]);
  assert.equal(out.env_filter_applied, true);
});

test("resolveClient: an ambiguous fragment takes nothing from the map, and names the withheld customers", () => {
  const out = resolve("beac", ["apim-dp-cp2222-dp0001", "apim-dp-cp3333-dp0001"]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.via, "none");
  assert.equal(out.ambiguous_customer, true);
  assert.deepEqual(out.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
  assert.match(out.note, /different customers/);
});

test("resolveClient: nothing matched still reports the map's source and age", () => {
  const out = resolve("zzxqq", ["april-prod"]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.via, "none");
  assert.equal(out.map_source, "github");
  assert.equal(out.map_generated_days_ago, 2);
});

test("resolveClient: a mapped namespace Loki has not seen in the range is flagged", () => {
  const out = resolve("acme", ACME_DATA_PLANES.slice(0, 2));
  assert.deepEqual(out.mapped_namespaces_absent_in_range, ["apim-dp-cp1111-dp0003"]);
});

test("resolveClient: one name over two organizations says so, and control_plane_id narrows to one", () => {
  const values = ["apim-dp-cp5555-dp0001", "apim-dp-cp6666-dp0001"];
  const both = resolve("northwind", values);
  assert.equal(both.namespaces.length, 2);
  assert.equal(both.spans_multiple_organizations, true);
  assert.match(both.organizations_note, /separate Cockpit/);

  const one = resolve("northwind", values, { controlPlaneId: "cp5555" });
  assert.deepEqual(one.namespaces, ["apim-dp-cp5555-dp0001"]);
  assert.equal(one.spans_multiple_organizations, undefined);
});

test("resolutionReport: renames via and note, and leaves out what is not set", () => {
  const report = resolutionReport({
    namespaces: ["x"],
    via: "customer_map",
    note: "why",
    map_source: "github",
    map_warning: null,
    candidates: undefined,
  });
  assert.deepEqual(report, { resolved_via: "customer_map", map_source: "github", customer_note: "why" });
});

test("resolutionReport: every field a resolution sets reaches the report", () => {
  // A field set by resolveClient but missing from the report is silently lost
  // on the way to the caller. Check it across every kind of resolution.
  const resolutions = [
    resolve("acme", ["acme-prod", ...ACME_DATA_PLANES.slice(0, 2)]),
    resolve("beac"),
    resolve("zzxqq"),
    resolve("northwind", ["apim-dp-cp5555-dp0001", "apim-dp-cp6666-dp0001"]),
    { ...resolve("acme", ACME_DATA_PLANES), map_warning: "stale" },
  ];
  const renamed = { via: "resolved_via", note: "customer_note" };
  for (const resolution of resolutions) {
    const report = resolutionReport(resolution);
    for (const [key, value] of Object.entries(resolution)) {
      // `namespaces` is reported by the tool itself, as resolved_namespaces.
      if (key === "namespaces" || value === undefined || value === null) continue;
      assert.ok((renamed[key] || key) in report, `${key} is set by the resolution but missing from the report`);
    }
  }
});

const find = (query, namespaceValues = [], extra = {}) => findCustomerMatches({ query, namespaceValues, map: MAP, ...extra });

test("findCustomerMatches: a name gives the customer's deployments, organizations and namespaces", () => {
  const out = find("acme", ["acme-prod", ...ACME_DATA_PLANES]);
  const [acme] = out.gravitee_cloud_customers;
  assert.equal(acme.customer, "acme");
  assert.equal(acme.deployments, 3);
  assert.deepEqual(acme.organizations, ["cp1111"]);
  assert.deepEqual(acme.envs, ["dev", "prod", "qa"]);
  assert.deepEqual(acme.namespaces, ACME_DATA_PLANES);
  assert.deepEqual(acme.shared_control_plane_namespaces, ["apim-cp-cp1111"]);
  assert.deepEqual(out.hosted_namespaces, ["acme-prod"]);
  assert.equal(out.map_source, "github");
});

test("findCustomerMatches: one name over two organizations says to pass control_plane_id", () => {
  const out = find("northwind");
  assert.equal(out.gravitee_cloud_customers.length, 1);
  assert.match(out.note, /"northwind" spans 2 separate Cockpit organizations \(cp5555, cp6666\)/);
});

test("findCustomerMatches: max_results caps the list and says how many were left out", () => {
  const out = find("beac", [], { maxResults: 1 });
  assert.deepEqual(out.gravitee_cloud_customers.map((c) => c.customer), ["beacon"]);
  assert.equal(out.gravitee_cloud_truncated, 1);
  assert.match(out.note, /matches 2 different Gravitee Cloud customers/);
});

test("findCustomerMatches: a live data plane the map does not attribute is reported apart, never claimed", () => {
  const out = find("acme", [...ACME_DATA_PLANES, "apim-dp-cp1111-dp0099"]);
  const [acme] = out.gravitee_cloud_customers;
  assert.deepEqual(acme.unattributed_namespaces_on_same_control_plane, ["apim-dp-cp1111-dp0099"]);
  assert.ok(!acme.namespaces.includes("apim-dp-cp1111-dp0099"));
});
