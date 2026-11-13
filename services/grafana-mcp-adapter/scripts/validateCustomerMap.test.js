import { test } from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const MAP = { rows: parseCustomerCsv(CSV).rows };
const ALL_LIVE = ["apim-dp-cp1111-dp0001", "apim-dp-cp1111-dp0002", "apim-dp-cp2222-dp0001", "kestrel-prod"];

test("validateCustomerMap: a map with zero rows fails instead of passing with nothing checked", () => {
  // Regression (#9 review): one live data plane, zero map rows, 100% unmapped,
  // and the script still exited 0.
  const out = validateCustomerMap({ map: { rows: [] }, liveNamespaces: ["apim-dp-cp1111-dp0001"] });
  assert.equal(out.ok, false);
  assert.equal(out.measured, false);
  assert.equal(
    out.errors[0],
    "The customer CSV has no rows, so nothing was validated: check the file that " +
      "GRAFANA_CUSTOMER_MAP_REPO and GRAFANA_CUSTOMER_MAP_PATH name.",
  );
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
  // A refresh writes the same rows into the snapshot, so it is not the advice.
  assert.equal(
    above.errors[0],
    "2 customers have missing namespaces (threshold 1). A refresh writes the same rows into the snapshot, " +
      "so it would not fix them: if those data planes are gone, the CSV needs correcting at its source.",
  );
});

test("validateCustomerMap: every customer is measured, also one grafana_logs_link refuses by name", () => {
  // Regression: a customer was measured through the search for its name, so
  // one that search refuses had no namespaces and was left out of both counts.
  // acme shares cp1111-dp0001 with globex, and "acme dev" / "acme-dev" read as
  // the same name: with the strict threshold the check passed (exit 0) while
  // acme's dp0002 and both "acme dev" data planes were missing. acme lists
  // dp0002 on a second row too, which still counts once.
  const csv =
    CSV +
    "acme,cp1111,cp1111-dp0002,unitedstates,aws,us-east-1,None,qa-org-acme.us-aws-us-east-1.gateway.gravitee.io\n" +
    "globex,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-globex.us-aws-us-east-1.gateway.gravitee.io\n" +
    "acme dev,cp5555,cp5555-dp0001,europe,az,westeurope,None,None\n" +
    "acme-dev,cp6666,cp6666-dp0001,europe,az,westeurope,None,None\n";
  const live = ["apim-dp-cp1111-dp0001", "apim-dp-cp2222-dp0001"];
  const out = validateCustomerMap({ map: { rows: parseCustomerCsv(csv).rows }, liveNamespaces: live, maxStale: 0 });
  assert.equal(out.customers, 5);
  assert.equal(out.full + out.stale.length, out.customers);
  assert.deepEqual(
    out.stale.map((s) => [s.customer, s.present, s.mapped]),
    [
      ["acme dev", 0, 1],
      ["acme-dev", 0, 1],
      ["acme", 1, 2],
    ],
  );
  assert.equal(out.ok, false);
  assert.match(out.errors[0], /^3 customers have missing namespaces \(threshold 0\)/);
});

test("validateCustomerMap: a data plane listed under two customers fails, whatever the threshold", () => {
  // grafana_logs_link refuses such a data plane, so a map with one is not fit
  // to be refreshed into the snapshot, even with nothing missing.
  const shared = CSV + "globex,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-globex.us-aws-us-east-1.gateway.gravitee.io\n";
  const out = validateCustomerMap({ map: { rows: parseCustomerCsv(shared).rows }, liveNamespaces: ALL_LIVE, maxStale: 10000 });
  assert.equal(out.ok, false);
  assert.equal(out.measured, true);
  assert.match(out.errors.join("\n"), /1 data plane\(s\) listed under more than one customer: cp1111-dp0001 \(acme, globex\)/);
});

