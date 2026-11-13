import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCustomerCsv } from "./customerCsv.js";
import { resolveClient, resolutionReport, findCustomerMatches, describeLookupFailure } from "./customerResolver.js";

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
  rows: parseCustomerCsv(CUSTOMERS_CSV).rows,
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

test("resolveClient: a hosted-only customer resolves through the label, and still reports the map's source and age", () => {
  const out = resolve("kestrel", ["kestrel-prod", "kestrel-rec", "other-prod"]);
  assert.deepEqual(out.namespaces, ["kestrel-prod", "kestrel-rec"]);
  assert.equal(out.via, "namespace_label");
  assert.equal(out.map_source, "github");
  assert.equal(out.map_generated_days_ago, 2);
});

// Regression: the map's source and warning were returned only when the map
// itself resolved a namespace. When the label route alone answered, a failed or
// fallback map vanished from the result, and a partial result read as complete.
test("resolveClient: an unavailable map is reported even when the label route finds the customer", () => {
  const unavailable = {
    rows: [],
    source: "unavailable",
    generated_at: null,
    warning: "Customer mapping is unavailable (GitHub unreachable and no usable bundled snapshot).",
  };
  // acme's data planes are in Loki, but without the map nothing ties them to acme.
  const out = resolveClient({ phrase: "acme", namespaceValues: ["acme-prod", ...ACME_DATA_PLANES], map: unavailable });
  assert.deepEqual(out.namespaces, ["acme-prod"]);
  assert.equal(out.via, "namespace_label");
  const report = resolutionReport(out);
  assert.equal(report.map_source, "unavailable");
  assert.match(report.map_warning, /Customer mapping is unavailable/);
});

test("resolveClient: a snapshot fallback's warning is kept when only the label route finds the customer", () => {
  const snapshot = {
    ...MAP,
    source: "bundled_snapshot",
    generated_days_ago: 45,
    warning: "Customer mapping came from the bundled snapshot, because GitHub could not be reached.",
  };
  const out = resolveClient({ phrase: "kestrel", namespaceValues: ["kestrel-prod"], map: snapshot });
  assert.equal(out.via, "namespace_label");
  const report = resolutionReport(out);
  assert.equal(report.map_source, "bundled_snapshot");
  assert.equal(report.map_generated_days_ago, 45);
  assert.match(report.map_warning, /bundled snapshot/);
});

test("resolveClient: an env word narrows the map to that deployment", () => {
  const out = resolve("acme dev", ACME_DATA_PLANES);
  assert.deepEqual(out.namespaces, ["apim-dp-cp1111-dp0002"]);
  assert.equal(out.env_filter_applied, true);
});

test("resolveClient: an env word is not absorbed into another customer's name", () => {
  // Regression: with acmedevices in the map, "acme dev" resolved to acmedevices'
  // prod data plane and never searched acme.
  const map = {
    ...MAP,
    rows: parseCustomerCsv(
      CUSTOMERS_CSV +
        "acmedevices,cp1111,cp1111-dp0009,unitedstates,aws,us-east-1,None,prod-org-acmedevices.us-aws-us-east-1.gateway.gravitee.io\n",
    ).rows,
  };
  const out = resolveClient({ phrase: "acme dev", namespaceValues: [...ACME_DATA_PLANES, "apim-dp-cp1111-dp0009"], map });
  assert.deepEqual(out.namespaces, ["apim-dp-cp1111-dp0002"]);
  assert.deepEqual([...new Set(out.matched_deployments.map((d) => d.customer))], ["acme"]);
  assert.equal(out.env_filter_applied, true);
});

test("resolveClient: prod is not read inside nonprod or preprod", () => {
  // Regression: "orbit prod" searched orbit-nonprod and orbit-preprod.
  const out = resolve("orbit prod", ["orbit-nonprod", "orbit-preprod"]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.refused, true);
  assert.deepEqual(out.unknown_qualifiers, ["prod"]);
  assert.deepEqual(out.skipped_namespaces, ["orbit-nonprod", "orbit-preprod"]);
});

// ---------------------------------------------------------------------------
// One customer per answer
// ---------------------------------------------------------------------------

