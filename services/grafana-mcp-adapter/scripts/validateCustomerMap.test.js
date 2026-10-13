import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCustomerCsv } from "../customerCsv.js";
import { validateCustomerMap } from "./validateCustomerMap.js";

const CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-acme.us-aws-us-east-1.gateway.gravitee.io
acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,dev-org-acme.us-aws-us-east-1.gateway.gravitee.io
beacon,cp2222,cp2222-dp0001,europe,az,westeurope,None,prod-org-beacon.eu-az-westeurope.gateway.gravitee.io
`;

const MAP = { rows: parseCustomerCsv(CSV), source: "github" };
const ALL_LIVE = ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp2222-dp0001", "april-prod"];

test("validateCustomerMap: an unavailable map fails instead of passing with nothing checked", () => {
  // Regression (#9 review): one live data plane, zero map rows, 100% unmapped,
  // and the script still exited 0.
  const out = validateCustomerMap({
    map: { rows: [], source: "unavailable" },
    liveNamespaces: ["apim-dp-cp1111-dp0001"],
  });
  assert.equal(out.ok, false);
  assert.equal(out.measured, false);
  assert.match(out.errors[0], /customer map is unavailable/);
});

test("validateCustomerMap: a map that loaded with zero rows fails too", () => {
  const out = validateCustomerMap({ map: { rows: [], source: "bundled_snapshot" }, liveNamespaces: ALL_LIVE });
  assert.equal(out.ok, false);
  assert.match(out.errors[0], /customer map is empty \(source: bundled_snapshot\)/);
});

test("validateCustomerMap: no live namespaces from Loki fails, since nothing could be compared", () => {
  const out = validateCustomerMap({ map: MAP, liveNamespaces: [] });
  assert.equal(out.ok, false);
  assert.equal(out.measured, false);
  assert.match(out.errors[0], /Loki returned no namespaces/);
});

test("validateCustomerMap: a map whose namespaces are all live passes, and counts unmapped data planes", () => {
  const out = validateCustomerMap({ map: MAP, liveNamespaces: [...ALL_LIVE, "apim-dp-cp9999-dp0001"] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  assert.equal(out.customers, 2);
  assert.equal(out.full, 2);
  assert.deepEqual(out.stale, []);
  assert.equal(out.liveDataPlanes, 4);
  assert.equal(out.orphans, 1);
  assert.equal(out.orphanPercent, 25);
});

test("validateCustomerMap: customers with missing namespaces fail only above the threshold", () => {
  const live = ["apim-dp-cp1111-dp0001"];
  const within = validateCustomerMap({ map: MAP, liveNamespaces: live, maxStale: 2 });
  assert.equal(within.ok, true);
  assert.deepEqual(within.stale.map((s) => s.customer), ["beacon", "acme"]);

  const above = validateCustomerMap({ map: MAP, liveNamespaces: live, maxStale: 1 });
  assert.equal(above.ok, false);
  assert.match(above.errors[0], /2 customers have missing namespaces \(threshold 1\)/);
});

test("validateCustomerMap: no live data planes at all reports 0%, not NaN", () => {
  const out = validateCustomerMap({ map: MAP, liveNamespaces: ["april-prod"], maxStale: 5 });
  assert.equal(out.liveDataPlanes, 0);
  assert.equal(out.orphanPercent, 0);
});