test("validateCustomerMap: a row of the CSV it cannot use fails after measuring the rest, naming every one", () => {
  // grafana_logs_link leaves such a row out, so a customer on it resolves only
  // partly: the map is not fit to be refreshed into the snapshot.
  const csv = CSV + "globex, inc,cp3333,cp3333-dp0001,europe,az,westeurope,None,None\nglobex,cp3333,cp3333 dp0002,europe,az,westeurope,None,None\n";
  const { rows, leftOut } = parseCustomerCsv(csv);
  const out = validateCustomerMap({ map: { rows, leftOut }, liveNamespaces: ALL_LIVE, maxStale: 10000 });
  assert.equal(out.ok, false);
  assert.equal(out.measured, true);
  assert.equal(out.full, 2);
  assert.equal(
    out.errors.join("\n"),
    "2 row(s) of the customer CSV cannot be used, so grafana_logs_link leaves them out and a customer on them " +
      "resolves only partly, or not at all:\n" +
      "  line 5: 9 fields where the header has 8\n" +
      "  line 6, globex: the data plane id is not lower-case letters and digits in dash-separated parts",
  );
  // With no usable row at all, nothing is measured, and both are said.
  const none = validateCustomerMap({ map: { rows: [], leftOut }, liveNamespaces: ALL_LIVE });
  assert.equal(none.measured, false);
  assert.equal(none.errors[0], "No row of the customer map can be used, so nothing was validated.");
  assert.match(none.errors[1], /^2 row\(s\) of the customer CSV cannot be used/);
});

test("validateCustomerMap: no live data planes at all reports 0%, not NaN", () => {
  const out = validateCustomerMap({ map: MAP, liveNamespaces: ["kestrel-prod"], maxStale: 5 });
  assert.equal(out.liveDataPlanes, 0);
  assert.equal(out.orphanPercent, 0);
});

test("validateCustomerMap: a threshold that is not a whole number is refused, not passed", () => {
  // Regression: GRAFANA_VALIDATE_MAX_STALE=abc became NaN, "stale > NaN" was
  // false, and the check passed with every customer stale.
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
    values: { GRAFANA_VALIDATE_WINDOW_DAYS: 30, GRAFANA_VALIDATE_MAX_STALE: 20 },
    errors: [],
  });
  // 0 is the strict threshold: fail on any customer with a missing namespace.
  assert.equal(readNumberSettings({ GRAFANA_VALIDATE_MAX_STALE: "0" }, VALIDATE_SETTINGS).values.GRAFANA_VALIDATE_MAX_STALE, 0);
  for (const bad of ["abc", "30d", "0", "-5", "1.5", "366"]) {
    assert.deepEqual(
      readNumberSettings({ GRAFANA_VALIDATE_WINDOW_DAYS: bad }, VALIDATE_SETTINGS).errors,
      [`GRAFANA_VALIDATE_WINDOW_DAYS must be a whole number from 1 to 365, got "${bad}"`],
      bad,
    );
  }
  for (const bad of ["abc", "-1", "1.5", "10001"]) {
    assert.deepEqual(
      readNumberSettings({ GRAFANA_VALIDATE_MAX_STALE: bad }, VALIDATE_SETTINGS).errors,
      [`GRAFANA_VALIDATE_MAX_STALE must be a whole number from 0 to 10000, got "${bad}"`],
      bad,
    );
  }
});

test("VALIDATE_SETTINGS: every number the script reads is listed in .env.example", () => {
  // Regression (#9 review): they were documented in the adapter's README only,
  // so a .env copied from .env.example never showed them.
  const example = readFileSync(fileURLToPath(new URL("../../../.env.example", import.meta.url)), "utf8");
  for (const { name } of VALIDATE_SETTINGS) {
    assert.match(example, new RegExp(`^${name}=$`, "m"), name);
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
  // Regression: GRAFANA_VALIDATE_MAX_STALE=abc exited 0 however many customers
  // were stale, and GRAFANA_VALIDATE_WINDOW_DAYS=30d sent start=NaN to Loki.
  for (const [name, raw] of [
    ["GRAFANA_VALIDATE_MAX_STALE", "abc"],
    ["GRAFANA_VALIDATE_WINDOW_DAYS", "30d"],
    ["GRAFANA_CUSTOMER_MAP_TIMEOUT_MS", "abc"],
  ]) {
    const out = runScript({ ...CONFIGURED, [name]: raw });
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stderr, new RegExp(`${name} must be a whole number`));
    assert.doesNotMatch(out.stderr, /REQUEST/);
  }
  // Missing configuration is reported the same way, all of it at once.
  const unconfigured = runScript({ GRAFANA_VALIDATE_MAX_STALE: "abc" });
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /GRAFANA_VALIDATE_MAX_STALE must be a whole number/);
  assert.match(unconfigured.stderr, /Grafana is disabled/);
  assert.match(unconfigured.stderr, /GRAFANA_LOGS_DATASOURCE_UID is required/);
  assert.doesNotMatch(unconfigured.stderr, /REQUEST/);
});