test("resolveClient: a hosted name that only contains a Cloud customer's whole name is set aside, not searched", () => {
  // Regression: "acme" also searched another customer's acmecorp-*, and "acme
  // dev" searched acmecorp-dev next to acme's dev deployment.
  const values = ["acmecorp-prod", "acmecorp-dev", ...ACME_DATA_PLANES];
  const out = resolve("acme", values);
  assert.deepEqual(out.namespaces, ACME_DATA_PLANES);
  assert.equal(out.via, "customer_map");
  assert.deepEqual(out.similar_names_not_searched, [{ customer: "acmecorp", kind: "hosted" }]);
  assert.match(out.note, /acmecorp only partly matches "acme", which is another customer's whole name/);
  assert.deepEqual(resolve("acme dev", values).namespaces, ["apim-dp-cp1111-dp0002"]);
  // Nor is it named as skipped when a word is refused.
  const refused = resolve("acme staging", values);
  assert.equal(refused.refused, true);
  assert.equal(refused.skipped_namespaces, undefined);
});

test("resolveClient: a Cloud name that only contains a hosted customer's whole name is set aside, not searched", () => {
  // "north" is a hosted customer's whole name; northwind on Cloud only contains it.
  const out = resolve("north", ["north-prod", "apim-dp-cp5555-dp0001", "apim-dp-cp6666-dp0001"]);
  assert.deepEqual(out.namespaces, ["north-prod"]);
  assert.equal(out.via, "namespace_label");
  assert.deepEqual(out.similar_names_not_searched, [{ customer: "northwind", kind: "gravitee_cloud" }]);
});

test("resolveClient: with a control_plane_id, a hosted whole name does not set the Cloud customer aside", () => {
  // The id asks for a Cloud organization and confirms the customer; a hosted
  // namespace is on none, so "north" here can only mean northwind's.
  const out = resolve("north", ["north-prod", "apim-dp-cp5555-dp0001"], { controlPlaneId: "cp5555" });
  assert.deepEqual(out.namespaces, ["apim-dp-cp5555-dp0001"]);
  assert.equal(out.partial_name_match, true);
  assert.match(out.note, /it matches only part of northwind's name, so it was searched as northwind/);
  assert.deepEqual(out.skipped_namespaces, ["north-prod"]);
  // An id that is not the customer's is still refused.
  assert.equal(resolve("north", ["north-prod"], { controlPlaneId: "cp9999" }).refused, true);
});

test("resolveClient: hosted namespaces of two customers are refused, with the candidates", () => {
  // Regression: whole segments shared by two customers searched both.
  const out = resolve("plt live", ["nova-plt-live", "nova-plt-live-ap", "vega-plt-live"]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.refused, true);
  assert.equal(out.ambiguous_customer, true);
  assert.deepEqual(out.candidates, [
    { customer: "nova", kind: "hosted", namespace_count: 2 },
    { customer: "vega", kind: "hosted", namespace_count: 1 },
  ]);
  assert.match(out.note, /matches 2 different customers \(nova, vega\)/);
  // Regression: part of a name searched two hosted customers while the note said
  // only the namespaces named after it were searched.
  const beac = resolve("beac", ["beacon-hosted-prod", "beaconlabs-prod"]);
  assert.equal(beac.refused, true);
  assert.deepEqual(beac.namespaces, []);
});

test("resolveClient: part of a name matching a hosted and a different Cloud customer is refused", () => {
  // Regression: "acm" searched hosted acmecorp and Cloud acme together.
  const out = resolve("acm", ["acmecorp-prod", ...ACME_DATA_PLANES]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.refused, true);
  assert.deepEqual(
    out.candidates.map((c) => [c.customer, c.kind]),
    [["acme", "gravitee_cloud"], ["acmecorp", "hosted"]],
  );
});

test("resolveClient: part of a name is not trusted when one source could not be read", () => {
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  // Without the map, nothing shows that "acme" is not a Cloud customer's whole name.
  const mapDown = resolveClient({ phrase: "acme", namespaceValues: ["acmecorp-prod"], map: unavailable });
  assert.equal(mapDown.refused, true);
  assert.equal(mapDown.partial_match_unchecked, true);
  assert.deepEqual(mapDown.namespaces, []);
  assert.match(mapDown.note, /customer map could not be read/);
  // Without Loki's list, nothing shows that "acm" is not a hosted customer's.
  const lokiDown = resolve("acm", null);
  assert.equal(lokiDown.refused, true);
  assert.equal(lokiDown.partial_match_unchecked, true);
  assert.match(lokiDown.note, /Loki did not return its namespace list/);
  // A whole name still resolves with one source down.
  assert.deepEqual(resolve("acme", null).namespaces, ACME_DATA_PLANES);
});

test("resolveClient: nothing found with a source down is refused, not left to a service_name search", () => {
  // Regression: a phrase neither route found fell to the service_name search
  // even when a route could not run: "orbit dev" with Loki's namespace list
  // down linked another customer's orbitalpay-dev in a shared namespace.
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  const lokiDown = resolve("orbit dev", null);
  assert.equal(lokiDown.refused, true);
  assert.deepEqual(lokiDown.namespaces, []);
  assert.equal(lokiDown.namespace_lookup_failed, true);
  assert.match(lokiDown.note, /^Loki did not return its namespace list, so "orbit dev" could not be matched/);
  assert.match(lokiDown.note, /Nothing was searched/);
  const mapDown = resolveClient({ phrase: "zzxqq", namespaceValues: ["orbit-prod"], map: unavailable });
  assert.equal(mapDown.refused, true);
  assert.equal(mapDown.map_source, "unavailable");
  assert.match(mapDown.note, /^The customer map could not be read/);
  assert.match(mapDown.note, /pass a data plane's full namespace/);
  const bothDown = resolveClient({ phrase: "zzxqq", namespaceValues: null, map: unavailable });
  assert.equal(bothDown.refused, true);
  assert.match(bothDown.note, /^Neither Loki's namespace list nor the customer map could be read/);
  // A data plane's own id the map knows still gets its full namespace, not this refusal.
  assert.deepEqual(resolve("dp0002", null).matched_by_id.data_planes, [
    { namespace: "apim-dp-cp1111-dp0002", customer: "acme" },
  ]);
});

test("describeLookupFailure: a retry can help only for a timeout, a network error, 408, 429 or a 5xx", () => {
  const httpError = (status) => Object.assign(new Error(`Grafana GET /x failed with HTTP ${status}`), { status });
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(describeLookupFailure(httpError(status)).retryable, true, `HTTP ${status}`);
  }
  for (const status of [400, 401, 403, 404]) {
    assert.equal(describeLookupFailure(httpError(status)).retryable, false, `HTTP ${status}`);
  }
  assert.equal(describeLookupFailure(httpError(404)).reason, "Grafana GET /x failed with HTTP 404");
  // No status: fetch's own errors, a dropped connection or the client's timeout.
  assert.deepEqual(describeLookupFailure(new TypeError("fetch failed")), { reason: "fetch failed", retryable: true });
  assert.deepEqual(describeLookupFailure(new DOMException("This operation was aborted", "AbortError")), {
    reason: "This operation was aborted",
    retryable: true,
  });
});

test("resolveClient: a failed Loki lookup gives its reason, and retry advice only when a retry can help", () => {
  // Regression: the reason was dropped, and the refusal said "Retry in a
  // moment." also for a 404 (the uid set to the datasource's display name) or a
  // 401, which no retry fixes.
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  const notFound = { reason: "Grafana GET /x failed with HTTP 404", retryable: false };
  const busy = { reason: "Grafana GET /x failed with HTTP 503", retryable: true };
  const retryAdvice = /Retry (in a moment|once)/;

  const permanent = resolve("orbit dev", null, { lookupFailure: notFound });
  assert.equal(permanent.refused, true);
  assert.match(permanent.note, /^Loki did not return its namespace list \(Grafana GET \/x failed with HTTP 404\), so "orbit dev"/);
  assert.match(
    permanent.note,
    /A retry will not fix this: check GRAFANA_LOGS_DATASOURCE_UID \(the datasource's uid, not its display name\) and GRAFANA_TOKEN in \.env\./,
  );
  assert.match(permanent.note, /restart your agent/);
  assert.doesNotMatch(permanent.note, retryAdvice);
  assert.match(permanent.namespace_lookup_note, /namespace list \(Grafana GET \/x failed with HTTP 404\), so hosted customers/);

  const passing = resolve("orbit dev", null, { lookupFailure: busy });
  assert.match(passing.note, /namespace list \(Grafana GET \/x failed with HTTP 503\), so "orbit dev"/);
  assert.match(passing.note, /Retry in a moment\.$/);

  // A whole name still resolves, and the reason still reaches the caller.
  const mapped = resolve("acme", null, { lookupFailure: notFound });
  assert.deepEqual(mapped.namespaces, ACME_DATA_PLANES);
  assert.match(mapped.namespace_lookup_note, /HTTP 404/);

  // With the map down too, the note keeps Loki's reason and points at
  // map_warning for the map's; a Loki failure no retry fixes keeps both pieces
  // of advice.
  const bothPermanent = resolveClient({ phrase: "zzxqq", namespaceValues: null, map: unavailable, lookupFailure: notFound });
  assert.match(
    bothPermanent.note,
    /^Neither Loki's namespace list \(Grafana GET \/x failed with HTTP 404\) nor the customer map could be read/,
  );
  assert.match(
    bothPermanent.note,
    /A retry will not fix Loki's part: check GRAFANA_LOGS_DATASOURCE_UID .* GRAFANA_TOKEN in \.env; map_warning says why the map could not be read\./,
  );
  assert.doesNotMatch(bothPermanent.note, retryAdvice);
  const bothPassing = resolveClient({ phrase: "zzxqq", namespaceValues: null, map: unavailable, lookupFailure: busy });
  assert.match(bothPassing.note, /^Neither Loki's namespace list \(Grafana GET \/x failed with HTTP 503\) nor/);
  assert.match(bothPassing.note, /Retry once both can be read \(map_warning says why the map could not\)\.$/);
});

test("resolveClient: a stale snapshot counts as an answer, so the service_name search stays open", () => {
  // Guards the rule: only an unavailable map blocks it. A snapshot answered,
  // and its warning says how old it is.
  const snapshot = { ...MAP, source: "bundled_snapshot", warning: "from the snapshot" };
  const out = resolveClient({ phrase: "lumen", namespaceValues: ["prod", "orbit-prod"], map: snapshot });
  assert.equal(out.refused, undefined);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.via, "none");
  assert.equal(out.map_warning, "from the snapshot");
});

test("resolveClient: an unreadable map is never reported as a name or an id missing from it", () => {
  // Regression: with the map unavailable the notes said "not in the customer
  // map" or "the map does not say whose", and "Drop control_plane_id" invited
  // the broader search the id was there to prevent.
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  const mapDown = (phrase, namespaceValues, extra = {}) =>
    resolveClient({ phrase, namespaceValues, map: unavailable, ...extra });
  const [withId, dataPlane, dataPlaneWithId, controlPlane] = [
    mapDown("acme", ["acme-prod", ...ACME_DATA_PLANES], { controlPlaneId: "cp1111" }),
    mapDown("apim-dp-cp1111-dp0001", ACME_DATA_PLANES),
    mapDown("apim-dp-cp1111-dp0001", ACME_DATA_PLANES, { controlPlaneId: "cp1111" }),
    mapDown("cp1111", ["apim-cp-cp1111", ...ACME_DATA_PLANES]),
  ];
  for (const out of [withId, dataPlane, dataPlaneWithId, controlPlane]) {
    assert.match(out.note, /customer map could not be read \(map_warning says why\)/, out.note);
    assert.doesNotMatch(
      out.note,
      /not in the customer map|not one in the customer map|does not say whose|Drop control_plane_id|Pass the customer's name/,
      out.note,
    );
  }
  // What each one does is unchanged: only the data plane alone is searched.
  assert.equal(withId.refused, true);
  assert.deepEqual(dataPlane.namespaces, ["apim-dp-cp1111-dp0001"]);
  assert.equal(dataPlane.owner_unknown, true);
  assert.equal(dataPlaneWithId.refused, true);
  assert.equal(controlPlane.refused, true);
});

test("resolveClient: part of a name that names one customer is searched, and says so", () => {
  // beaconlabs is hosted and on Cloud: one customer, both routes.
  const out = resolve("beaconl", ["beaconlabs-prod", "apim-dp-cp3333-dp0001"]);
  assert.deepEqual(out.namespaces, ["beaconlabs-prod", "apim-dp-cp3333-dp0001"]);
  assert.equal(out.partial_name_match, true);
  assert.match(
    out.note,
    /"beaconl" is not a whole customer name: it matches only part of beaconlabs's namespace names, so it was searched as beaconlabs/,
  );
});

test("resolveClient: a word found only after a hosted namespace's first segment is part of its name, never its owner's", () => {
  // Regression: `zeta-nova-prod` is zeta's, yet "nova" matched it as a whole
  // name: it was searched with no note, it outranked a Cloud partial match with
  // a note calling it a whole name, and with the map down it was not refused.
  const one = resolve("nova", ["zeta-nova-prod", "zeta-prod"]);
  assert.deepEqual(one.namespaces, ["zeta-nova-prod"]);
  assert.equal(one.partial_name_match, true);
  assert.match(one.note, /it matches only part of zeta's namespace names, so it was searched as zeta/);
  // Regression: "nova prod" searched zeta's namespace as nova's prod. nova's own
  // namespace is found by dropping "prod", which it lacks, so it is refused.
  const owner = resolve("nova prod", ["nova-dev", "zeta-nova-prod"]);
  assert.equal(owner.refused, true);
  assert.deepEqual(owner.namespaces, []);
  // Regression: a Cloud customer's exact name was refused as two customers
  // because another customer's namespace carries it as a later segment.
  const cloud = resolve("beacon", ["blue-x-beacon-1", "apim-dp-cp2222-dp0001"]);
  assert.deepEqual(cloud.namespaces, ["apim-dp-cp2222-dp0001"]);
  assert.deepEqual(cloud.similar_names_not_searched, [{ customer: "blue", kind: "hosted" }]);
  // Part of a hosted name and part of a Cloud name: two customers, refused.
  const both = resolve("north", ["zeta-north-prod", "apim-dp-cp5555-dp0001"]);
  assert.equal(both.refused, true);
  assert.deepEqual(
    both.candidates.map((c) => [c.customer, c.kind]),
    [["northwind", "gravitee_cloud"], ["zeta", "hosted"]],
  );
  // With the map down, nothing shows "nova" is not a Cloud customer's whole name.
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  const mapDown = resolveClient({ phrase: "nova", namespaceValues: ["zeta-nova-prod"], map: unavailable });
  assert.equal(mapDown.refused, true);
  assert.equal(mapDown.partial_match_unchecked, true);
});

test("resolveClient: candidates are capped, and say how many were left out", () => {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const name = `zed${String(i).padStart(2, "0")}`;
    return `${name},cp9${i},cp9${i}-dp0001,europe,az,westeurope,None,prod-org-${name}.eu-az-westeurope.gateway.gravitee.io`;
  });
  const map = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + rows.join("\n") + "\n").rows };
  const out = resolveClient({ phrase: "zed", namespaceValues: [], map });
  assert.equal(out.refused, true);
  assert.equal(out.candidates.length, 10);
  assert.equal(out.candidates_truncated, 2);
  assert.match(out.note, /zed09 and 2 more\)/);
});

