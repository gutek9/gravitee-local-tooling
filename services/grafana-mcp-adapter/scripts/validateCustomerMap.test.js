import { test } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCustomerCsv } from "../customerCsv.js";
import { buildSnapshot, readNumberSettings } from "../customerMapLoader.js";
import { validateCustomerMap, VALIDATE_SETTINGS } from "./validateCustomerMap.js";

const CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-acme.us-aws-us-east-1.gateway.gravitee.io
acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,dev-org-acme.us-aws-us-east-1.gateway.gravitee.io
beacon,cp2222,cp2222-dp0001,europe,az,westeurope,None,prod-org-beacon.eu-az-westeurope.gateway.gravitee.io
`;

const MAP = { rows: parseCustomerCsv(CSV), source: "github" };
const ALL_LIVE = ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp2222-dp0001", "kestrel-prod"];

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

test("validateCustomerMap: a data plane listed under two customers fails, whatever the threshold", () => {
  // grafana_logs_link refuses such a data plane, so a map with one is not fit
  // to be refreshed into the snapshot, even with nothing missing.
  const shared = CSV + "globex,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-globex.us-aws-us-east-1.gateway.gravitee.io\n";
  const out = validateCustomerMap({ map: { rows: parseCustomerCsv(shared), source: "github" }, liveNamespaces: ALL_LIVE, maxStale: 10000 });
  assert.equal(out.ok, false);
  assert.equal(out.measured, true);
  assert.match(out.errors.join("\n"), /1 data plane\(s\) listed under more than one customer: cp1111-dp0001 \(acme, globex\)/);
});

test("validateCustomerMap: no live data planes at all reports 0%, not NaN", () => {
  const out = validateCustomerMap({ map: MAP, liveNamespaces: ["kestrel-prod"], maxStale: 5 });
  assert.equal(out.liveDataPlanes, 0);
  assert.equal(out.orphanPercent, 0);
});

test("validateCustomerMap: a threshold that is not a whole number is refused, not passed", () => {
  // Regression: VALIDATE_MAX_STALE=abc became NaN, "stale > NaN" was false, and
  // the check passed with every customer stale.
  for (const maxStale of [NaN, -1, 1.5]) {
    assert.throws(
      () => validateCustomerMap({ map: MAP, liveNamespaces: ["apim-dp-cp1111-dp0001"], maxStale }),
      /maxStale must be a whole number of 0 or more/,
      String(maxStale),
    );
  }
});

test("VALIDATE_SETTINGS: the script's numbers are read like the map settings", () => {
  assert.deepEqual(readNumberSettings({}, VALIDATE_SETTINGS), {
    values: { VALIDATE_WINDOW_DAYS: 30, VALIDATE_MAX_STALE: 20 },
    errors: [],
  });
  // 0 is the strict threshold: fail on any customer with a missing namespace.
  assert.equal(readNumberSettings({ VALIDATE_MAX_STALE: "0" }, VALIDATE_SETTINGS).values.VALIDATE_MAX_STALE, 0);
  for (const bad of ["abc", "30d", "0", "-5", "1.5", "366"]) {
    assert.deepEqual(
      readNumberSettings({ VALIDATE_WINDOW_DAYS: bad }, VALIDATE_SETTINGS).errors,
      [`VALIDATE_WINDOW_DAYS must be a whole number from 1 to 365, got "${bad}"`],
      bad,
    );
  }
  for (const bad of ["abc", "-1", "1.5", "10001"]) {
    assert.deepEqual(
      readNumberSettings({ VALIDATE_MAX_STALE: bad }, VALIDATE_SETTINGS).errors,
      [`VALIDATE_MAX_STALE must be a whole number from 0 to 10000, got "${bad}"`],
      bad,
    );
  }
});

// The script itself, run as `node scripts/validate-customers.mjs` with fetch
// replaced: every request it makes is printed to stderr and refused, so the test
// sees what would have reached GitHub or Loki without any network.
const SCRIPT = fileURLToPath(new URL("./validate-customers.mjs", import.meta.url));
const NO_NETWORK = `data:text/javascript,${encodeURIComponent(
  'globalThis.fetch = async (url) => { process.stderr.write("REQUEST " + url + "\\n"); throw new Error("no network in tests"); };',
)}`;
const CONFIGURED = {
  GRAFANA_ENABLED: "true",
  GRAFANA_BASE_URL: "https://g.example.com",
  GRAFANA_TOKEN: "glsa_test",
  GRAFANA_LOGS_DATASOURCE_UID: "logs-uid",
  GITHUB_PERSONAL_ACCESS_TOKEN: "test-token",
};
const runScript = (env) =>
  spawnSync(process.execPath, ["--import", NO_NETWORK, SCRIPT], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

test("validate-customers: a bad setting is refused before GitHub or Loki is asked anything", () => {
  // Regression: VALIDATE_MAX_STALE=abc exited 0 however many customers were
  // stale, and VALIDATE_WINDOW_DAYS=30d sent start=NaN to Loki.
  for (const [name, raw] of [
    ["VALIDATE_MAX_STALE", "abc"],
    ["VALIDATE_WINDOW_DAYS", "30d"],
    ["GRAFANA_CUSTOMER_MAP_TIMEOUT_MS", "abc"],
  ]) {
    const out = runScript({ ...CONFIGURED, [name]: raw });
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stderr, new RegExp(`${name} must be a whole number`));
    assert.doesNotMatch(out.stderr, /REQUEST/);
  }
  // Missing configuration is reported the same way, all of it at once.
  const unconfigured = runScript({ VALIDATE_MAX_STALE: "abc" });
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /VALIDATE_MAX_STALE must be a whole number/);
  assert.match(unconfigured.stderr, /Grafana is disabled/);
  assert.match(unconfigured.stderr, /GRAFANA_LOGS_DATASOURCE_UID is required/);
  assert.doesNotMatch(unconfigured.stderr, /REQUEST/);
});

test("validate-customers: the window reaches Loki as a real start time", () => {
  const out = runScript({ ...CONFIGURED, VALIDATE_WINDOW_DAYS: "7" });
  const request = /REQUEST (\S+)/.exec(out.stderr)?.[1];
  assert.ok(request, out.stderr);
  const url = new URL(request);
  assert.equal(url.pathname, "/api/datasources/proxy/uid/logs-uid/loki/api/v1/label/namespace/values");
  // Loki wants nanoseconds; 7 days ago, give or take the test's own run time.
  const startMs = Number(url.searchParams.get("start")) / 1e6;
  assert.ok(Math.abs(startMs - (Date.now() - 7 * 86400000)) < 60000, url.searchParams.get("start"));
});

// The script with fetch answered without network: Loki returns ALL_LIVE, GitHub
// answers per `github` ("ok": CSV and its commit date, "down": 503). Every
// request is still printed to stderr.
const stubbedNetwork = (github) =>
  `data:text/javascript,${encodeURIComponent(`
    const csv = ${JSON.stringify(CSV)};
    globalThis.fetch = async (url) => {
      const u = String(url);
      process.stderr.write("REQUEST " + u + "\\n");
      if (u.startsWith("https://api.github.com/")) {
        if (${JSON.stringify(github)} === "down") return { ok: false, status: 503, text: async () => "" };
        const body = u.includes("/commits?") ? JSON.stringify([{ commit: { committer: { date: "2026-11-10T23:00:00Z" } } }]) : csv;
        return { ok: true, status: 200, text: async () => body };
      }
      const data = ${JSON.stringify(ALL_LIVE)};
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: "success", data }), headers: { get: () => null } };
    };`)}`;
const runStubbed = (github, env) =>
  spawnSync(process.execPath, ["--import", stubbedNetwork(github), SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

// A snapshot from January, where the adapter would fall back when GitHub fails.
function withOldSnapshot(fn) {
  const dir = mkdtempSync(join(tmpdir(), "validate-customers-"));
  const path = join(dir, "customers-snapshot.json");
  try {
    writeFileSync(path, JSON.stringify(buildSnapshot({ customers: parseCustomerCsv(CSV), sourceGeneratedAt: "2026-01-01T00:00:00Z" })));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("validate-customers: measures the map GitHub has now, and says when it was generated", () => {
  const out = runStubbed("ok", CONFIGURED);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /map: 3 rows from GitHub \(CSV generated 2026-11-10\)/);
  assert.match(out.stdout, /forward: 2 customers \| fully resolvable: 2/);
  assert.match(out.stderr, /REQUEST https:\/\/api\.github\.com\/repos\/.*\/contents\//);
});

test("validate-customers: GitHub down fails, never measuring the bundled snapshot instead", () => {
  // Regression: the snapshot was measured as if it were the map, and the
  // check passed (exit 0) on data from January.
  withOldSnapshot((snapshot) => {
    const out = runStubbed("down", { ...CONFIGURED, GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH: snapshot });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /Could not read the customer map from GitHub: GitHub responded 503\. Nothing was validated\./);
    assert.doesNotMatch(out.stdout, /forward:/);
  });
});

test("validate-customers: no GitHub token fails before any request, even with a snapshot", () => {
  // Regression: without a token the snapshot was measured, and the check passed.
  withOldSnapshot((snapshot) => {
    const { GITHUB_PERSONAL_ACCESS_TOKEN, ...noToken } = CONFIGURED;
    const out = runStubbed("ok", { ...noToken, GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH: snapshot });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /GITHUB_PERSONAL_ACCESS_TOKEN is required/);
    assert.doesNotMatch(out.stderr, /REQUEST/);
  });
});