test("validate-customers: the window reaches Loki as a real start time", () => {
  const out = runScript({ ...CONFIGURED, GRAFANA_VALIDATE_WINDOW_DAYS: "7" });
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
const stubbedNetwork = (github, csv) =>
  `data:text/javascript,${encodeURIComponent(`
    const csv = ${JSON.stringify(csv)};
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
const runStubbed = (github, env, csv = CSV) =>
  spawnSync(process.execPath, ["--import", stubbedNetwork(github, csv), SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

// A snapshot from January, where the adapter would fall back when GitHub fails.
function withOldSnapshot(fn) {
  const dir = mkdtempSync(join(tmpdir(), "validate-customers-"));
  const path = join(dir, "customers-snapshot.json");
  try {
    writeFileSync(path, JSON.stringify(buildSnapshot({ customers: parseCustomerCsv(CSV).rows, sourceGeneratedAt: "2026-01-01T00:00:00Z" })));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("validate-customers: measures the map GitHub has now, and says when it was generated", () => {
  const out = runStubbed("ok", CONFIGURED);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /map: 3 rows from GitHub \(CSV generated 2026-11-10\)/);
  assert.match(out.stdout, /forward: 2 customers \| with every data plane live: 2/);
  assert.match(out.stderr, /REQUEST https:\/\/api\.github\.com\/repos\/.*\/contents\//);
});

test("validate-customers: a CSV with no rows fails, with advice that applies", () => {
  // Regression: it advised checking the token, which had just worked, or
  // running refresh-customers, which refuses an empty CSV.
  const out = runStubbed("ok", CONFIGURED, CSV.split("\n")[0] + "\n");
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stdout, /map: 0 rows from GitHub/);
  assert.match(out.stderr, /The customer CSV has no rows, so nothing was validated: check the file that GRAFANA_CUSTOMER_MAP_REPO/);
  assert.doesNotMatch(out.stderr, /GITHUB_PERSONAL_ACCESS_TOKEN|refresh-customers/);
  assert.doesNotMatch(out.stdout, /forward:/);
});

test("validate-customers: GRAFANA_VALIDATE_MAX_STALE reaches the check", () => {
  // One customer whose data plane Loki has not seen: under the default
  // threshold it passes, and with the strict one it fails. Read under any other
  // name, the threshold would silently stay at its default.
  const csv = CSV + "globex,cp3333,cp3333-dp0001,europe,az,westeurope,None,None\n";
  const lenient = runStubbed("ok", CONFIGURED, csv);
  assert.equal(lenient.status, 0, lenient.stderr);
  assert.match(lenient.stdout, /with missing namespaces: 1/);
  const strict = runStubbed("ok", { ...CONFIGURED, GRAFANA_VALIDATE_MAX_STALE: "0" }, csv);
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stderr, /1 customers have missing namespaces \(threshold 0\)/);
});

test("validate-customers: a CSV without a column the map is read from fails, with nothing measured", () => {
  // Regression (#9 review): without ControlPlaneId or URLs every row lost that
  // field, and the check passed (exit 0).
  const out = runStubbed("ok", CONFIGURED, CSV.replace(",URLs", ",Hosts"));
  assert.equal(out.status, 1, out.stdout);
  assert.match(
    out.stderr,
    /The customer map from GitHub cannot be read: the customer CSV has no URLs column, which the map needs\. Nothing was validated\./,
  );
  assert.doesNotMatch(out.stdout, /forward:/);
});

test("validate-customers: a row it cannot use is measured around, then fails, naming its line", () => {
  const out = runStubbed("ok", CONFIGURED, CSV + "globex,cp3333,cp3333 dp0002,europe,az,westeurope,None,None\n");
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /map: 3 rows from GitHub, 1 left out \(CSV generated 2026-11-10\)/);
  assert.match(out.stdout, /forward: 2 customers \| with every data plane live: 2/);
  assert.match(out.stderr, /^ {2}line 5, globex: the data plane id is not /m);
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