// ---------------------------------------------------------------------------
// Cloud namespaces only through the map, ids through lookupById
// ---------------------------------------------------------------------------

test("resolveClient: a control-plane id typed into client is refused, never searched", () => {
  // Regression: "cp1111" matched the shared apim-cp-cp1111 and every data plane
  // on it as whole segments, and searched them all.
  const out = resolve("cp1111", ["apim-cp-cp1111", ...ACME_DATA_PLANES]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.refused, true);
  assert.deepEqual(out.matched_by_id, { kind: "control_plane", id: "cp1111", customers: ["acme"] });
  assert.match(out.note, /never searched under one customer's name/);
  // The same for a control plane the map does not know.
  const unknown = resolve("cp9999", ["apim-cp-cp9999", "apim-dp-cp9999-dp0001"]);
  assert.equal(unknown.refused, true);
  assert.deepEqual(unknown.namespaces, []);
});

test("resolveClient: a data-plane id resolves through the map to that data plane and its customer", () => {
  // Regression: it was searched as a hosted namespace, without saying whose.
  for (const id of ["apim-dp-cp1111-dp0002", "cp1111-dp0002"]) {
    const out = resolve(id, ACME_DATA_PLANES);
    assert.deepEqual(out.namespaces, ["apim-dp-cp1111-dp0002"], id);
    assert.equal(out.via, "customer_map");
    assert.deepEqual(out.matched_by_id, { kind: "data_plane", id: "cp1111-dp0002", customer: "acme" });
    assert.deepEqual(out.matched_deployments.map((d) => d.customer), ["acme"]);
  }
  // control_plane_id only narrows: another organization is refused.
  const other = resolve("cp1111-dp0002", ACME_DATA_PLANES, { controlPlaneId: "cp5555" });
  assert.equal(other.refused, true);
  assert.equal(other.unknown_control_plane, true);
});

test("resolveClient: a data plane the map does not know is searched alone, owner unknown", () => {
  const out = resolve("cp9999-dp0001", ["apim-dp-cp9999-dp0001", "apim-dp-cp9999-dp0002"]);
  assert.deepEqual(out.namespaces, ["apim-dp-cp9999-dp0001"]);
  assert.equal(out.owner_unknown, true);
  assert.match(out.note, /not in the customer map, so whose it is cannot be said/);
  // On a control plane the map knows, its customers are a lead, not an answer.
  const lead = resolve("cp1111-dp0099", ["apim-dp-cp1111-dp0099"]);
  assert.deepEqual(lead.namespaces, ["apim-dp-cp1111-dp0099"]);
  assert.deepEqual(lead.matched_by_id.candidate_customers, ["acme"]);
  // Neither in the map nor in Loki: refused, not left to a service_name search.
  assert.equal(resolve("cp1111-dp0099", ACME_DATA_PLANES).refused, true);
});

test("resolveClient: the namespace label route leaves out Cloud namespaces", () => {
  // Regression: "apim cp" read every control-plane namespace as one customer's.
  const out = resolve("apim cp", ["apim-cp-cp1111", "apim-cp-cp2222"]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.via, "none");
});

test("resolveClient: a data plane's own id alone is refused with its full namespace, never searched", () => {
  // Regression: "dp0002" resolved to nothing and fell to the service_name
  // search, which reaches apim-dp-cp1111-dp0002 through its service names
  // without saying whose it is.
  const one = resolve("dp0002", ACME_DATA_PLANES);
  assert.equal(one.refused, true);
  assert.deepEqual(one.namespaces, []);
  assert.deepEqual(one.matched_by_id, {
    kind: "data_plane_id_only",
    id: "dp0002",
    data_planes: [{ namespace: "apim-dp-cp1111-dp0002", customer: "acme" }],
  });
  assert.match(one.note, /data plane apim-dp-cp1111-dp0002 \(acme\)\. Nothing was searched: pass the full namespace/);
  // Several data planes share the id: all listed, a Loki-only one without a customer.
  const several = resolve("dp0001", ["apim-dp-cp1111-dp0001", "apim-dp-cp9999-dp0001"]);
  assert.equal(several.refused, true);
  assert.deepEqual(
    several.matched_by_id.data_planes.map((d) => [d.namespace, d.customer]),
    [
      ["apim-dp-cp1111-dp0001", "acme"],
      ["apim-dp-cp2222-dp0001", "beacon"],
      ["apim-dp-cp3333-dp0001", "beaconlabs"],
      ["apim-dp-cp5555-dp0001", "northwind"],
      ["apim-dp-cp6666-dp0001", "northwind"],
      ["apim-dp-cp9999-dp0001", undefined],
    ],
  );
  assert.match(several.note, /is the id of 6 data planes/);
});

test("resolveClient: a customer called like a data plane id is found by name, not refused as an id", () => {
  // Guards where the id check sits: only once neither route found anything.
  const out = resolve("dp0002", ["dp0002-prod", ...ACME_DATA_PLANES]);
  assert.equal(out.refused, undefined);
  assert.deepEqual(out.namespaces, ["dp0002-prod"]);
  assert.equal(out.via, "namespace_label");
});

test("resolveClient: a trial is named by its control-plane id, and resolves as that customer", () => {
  // Guards the order in resolveById: a name the map has whole comes before an id.
  const map = {
    ...MAP,
    rows: parseCustomerCsv(
      CUSTOMERS_CSV + "N/A,trial,trial-tt0001-dp0011,apac,az,australiaeast,None,*.au.trial-tt0001.gateway.gravitee.io\n",
    ).rows,
  };
  const out = resolveClient({
    phrase: "trial-tt0001",
    namespaceValues: ["apim-dp-trial-tt0001-dp0011", "apim-cp-trial-tt0001"],
    map,
  });
  assert.equal(out.refused, undefined);
  assert.deepEqual(out.namespaces, ["apim-dp-trial-tt0001-dp0011", "apim-cp-trial-tt0001"]);
  assert.equal(out.via, "customer_map");
});

test("a trial's control plane is its own in every answer, never called shared", () => {
  // Regression: it was searched with the trial yet listed in
  // shared_control_plane_namespaces, and the flag saying why never reached the
  // answer. A trial's data plane id and find_customer called it shared too.
  const map = {
    ...MAP,
    rows: parseCustomerCsv(
      CUSTOMERS_CSV + "N/A,trial,trial-tt0001-dp0011,apac,az,australiaeast,None,*.au.trial-tt0001.gateway.gravitee.io\n",
    ).rows,
  };
  const live = ["apim-dp-trial-tt0001-dp0011", "apim-cp-trial-tt0001", ...ACME_DATA_PLANES, "apim-cp-cp1111"];

  const byName = resolutionReport(resolveClient({ phrase: "trial-tt0001", namespaceValues: live, map }));
  assert.deepEqual(byName.shared_control_plane_namespaces, []);
  assert.equal(byName.control_plane_is_single_tenant, true);

  const byDataPlane = resolveClient({ phrase: "trial-tt0001-dp0011", namespaceValues: live, map });
  assert.deepEqual(byDataPlane.namespaces, ["apim-dp-trial-tt0001-dp0011"], "a data plane id searches only that data plane");
  assert.deepEqual(byDataPlane.shared_control_plane_namespaces, []);

  const [found] = findCustomerMatches({ query: "trial-tt0001", namespaceValues: live, map }).gravitee_cloud_customers;
  assert.deepEqual(found.namespaces, ["apim-dp-trial-tt0001-dp0011", "apim-cp-trial-tt0001"]);
  assert.deepEqual(found.shared_control_plane_namespaces, []);
  assert.equal(found.control_plane_is_single_tenant, true);

  // A shared control plane stays shared, unsearched and unflagged.
  const acme = resolveClient({ phrase: "acme", namespaceValues: live, map });
  assert.ok(!acme.namespaces.includes("apim-cp-cp1111"));
  assert.deepEqual(resolutionReport(acme).shared_control_plane_namespaces, ["apim-cp-cp1111"]);
  assert.equal(resolutionReport(acme).control_plane_is_single_tenant, undefined);
});

const TRIAL_ROW = "N/A,trial,trial-tt0001-dp0011,apac,az,australiaeast,None,*.au.trial-tt0001.gateway.gravitee.io\n";
const TRIAL_MAP = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + TRIAL_ROW).rows };
const TRIAL_LIVE = ["apim-dp-trial-tt0001-dp0011", "apim-cp-trial-tt0001", ...ACME_DATA_PLANES, "apim-cp-cp1111"];

test("resolveClient: a trial's control plane typed as client is searched alone, as the trial's", () => {
  // Regression: it was refused as shared by every customer on it.
  for (const phrase of ["apim-cp-trial-tt0001", "APIM-CP-TRIAL-TT0001"]) {
    const out = resolveClient({ phrase, namespaceValues: TRIAL_LIVE, map: TRIAL_MAP });
    assert.equal(out.refused, undefined, phrase);
    assert.deepEqual(out.namespaces, ["apim-cp-trial-tt0001"], phrase);
    assert.equal(out.via, "customer_map");
    assert.deepEqual(out.matched_by_id, { kind: "control_plane", id: "trial-tt0001", customer: "trial-tt0001" });
    assert.equal(out.control_plane_is_single_tenant, true);
    assert.deepEqual(out.shared_control_plane_namespaces, []);
    assert.deepEqual(out.control_plane_ids, ["trial-tt0001"]);
    assert.deepEqual(out.label_namespaces, []);
    assert.equal(out.mapped_namespaces_absent_in_range, undefined);
    assert.equal(
      out.note,
      "apim-cp-trial-tt0001 is trial-tt0001's own control plane, which hosts only that trial, so only it was " +
        'searched. Pass client "trial-tt0001" to search the whole trial.',
    );
  }
  // Its own id narrows to it; another one is refused.
  const own = resolveClient({ phrase: "apim-cp-trial-tt0001", namespaceValues: TRIAL_LIVE, map: TRIAL_MAP, controlPlaneId: "trial-tt0001" });
  assert.deepEqual(own.namespaces, ["apim-cp-trial-tt0001"]);
  const other = resolveClient({ phrase: "apim-cp-trial-tt0001", namespaceValues: TRIAL_LIVE, map: TRIAL_MAP, controlPlaneId: "cp1111" });
  assert.equal(other.refused, true);
  assert.deepEqual(other.namespaces, []);
  assert.equal(other.unknown_control_plane, true);
  assert.equal(other.requested_control_plane_id, "cp1111");
  assert.deepEqual(other.control_plane_ids, ["trial-tt0001"]);
  assert.equal(other.note, 'apim-cp-trial-tt0001 is control plane trial-tt0001, not "cp1111". Nothing was searched.');
  // Not in Loki in this range: searched anyway and flagged, like a mapped data plane.
  const absent = resolveClient({ phrase: "apim-cp-trial-tt0001", namespaceValues: ACME_DATA_PLANES, map: TRIAL_MAP });
  assert.deepEqual(absent.namespaces, ["apim-cp-trial-tt0001"]);
  assert.deepEqual(absent.mapped_namespaces_absent_in_range, ["apim-cp-trial-tt0001"]);
  // Loki's namespace list missing: the map alone answers, and nothing is called absent.
  const lokiDown = resolveClient({ phrase: "apim-cp-trial-tt0001", namespaceValues: null, map: TRIAL_MAP });
  assert.deepEqual(lokiDown.namespaces, ["apim-cp-trial-tt0001"]);
  assert.equal(lokiDown.namespace_lookup_failed, true);
  assert.equal(lokiDown.mapped_namespaces_absent_in_range, undefined);
});

test("resolveClient: a trial's control plane the map does not list, or cannot read, is searched alone when Loki has it", () => {
  // Regression: refused as "shared by every customer on that organization".
  const live = ["apim-cp-trial-tt9999", "apim-dp-trial-tt9999-dp0001", ...ACME_DATA_PLANES];
  for (const phrase of ["apim-cp-trial-tt9999", "trial-tt9999"]) {
    const out = resolveClient({ phrase, namespaceValues: live, map: TRIAL_MAP });
    assert.equal(out.refused, undefined, phrase);
    assert.deepEqual(out.namespaces, ["apim-cp-trial-tt9999"], phrase);
    assert.equal(out.via, "namespace_label");
    assert.equal(out.owner_unknown, true);
    assert.deepEqual(out.matched_by_id, { kind: "unknown", id: "trial-tt9999" });
    assert.equal(out.control_plane_is_single_tenant, true);
    assert.deepEqual(out.shared_control_plane_namespaces, []);
    assert.deepEqual(out.label_namespaces, ["apim-cp-trial-tt9999"]);
    assert.equal(
      out.note,
      "apim-cp-trial-tt9999 is in Loki but not in the customer map; it is a trial's own control plane, which hosts " +
        "only that trial, so only it was searched. The trial's data planes are searched by their full namespace (apim-dp-...).",
    );
  }
  // An unreadable map looked nothing up: the note never says "not in the customer map".
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  const mapDown = resolveClient({ phrase: "apim-cp-trial-tt0001", namespaceValues: TRIAL_LIVE, map: unavailable });
  assert.deepEqual(mapDown.namespaces, ["apim-cp-trial-tt0001"]);
  assert.equal(mapDown.owner_unknown, true);
  assert.match(mapDown.note, /the customer map could not be read \(map_warning says why\); it is a trial's own control plane/);
  assert.doesNotMatch(mapDown.note, /not in the customer map/);
  // Not in Loki either: it is not searched as a trial's control plane.
  const gone = resolveClient({ phrase: "apim-cp-trial-tt9999", namespaceValues: ACME_DATA_PLANES, map: TRIAL_MAP });
  assert.deepEqual(gone.namespaces, []);
  assert.equal(gone.control_plane_is_single_tenant, undefined);
  // A control plane that is not a trial's stays refused as shared.
  const shared = resolveClient({ phrase: "apim-cp-cp1111", namespaceValues: TRIAL_LIVE, map: TRIAL_MAP });
  assert.equal(shared.refused, true);
  assert.match(shared.note, /shared by every customer on that organization/);
});

test("resolveClient: an ambiguous fragment takes nothing from the map, and names the withheld customers", () => {
  const out = resolve("beac", ["apim-dp-cp2222-dp0001", "apim-dp-cp3333-dp0001"]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.via, "none");
  assert.equal(out.refused, true);
  assert.equal(out.ambiguous_customer, true);
  assert.deepEqual(out.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
  assert.match(out.note, /different customers/);
});

test("resolveClient: nothing matched still reports the map's source and age", () => {
  const out = resolve("zzxqq", ["kestrel-prod"]);
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

test("resolveClient: an unmatched control_plane_id is refused, with the customer's valid ids", () => {
  const out = resolve("northwind", ["apim-dp-cp5555-dp0001", "apim-dp-cp6666-dp0001"], { controlPlaneId: "cp9999" });
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.unknown_control_plane, true);
  assert.equal(out.requested_control_plane_id, "cp9999");
  assert.deepEqual(out.control_plane_ids, ["cp5555", "cp6666"]);
  assert.match(out.note, /"cp9999" is not one of northwind's Cockpit organizations/);
});

test("resolveClient: control_plane_id on a customer the map does not have is refused, even with a label match", () => {
  // The label route alone would search kestrel-prod, which the id was meant to narrow.
  const out = resolve("kestrel", ["kestrel-prod"], { controlPlaneId: "cp1111" });
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.unknown_control_plane, true);
  assert.match(out.note, /only narrows a Gravitee Cloud customer/);
});

test("resolveClient: control_plane_id with an ambiguous name is refused, with the candidates", () => {
  const out = resolve("beac", [], { controlPlaneId: "cp2222" });
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.unknown_control_plane, true);
  assert.equal(out.ambiguous_customer, true);
  assert.deepEqual(out.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
  assert.match(out.note, /was not applied to any of them/);
});

test("resolveClient: a namespace found only by dropping a word is skipped, not searched", () => {
  // "acme dev": no `acme-dev`, so the label route drops "dev" and finds acme-prod.
  const out = resolve("acme dev", ["acme-prod", ...ACME_DATA_PLANES]);
  assert.deepEqual(out.namespaces, ["apim-dp-cp1111-dp0002"]);
  assert.equal(out.via, "customer_map");
  assert.deepEqual(out.label_namespaces, []);
  assert.deepEqual(out.skipped_namespaces, ["acme-prod"]);
});

test("resolveClient: a word that narrows neither route is refused, with what each route has", () => {
  const out = resolve("acme staging", ["acme-prod", ...ACME_DATA_PLANES]);
  assert.deepEqual(out.namespaces, []);
  assert.equal(out.refused, true);
  assert.deepEqual(out.unknown_qualifiers, ["staging"]);
  assert.deepEqual(out.known_environments, ["dev", "prod", "qa"]);
  assert.deepEqual(out.skipped_namespaces, ["acme-prod"]);
  assert.match(out.note, /"staging" is in none of the namespaces found for "acme" \(acme-prod\)/);
  assert.match(out.note, /does not describe any deployment of acme/);
  assert.match(out.note, /pass it as component instead/);
});

test("resolveClient: a hosted namespace that carries every word is searched even when the map has no such deployment", () => {
  // acme-staging names the whole phrase, so the word narrows the label route.
  const out = resolve("acme staging", ["acme-staging", ...ACME_DATA_PLANES]);
  assert.deepEqual(out.namespaces, ["acme-staging"]);
  assert.equal(out.via, "namespace_label");
  assert.equal(out.refused, undefined);
});

test("resolveClient: control_plane_id with a word the customer does not have refuses on the word", () => {
  const out = resolve("acme staging", ACME_DATA_PLANES, { controlPlaneId: "cp1111" });
  assert.equal(out.refused, true);
  assert.deepEqual(out.unknown_qualifiers, ["staging"]);
  assert.equal(out.unknown_control_plane, undefined);
  assert.match(out.note, /"staging" does not describe any deployment of acme/);
});

test("resolveClient: a control_plane_id skips hosted namespaces, even ones that carry the whole name", () => {
  const out = resolve("acme", ["acme-prod", ...ACME_DATA_PLANES], { controlPlaneId: "cp1111" });
  assert.deepEqual(out.namespaces, ACME_DATA_PLANES);
  assert.deepEqual(out.label_namespaces, []);
  assert.deepEqual(out.skipped_namespaces, ["acme-prod"]);
  assert.match(out.skipped_namespaces_note, /a hosted namespace is on no Cockpit organization/);
});

test("resolveClient: control_plane_id with a hosted whole-name match and a word the map lacks refuses on the word", () => {
  // acme-staging carries the whole phrase, but the id rules hosted namespaces
  // out, and the map has no staging: the refusal names the word only.
  const out = resolve("acme staging", ["acme-staging", ...ACME_DATA_PLANES], { controlPlaneId: "cp1111" });
  assert.equal(out.refused, true);
  assert.deepEqual(out.skipped_namespaces, ["acme-staging"]);
  assert.match(out.note, /^"staging" does not describe any deployment of acme/);
});

test("resolveClient: a failed namespace lookup still resolves through the map, and is reported", () => {
  // null is "Loki did not answer", not "no namespaces": nothing may be called
  // absent from Loki on the strength of a lookup that failed.
  const out = resolve("acme", null);
  assert.deepEqual(out.namespaces, ACME_DATA_PLANES);
  assert.equal(out.via, "customer_map");
  assert.equal(out.mapped_namespaces_absent_in_range, undefined);
  assert.equal(out.namespace_lookup_failed, true);
  assert.match(out.namespace_lookup_note, /not checked against Loki/);
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
    resolve("northwind", [], { controlPlaneId: "cp9999" }),
    resolve("beac", [], { controlPlaneId: "cp2222" }),
    resolve("acme dev", ["acme-prod", ...ACME_DATA_PLANES]),
    resolve("acme staging", ["acme-prod", ...ACME_DATA_PLANES]),
    resolve("kestrel staging", ["kestrel-prod", "kestrel-rec"]),
    resolve("acme", null),
    resolve("acme", ["acme-prod", ...ACME_DATA_PLANES], { controlPlaneId: "cp1111" }),
    { ...resolve("acme", ACME_DATA_PLANES), map_warning: "stale" },
    resolve("acme", ["acmecorp-prod", ...ACME_DATA_PLANES]),
    resolve("plt live", ["nova-plt-live", "vega-plt-live"]),
    resolve("acm", null),
    resolve("beaconl", ["beaconlabs-prod"]),
    resolve("cp1111", ["apim-cp-cp1111", ...ACME_DATA_PLANES]),
    resolve("cp1111-dp0002", ACME_DATA_PLANES.slice(0, 1)),
    resolve("cp9999-dp0001", ["apim-dp-cp9999-dp0001"]),
    resolve("cp1111-dp0002", ACME_DATA_PLANES, { controlPlaneId: "cp5555" }),
    resolve("dp0002", ACME_DATA_PLANES),
    resolve("orbit dev", null),
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

test("every answer carries the map's source, age and warning, refusals included", () => {
  // Regression: only the answers that searched something carried the map's
  // age. Every refusal dropped map_generated_at and map_generated_days_ago, so
  // a refusal from a months-old map read like one from today's.
  const live = ["acme-prod", ...ACME_DATA_PLANES, "orbit-prod", "orbis-prod", "apim-dp-cp9999-dp0001", "apim-cp-cp7777"];
  const cases = [
    ["Cloud name", "acme", {}],
    ["hosted name", "orbit", {}],
    ["nothing found", "zzxqq", {}],
    ["word matching no deployment", "acme staging", {}],
    ["control_plane_id of another organization", "acme", { controlPlaneId: "cp2222" }],
    ["control_plane_id for a name not in the map", "orbit", { controlPlaneId: "cp1111" }],
    ["ambiguous Cloud fragment", "beac", {}],
    ["two hosted customers", "orb", {}],
    ["part of a name, Loki list failed", "northw", { namespaceValues: null }],
    ["nothing found, Loki list failed", "zzxqq", { namespaceValues: null }],
    ["control plane id", "cp1111", {}],
    ["data plane id", "apim-dp-cp1111-dp0001", {}],
    ["data plane id, another organization", "apim-dp-cp1111-dp0001", { controlPlaneId: "cp2222" }],
    ["live data plane the map lacks", "cp9999-dp0001", {}],
    ["live data plane the map lacks, with control_plane_id", "cp9999-dp0001", { controlPlaneId: "cp9999" }],
    ["control plane namespace the map lacks", "cp7777", {}],
    ["data plane in neither the map nor Loki", "cp1111-dp0099", {}],
    ["data plane id alone", "dp0001", {}],
  ];
  const run = (map) =>
    cases.map(([label, phrase, { namespaceValues = live, ...extra }]) => [
      label,
      resolutionReport(resolveClient({ phrase, namespaceValues, map, ...extra })),
    ]);
  const snapshot = { ...MAP, source: "bundled_snapshot", generated_days_ago: 45, warning: "from the snapshot" };
  for (const map of [MAP, snapshot]) {
    for (const [label, report] of run(map)) {
      assert.equal(report.map_source, map.source, label);
      assert.equal(report.map_generated_at, map.generated_at, label);
      assert.equal(report.map_generated_days_ago, map.generated_days_ago, label);
      assert.equal(report.map_warning, map.warning, label);
    }
  }
  // An unreadable map has no age: left out, never sent as null.
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  for (const [label, report] of run(unavailable)) {
    assert.equal(report.map_source, "unavailable", label);
    assert.ok(!("map_generated_at" in report) && !("map_generated_days_ago" in report), label);
    assert.equal(report.map_warning, "map unavailable", label);
  }
  // find_customer says the same about the map, and returns it without a
  // report in between, so an unreadable map must not give it a null age either.
  const found = findCustomerMatches({ query: "acme", namespaceValues: live, map: snapshot });
  assert.equal(found.map_generated_at, snapshot.generated_at);
  assert.equal(found.map_generated_days_ago, 45);
  assert.equal(found.map_warning, "from the snapshot");
  const foundUnreadable = findCustomerMatches({ query: "acme", namespaceValues: live, map: unavailable });
  assert.ok(!("map_generated_at" in foundUnreadable) && !("map_generated_days_ago" in foundUnreadable));
});

const find = (query, namespaceValues = [], extra = {}) => findCustomerMatches({ query, namespaceValues, map: MAP, ...extra });

test("findCustomerMatches: a name gives the customer's deployments, organizations and namespaces", () => {
  const out = find("acme", ["acme-prod", ...ACME_DATA_PLANES]);
  const [acme] = out.gravitee_cloud_customers;
  assert.equal(acme.customer, "acme");
  assert.equal(acme.deployments, 3);
  assert.deepEqual(acme.control_plane_ids, ["cp1111"]);
  assert.deepEqual(acme.envs, ["dev", "prod", "qa"]);
  assert.deepEqual(acme.namespaces, ACME_DATA_PLANES);
  assert.deepEqual(acme.shared_control_plane_namespaces, ["apim-cp-cp1111"]);
  assert.deepEqual(out.hosted_namespaces, ["acme-prod"]);
  assert.equal(out.map_source, "github");
});

test("a Cloud customer is described the same way in a refusal's candidates and in findCustomerMatches", () => {
  // Regression: the same control plane ids were `control_planes` in a refusal's
  // candidates and `organizations` in find_customer.
  const refused = resolve("beac");
  assert.equal(refused.ambiguous_customer, true);
  assert.deepEqual(refused.candidates.map((c) => c.customer), ["beacon", "beaconlabs"]);
  assert.deepEqual(refused.candidates[0].control_plane_ids, ["cp2222"]);
  const found = find("beac").gravitee_cloud_customers;
  for (const candidate of refused.candidates) {
    const entry = found.find((f) => f.customer === candidate.customer);
    for (const [key, value] of Object.entries(candidate)) assert.deepEqual(entry[key], value, `${candidate.customer}.${key}`);
  }
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

test("findCustomerMatches: a failed namespace lookup is not reported as nothing matched", () => {
  const out = find("kestrel", null);
  assert.equal(out.namespace_lookup_failed, true);
  assert.match(out.note, /No Gravitee Cloud customer matched "kestrel", and hosted namespaces could not be checked/);
  // A Cloud customer still resolves from the map; only the Loki side is unknown.
  const acme = find("acme", null);
  assert.equal(acme.gravitee_cloud_customers[0].customer, "acme");
  assert.equal(acme.namespace_lookup_failed, true);
});

test("findCustomerMatches: an id the map gives one owner is answered, never 'nothing matched'", () => {
  // Regression: matched_by_id named acme, while the note said "No Gravitee
  // Cloud customer or hosted namespace matched" whenever Loki had not seen the
  // namespace, and said nothing when it had.
  const stale =
    "cp1111-dp0001 is acme's data plane in the customer map (namespace apim-dp-cp1111-dp0001). Loki has not seen " +
    "that namespace in the last 30 days: the customer map is probably stale (the deployment was removed, or " +
    "recreated under a new id).";
  const absent = find("cp1111-dp0001", ["apim-dp-cp1111-dp0002"]);
  assert.equal(absent.matched_by_id.customer, "acme");
  assert.equal(absent.note, stale);
  assert.equal(find("apim-dp-cp1111-dp0001", []).note, stale);
  // Live: the owner, nothing about the map.
  const live = "cp1111-dp0001 is acme's data plane in the customer map (namespace apim-dp-cp1111-dp0001).";
  assert.equal(find("cp1111-dp0001", ACME_DATA_PLANES).note, live);
  // Loki's list failed: the owner, and no claim about what Loki has.
  const lokiDown = find("cp1111-dp0001", null);
  assert.equal(lokiDown.note, live);
  assert.equal(lokiDown.namespace_lookup_failed, true);
  // A control plane the map lists one customer on.
  assert.equal(find("cp1111", []).note, "The customer map lists one customer on control plane cp1111: acme.");
});

test("findCustomerMatches: a failed namespace lookup says why", () => {
  const failure = { reason: "Grafana GET /x failed with HTTP 401", retryable: false };
  const out = find("kestrel", null, { lookupFailure: failure });
  assert.match(
    out.namespace_lookup_note,
    /^Loki did not return its namespace list \(Grafana GET \/x failed with HTTP 401\), so hosted namespaces/,
  );
});

test("findCustomerMatches: an unreadable map is not reported as nothing matched", () => {
  // Regression: with the map unavailable it answered "No Gravitee Cloud
  // customer, hosted namespace, or known id matched", called a live data plane
  // "a real deployment the map does not cover", or said nothing at all.
  const unavailable = { rows: [], source: "unavailable", generated_at: null, warning: "map unavailable" };
  const mapDown = (query, namespaceValues) => findCustomerMatches({ query, namespaceValues, map: unavailable });
  const nothing = mapDown("orbitalis", ["acmecorp-prod"]);
  const hosted = mapDown("acmecorp", ["acmecorp-prod"]);
  const dataPlane = mapDown("apim-dp-cp1111-dp0001", ACME_DATA_PLANES);
  const bothDown = mapDown("acme", null);
  for (const out of [nothing, hosted, dataPlane, bothDown]) {
    assert.match(out.note, /^The customer map could not be read \(map_warning says why\), so Gravitee Cloud customers and ids were not checked/);
    assert.doesNotMatch(out.note, /No Gravitee Cloud customer|does not cover|appears in the customer map/, out.note);
  }
  assert.match(nothing.note, /No namespace in Loki matched "orbitalis"/);
  assert.deepEqual(hosted.hosted_namespaces, ["acmecorp-prod"]);
  assert.match(hosted.note, /Only namespaces found in Loki by name are listed\.$/);
  assert.deepEqual(dataPlane.hosted_namespaces, []);
  assert.deepEqual(dataPlane.cloud_namespaces, ["apim-dp-cp1111-dp0001"]);
  assert.match(dataPlane.note, /whose the ones in cloud_namespaces are cannot be said without the map/);
  assert.match(bothDown.note, /Loki did not return its namespace list either/);
});

test("findCustomerMatches: Cloud namespaces that match by name are listed apart, never as hosted", () => {
  // Regression: an id fragment listed the shared control plane and every data
  // plane on it as hosted_namespaces, as if a hosted customer carried the name.
  const loki = ["acme-prod", ...ACME_DATA_PLANES, "apim-cp-cp1111", "dplex-prod"];
  const byId = find("cp1111", loki);
  assert.deepEqual(byId.hosted_namespaces, []);
  assert.deepEqual(byId.cloud_namespaces, [...ACME_DATA_PLANES, "apim-cp-cp1111"]);
  // Matched apart: "dp" is a whole segment of every data plane, and that exact
  // match must not hide the hosted namespace "dp" is part of.
  const dp = find("dp", loki);
  assert.deepEqual(dp.hosted_namespaces, ["dplex-prod"]);
  assert.deepEqual(dp.cloud_namespaces, ACME_DATA_PLANES);
  // Only Cloud namespaces matched: something matched, so no "nothing matched".
  const apim = find("apim", loki);
  assert.deepEqual(apim.hosted_namespaces, []);
  assert.equal(apim.cloud_namespaces.length, 4);
  assert.equal(apim.note, undefined);
});

// A fault in the map: cp1111-dp0001 listed under acme AND globex.
const SHARED_DP_ROW =
  "globex,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-globex.us-aws-us-east-1.gateway.gravitee.io\n";
const SHARED_DP_MAP = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + SHARED_DP_ROW).rows };

test("resolveClient: a data plane the map lists under two customers is never searched, by name or by id", () => {
  const resolveShared = (phrase, values, extra = {}) =>
    resolveClient({ phrase, namespaceValues: values, map: SHARED_DP_MAP, ...extra });
  // Regression: "acme" searched cp1111-dp0001 as acme's, with no word about globex.
  const byName = resolveShared("acme", ["acme-prod", ...ACME_DATA_PLANES]);
  assert.equal(byName.refused, true);
  assert.deepEqual(byName.namespaces, []);
  assert.deepEqual(byName.shared_data_planes, [{ data_plane_id: "cp1111-dp0001", customers: ["acme", "globex"] }]);
  assert.match(byName.note, /acme's other data planes can be searched by id: cp1111-dp0002, cp1111-dp0003\./);
  // A control_plane_id does not make it searchable either.
  assert.equal(resolveShared("acme", ACME_DATA_PLANES, { controlPlaneId: "cp1111" }).refused, true);
  // Only what would be searched counts: acme's dev is its own.
  assert.deepEqual(resolveShared("acme dev", ACME_DATA_PLANES).namespaces, ["apim-dp-cp1111-dp0002"]);
  // Regression: its id said it was acme's data plane, and searched it.
  for (const id of ["cp1111-dp0001", "apim-dp-cp1111-dp0001"]) {
    const byId = resolveShared(id, ACME_DATA_PLANES);
    assert.equal(byId.refused, true, id);
    assert.deepEqual(byId.namespaces, [], id);
    assert.deepEqual(byId.matched_by_id, { kind: "data_plane", id: "cp1111-dp0001", customers: ["acme", "globex"] });
  }
});

test("resolveClient: a data plane's own id never offers to search one the map lists under two customers", () => {
  // Regression: "dp0001" named only the last row's customer, and told the
  // caller to pass the full namespace, which is refused.
  const map = {
    ...MAP,
    rows: parseCustomerCsv(CUSTOMERS_CSV.split("\n").slice(0, 2).join("\n") + "\n" + SHARED_DP_ROW).rows,
  };
  const out = resolveClient({ phrase: "dp0001", namespaceValues: ["apim-dp-cp1111-dp0001"], map });
  assert.equal(out.refused, true);
  assert.deepEqual(out.matched_by_id.data_planes, [{ namespace: "apim-dp-cp1111-dp0001", customers: ["acme", "globex"] }]);
  assert.equal(
    out.note,
    '"dp0001" is the id of data plane apim-dp-cp1111-dp0001 (listed for acme, globex, so never searched). Nothing was searched.',
  );
});

test("findCustomerMatches: a data plane the map lists under two customers is flagged, and its id names both", () => {
  // Regression: the id was credited to the first row's customer.
  const byId = findCustomerMatches({ query: "cp1111-dp0001", map: SHARED_DP_MAP, namespaceValues: ACME_DATA_PLANES });
  assert.equal(byId.matched_by_id.customer, undefined);
  assert.deepEqual(byId.matched_by_id.customers, ["acme", "globex"]);
  const byName = findCustomerMatches({ query: "acme", map: SHARED_DP_MAP, namespaceValues: ACME_DATA_PLANES });
  assert.deepEqual(byName.gravitee_cloud_customers[0].shared_data_planes, [
    { data_plane_id: "cp1111-dp0001", customers: ["acme", "globex"], customers_truncated: 0 },
  ]);
});

// Customers "acme dev" and acme, which has a dev: "acme dev" reads both ways.
const ACME_DEV_ROW = "acme dev,cp8888,cp8888-dp0001,europe,az,westeurope,None,prod-org-acmedev.eu-az-westeurope.gateway.gravitee.io\n";
const TWO_READINGS_MAP = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + ACME_DEV_ROW).rows };

test("resolveClient: a phrase that reads as two customers is refused, and a control_plane_id on one of them picks it", () => {
  const values = [...ACME_DATA_PLANES, "apim-dp-cp8888-dp0001"];
  const acmeDev = (extra = {}) => resolveClient({ phrase: "acme dev", namespaceValues: values, map: TWO_READINGS_MAP, ...extra });
  // Regression: "acme dev" searched the customer "acme dev" without saying it
  // is also acme's dev.
  const both = acmeDev();
  assert.equal(both.refused, true);
  assert.deepEqual(both.namespaces, []);
  assert.equal(both.ambiguous_customer, true);
  assert.deepEqual(both.candidates.map((c) => c.customer), ["acme dev", "acme"]);
  assert.match(both.note, /"acme dev" reads two ways: the customer acme dev, or acme's deployments described by "dev"/);
  assert.match(both.note, /Pass control_plane_id to choose \(acme dev: cp8888; acme: cp1111\)/);
  // An id only one of them is on picks it.
  assert.deepEqual(acmeDev({ controlPlaneId: "cp8888" }).namespaces, ["apim-dp-cp8888-dp0001"]);
  assert.deepEqual(acmeDev({ controlPlaneId: "cp1111" }).namespaces, ["apim-dp-cp1111-dp0002"]);
  assert.match(acmeDev({ controlPlaneId: "cp9999" }).note, /control_plane_id "cp9999" is on neither of them/);
  // On one organization, only a data plane's full id tells them apart.
  const sameOrg = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + ACME_DEV_ROW.replaceAll("cp8888", "cp1111")).rows };
  const one = resolveClient({ phrase: "acme dev", namespaceValues: values, map: sameOrg });
  assert.equal(one.refused, true);
  assert.match(one.note, /Pass the full id of the data plane you mean\.$/);
});

test("resolveClient: control_plane_id is compared as the map writes ids, on every path", () => {
  // Regression: " cp5555" and "CP5555" were refused as not northwind's.
  const values = ["apim-dp-cp5555-dp0001", "apim-dp-cp6666-dp0001"];
  for (const id of [" cp5555", "CP5555", "cp5555 \t"]) {
    const out = resolve("northwind", values, { controlPlaneId: id });
    assert.deepEqual(out.namespaces, ["apim-dp-cp5555-dp0001"], JSON.stringify(id));
  }
  // With Loki's namespace list missing, the map still narrows.
  const lokiDown = resolve("northwind", null, { controlPlaneId: "CP5555" });
  assert.deepEqual(lokiDown.namespaces, ["apim-dp-cp5555-dp0001"]);
  assert.equal(lokiDown.namespace_lookup_failed, true);
  // A data plane's id.
  const dataPlane = resolve("cp1111-dp0002", ACME_DATA_PLANES, { controlPlaneId: "CP1111" });
  assert.deepEqual(dataPlane.namespaces, ["apim-dp-cp1111-dp0002"]);
  // A phrase that reads as two customers: the note said "CP8888" was on neither.
  const twoReadings = resolveClient({
    phrase: "acme dev",
    namespaceValues: [...ACME_DATA_PLANES, "apim-dp-cp8888-dp0001"],
    map: TWO_READINGS_MAP,
    controlPlaneId: "CP8888",
  });
  assert.deepEqual(twoReadings.namespaces, ["apim-dp-cp8888-dp0001"]);
  // A refusal shows the id as it was compared.
  const other = resolve("northwind", values, { controlPlaneId: " CP9999 " });
  assert.equal(other.refused, true);
  assert.equal(other.requested_control_plane_id, "cp9999");
  assert.match(other.note, /"cp9999" is not one of northwind's Cockpit organizations/);
});

test("resolveClient: a blank control_plane_id is taken as none", () => {
  const values = ["apim-dp-cp5555-dp0001", "apim-dp-cp6666-dp0001"];
  const none = resolve("northwind", values);
  assert.equal(none.namespaces.length, 2);
  for (const id of ["", "   ", undefined, null]) {
    const out = resolve("northwind", values, { controlPlaneId: id });
    assert.equal(out.refused, undefined, JSON.stringify(id));
    assert.deepEqual(out.namespaces, none.namespaces, JSON.stringify(id));
  }
});

test("findCustomerMatches: a phrase that reads as two customers lists both", () => {
  const out = findCustomerMatches({ query: "acme dev", map: TWO_READINGS_MAP, namespaceValues: ACME_DATA_PLANES });
  assert.deepEqual(out.gravitee_cloud_customers.map((c) => c.customer), ["acme", "acme dev"]);
});

// The "Pass ..." sentence a note ends with: what to pass to pick a customer.
const choiceIn = (note) => note.slice(note.lastIndexOf("Pass "));

test("findCustomerMatches: a phrase that reads as two customers gives the choice grafana_logs_link accepts", () => {
  // Regression: the note said "pass one exact customer name", and
  // grafana_logs_link refuses that name, since it reads two ways.
  const out = findCustomerMatches({ query: "acme dev", map: TWO_READINGS_MAP, namespaceValues: ACME_DATA_PLANES });
  assert.equal(
    out.note,
    '"acme dev" reads two ways: the customer acme dev, or acme\'s deployments described by "dev". The log tools ' +
      "refuse the name alone, since either reading could return the other's logs. Pass control_plane_id to choose " +
      "(acme dev: cp8888; acme: cp1111), or the full id of a data plane.",
  );
  const link = resolveClient({ phrase: "acme dev", namespaceValues: ACME_DATA_PLANES, map: TWO_READINGS_MAP });
  assert.equal(choiceIn(out.note), choiceIn(link.note));
  // On one organization, only a data plane's full id tells them apart.
  const sameOrg = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + ACME_DEV_ROW.replaceAll("cp8888", "cp1111")).rows };
  const one = findCustomerMatches({ query: "acme dev", map: sameOrg, namespaceValues: ACME_DATA_PLANES });
  assert.equal(choiceIn(one.note), "Pass the full id of the data plane you mean.");
});

// Customers "acme dev" and "acme-dev": every spelling of the name is both.
const SAME_NAME_ROWS =
  ACME_DEV_ROW + "acme-dev,cp9999,cp9999-dp0001,europe,az,westeurope,None,prod-org-acme-dev.eu-az-westeurope.gateway.gravitee.io\n";
const SAME_NAME_MAP = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV.split("\n")[0] + "\n" + SAME_NAME_ROWS).rows };
// The same, plus acme, which has a dev: "acme dev" also reads as acme's dev.
const SAME_NAME_AND_ACME_MAP = { ...MAP, rows: parseCustomerCsv(CUSTOMERS_CSV + SAME_NAME_ROWS).rows };
const SAME_NAME_LIVE = ["apim-dp-cp8888-dp0001", "apim-dp-cp9999-dp0001", ...ACME_DATA_PLANES];

test("resolveClient: two customers whose names differ only in separators are refused, pointing to a data plane id", () => {
  // Regression: the note said "Use the exact customer name" (with a
  // control_plane_id, "pass the exact customer name"), which was typed.
  for (const map of [SAME_NAME_MAP, SAME_NAME_AND_ACME_MAP]) {
    for (const controlPlaneId of [undefined, "cp8888", "cp9999"]) {
      const label = `${map === SAME_NAME_MAP ? "same name" : "same name + acme"} ${controlPlaneId}`;
      const out = resolveClient({ phrase: "acme dev", controlPlaneId, namespaceValues: SAME_NAME_LIVE, map });
      assert.equal(out.refused, true, label);
      assert.deepEqual(out.namespaces, [], label);
      assert.deepEqual(out.candidates.map((c) => c.customer), ["acme dev", "acme-dev"], label);
      assert.match(out.note, /pass the full id of one of their data planes \(grafana_find_customer lists them\)\.$/, label);
      assert.doesNotMatch(out.note, /exact customer name/, label);
      // Regression: with acme too, the note described "acme dev" and
      // "acme-dev" as one customer on both organizations.
      assert.doesNotMatch(out.note, /cp8888, cp9999/, label);
    }
  }
  // The way the note gives reaches one of them.
  const byId = resolveClient({ phrase: "cp8888-dp0001", namespaceValues: SAME_NAME_LIVE, map: SAME_NAME_MAP });
  assert.deepEqual(byId.namespaces, ["apim-dp-cp8888-dp0001"]);
  // acme's organization still picks the other reading, acme's dev.
  const acmeDev = resolveClient({ phrase: "acme dev", controlPlaneId: "cp1111", namespaceValues: SAME_NAME_LIVE, map: SAME_NAME_AND_ACME_MAP });
  assert.deepEqual(acmeDev.namespaces, ["apim-dp-cp1111-dp0002"]);
});

test("findCustomerMatches: a name two customers share says that only a data plane id reaches one", () => {
  // Regression: the note said "pass one exact customer name": it matches both.
  // With acme too, "acme dev" also reads as acme's dev: the shared name is
  // what the note is about, as in grafana_logs_link's refusal.
  for (const map of [SAME_NAME_MAP, SAME_NAME_AND_ACME_MAP]) {
    for (const query of ["acme dev", "acme-dev"]) {
      const out = findCustomerMatches({ query, map, namespaceValues: SAME_NAME_LIVE });
      assert.equal(
        out.note,
        `"${query}" is the name of 2 different Gravitee Cloud customers (acme dev, acme-dev): their names differ only ` +
          "in spaces, dashes or underscores. The log tools cannot pick one of them by the name, nor with " +
          "control_plane_id: pass the full id of one of their data planes (listed in namespaces).",
        query,
      );
      const listed = out.gravitee_cloud_customers.find((c) => c.customer === "acme-dev");
      assert.deepEqual(listed.namespaces, ["apim-dp-cp9999-dp0001"], query);
    }
  }
});

test("findCustomerMatches: a Cloud id matches a whole segment of any Cloud namespace before part of a longer id", () => {
  // Hosted namespaces are read from their owner's first segment; Cloud ones
  // have none (all start with apim), so an id is any whole segment of them.
  const loki = [...ACME_DATA_PLANES, "apim-cp-cp1111", "apim-dp-cp11112-dp0001"];
  assert.deepEqual(find("cp1111", loki).cloud_namespaces, [...ACME_DATA_PLANES, "apim-cp-cp1111"]);
  assert.deepEqual(find("cp1111-dp0002", loki).cloud_namespaces, ["apim-dp-cp1111-dp0002"]);
});

test("findCustomerMatches: max_results caps every list and says how many were left out", () => {
  // Regression: max_results capped only the Cloud customers; a short query
  // listed every matching namespace, hundreds of them, with no count.
  const loki = ["orbit-prod", "orbit-dev", "orbit-qa", ...ACME_DATA_PLANES, "apim-cp-cp1111"];
  const hosted = find("orbit", loki, { maxResults: 2 });
  assert.deepEqual(hosted.hosted_namespaces, ["orbit-prod", "orbit-dev"]);
  assert.equal(hosted.hosted_namespaces_truncated, 1);
  const cloud = find("cp1111", loki, { maxResults: 2 });
  assert.equal(cloud.cloud_namespaces.length, 2);
  assert.equal(cloud.cloud_namespaces_truncated, 2);
  const unattributed = find("acme", [...ACME_DATA_PLANES, "apim-dp-cp1111-dp0097", "apim-dp-cp1111-dp0098", "apim-dp-cp1111-dp0099"], {
    maxResults: 2,
  });
  const [acme] = unattributed.gravitee_cloud_customers;
  assert.deepEqual(acme.unattributed_namespaces_on_same_control_plane, ["apim-dp-cp1111-dp0097", "apim-dp-cp1111-dp0098"]);
  assert.equal(acme.unattributed_truncated, 1);
  // Exactly at the limit: everything shown, nothing reported left out.
  const exact = find("orbit", loki, { maxResults: 3 });
  assert.equal(exact.hosted_namespaces.length, 3);
  assert.equal(exact.hosted_namespaces_truncated, 0);
  assert.equal(exact.cloud_namespaces_truncated, 0);
  assert.equal(exact.gravitee_cloud_truncated, 0);
});

test("findCustomerMatches: max_results caps each customer's own lists and matched_by_id's too", () => {
  // Regression: only the answer's own lists were capped. A customer's
  // namespaces, control planes, envs and regions, and matched_by_id's lists,
  // came back whole however small max_results was, and the notes named every
  // customer on a control plane.
  const acme = find("acme", [], { maxResults: 1 }).gravitee_cloud_customers[0];
  assert.deepEqual(acme.namespaces, ["apim-dp-cp1111-dp0001"]);
  assert.equal(acme.namespaces_truncated, 2);
  assert.equal(acme.envs.length, 1);
  assert.equal(acme.envs_truncated, 2);
  for (const key of ["control_plane_ids", "regions", "shared_control_plane_namespaces"]) {
    assert.equal(acme[key].length, 1, key);
    assert.equal(acme[`${key}_truncated`], 0, key);
  }
  const northwind = find("northwind", [], { maxResults: 1 });
  assert.deepEqual(northwind.gravitee_cloud_customers[0].control_plane_ids, ["cp5555"]);
  assert.equal(northwind.gravitee_cloud_customers[0].control_plane_ids_truncated, 1);
  assert.equal(northwind.gravitee_cloud_customers[0].shared_control_plane_namespaces_truncated, 1);
  // The note still counts and names both organizations.
  assert.match(northwind.note, /spans 2 separate Cockpit organizations \(cp5555, cp6666\)/);

  // Twelve customers on one control plane, three of them also on one data plane.
  const tenants = Array.from({ length: 12 }, (_, i) => `tenant${String(i + 1).padStart(2, "0")}`);
  const csv = [
    CUSTOMERS_CSV.split("\n")[0],
    ...tenants.map((t, i) => `${t},cp9000,cp9000-dp${String(i + 1).padStart(4, "0")},europe,az,westeurope,None,prod-org-${t}.eu.gateway.gravitee.io`),
    ...tenants.slice(0, 3).map((t) => `${t},cp9000,cp9000-dp0099,europe,az,westeurope,None,prod-org-${t}-x.eu.gateway.gravitee.io`),
    // One customer on twelve Cockpit organizations.
    ...tenants.map((_, i) => `wideorg,cp80${String(i + 1).padStart(2, "0")},cp80${String(i + 1).padStart(2, "0")}-dp0001,europe,az,westeurope,None,prod-org-wideorg.eu.gateway.gravitee.io`),
  ].join("\n");
  const shared = { ...MAP, rows: parseCustomerCsv(`${csv}\n`).rows };
  const findIn = (query) => findCustomerMatches({ query, namespaceValues: [], map: shared, maxResults: 2 });

  const controlPlane = findIn("cp9000");
  assert.deepEqual(controlPlane.matched_by_id.customers, ["tenant01", "tenant02"]);
  assert.equal(controlPlane.matched_by_id.customers_truncated, 10);
  assert.match(controlPlane.note, /shared by 12 customers \(tenant01, .*, tenant10 and 2 more\)/);
  const unlisted = findIn("cp9000-dp0777");
  assert.deepEqual(unlisted.matched_by_id.candidate_customers, ["tenant01", "tenant02"]);
  assert.equal(unlisted.matched_by_id.candidate_customers_truncated, 10);
  assert.match(unlisted.note, /hosts tenant01, .*, tenant10 and 2 more\./);
  const sharedDataPlane = findIn("cp9000-dp0099");
  assert.equal(sharedDataPlane.matched_by_id.customers.length, 2);
  assert.equal(sharedDataPlane.matched_by_id.customers_truncated, 1);
  assert.equal(sharedDataPlane.matched_by_id.deployments.length, 2);
  assert.equal(sharedDataPlane.matched_by_id.deployments_truncated, 1);
  const [tenant] = findIn("tenant01").gravitee_cloud_customers;
  assert.deepEqual(tenant.shared_data_planes[0].customers, ["tenant01", "tenant02"]);
  assert.equal(tenant.shared_data_planes[0].customers_truncated, 1);
  const wide = findIn("wideorg");
  assert.equal(wide.gravitee_cloud_customers[0].control_plane_ids_truncated, 10);
  assert.match(wide.note, /spans 12 separate Cockpit organizations \(cp8001, .*, cp8010 and 2 more\)/);

  // Exactly at the limit: everything shown, nothing reported left out.
  const atLimit = find("acme", [], { maxResults: 3 }).gravitee_cloud_customers[0];
  assert.equal(atLimit.namespaces.length, 3);
  assert.equal(atLimit.namespaces_truncated, 0);
  assert.equal(atLimit.envs_truncated, 0);
});

test("findCustomerMatches: a live data plane the map does not attribute is reported apart, never claimed", () => {
  const out = find("acme", [...ACME_DATA_PLANES, "apim-dp-cp1111-dp0099"]);
  const [acme] = out.gravitee_cloud_customers;
  assert.deepEqual(acme.unattributed_namespaces_on_same_control_plane, ["apim-dp-cp1111-dp0099"]);
  assert.ok(!acme.namespaces.includes("apim-dp-cp1111-dp0099"));
});
