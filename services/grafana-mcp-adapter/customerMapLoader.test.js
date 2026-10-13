import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The loader reads its config at import time. Point the snapshot fallback at a
// temp file these tests control, so they never read a real local snapshot.
const DIR = await mkdtemp(join(tmpdir(), "customer-map-"));
const SNAPSHOT = join(DIR, "customers-snapshot.json");
process.env.GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH = SNAPSHOT;

const { loadCustomerMap, resetCustomerMapCache } = await import("./customerMapLoader.js");

const CSV = `Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs
acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-acme.us-aws-us-east-1.gateway.gravitee.io
`;

const SNAPSHOT_ROW = {
  customer: "beacon",
  control_plane_id: "cp1111",
  data_plane_id: "cp1111-dp0003",
  region: "unitedstates",
  provider: "aws",
  env: "dev",
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function writeSnapshot() {
  return writeFile(SNAPSHOT, JSON.stringify({ generated_at: "2026-09-01", customers: [SNAPSHOT_ROW] }));
}

// Answer the GitHub API: the CSV for the contents call, the last commit's date
// for the commits call. `csv: null` makes the contents call fail. Records the
// URLs requested.
function withGitHub({ csv = CSV, committedAt = daysAgo(2) } = {}, fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/commits?")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ commit: { committer: { date: committedAt } } }]),
      });
    }
    if (csv === null) return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(csv) });
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = origFetch;
  });
}

const contentsCalls = (calls) => calls.filter((u) => u.includes("/contents/")).length;

beforeEach(async () => {
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test";
  resetCustomerMapCache();
  await rm(SNAPSHOT, { force: true });
});

after(() => rm(DIR, { recursive: true, force: true }));

test("loadCustomerMap: a live fetch reports github as the source, with the CSV's commit date", async () => {
  await withGitHub({ committedAt: daysAgo(2) }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "github");
    assert.deepEqual(map.rows.map((r) => r.customer), ["acme"]);
    assert.equal(map.generated_days_ago, 2);
    assert.equal(map.warning, undefined);
  });
});

test("loadCustomerMap: a live map regenerated long ago is called stale, even though it was fetched live", async () => {
  await withGitHub({ committedAt: daysAgo(40) }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "github");
    assert.match(map.warning, /last regenerated 40 days ago/);
  });
});

test("loadCustomerMap: GitHub down falls back to the snapshot, and says so", async () => {
  await writeSnapshot();
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "bundled_snapshot");
    assert.deepEqual(map.rows, [SNAPSHOT_ROW]);
    assert.equal(map.generated_at, "2026-09-01");
    assert.match(map.warning, /bundled snapshot \(generated 2026-09-01\)/);
    assert.match(map.warning, /GitHub responded 503/);
  });
});

test("loadCustomerMap: without a token the snapshot answers and GitHub is never asked", async () => {
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  await writeSnapshot();
  await withGitHub({}, async (calls) => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "bundled_snapshot");
    assert.match(map.warning, /GITHUB_PERSONAL_ACCESS_TOKEN is not set/);
    assert.equal(calls.length, 0);
  });
});

test("loadCustomerMap: a CSV that parses to no rows is not taken as the map", async () => {
  await writeSnapshot();
  await withGitHub({ csv: "nothing,useful\n1,2\n" }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "bundled_snapshot");
    assert.match(map.warning, /parsed to zero rows/);
  });
});

test("loadCustomerMap: both sources gone gives an empty map marked unavailable, without throwing", async () => {
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "unavailable");
    assert.deepEqual(map.rows, []);
    assert.match(map.warning, /Customer mapping is unavailable/);
  });
});

test("loadCustomerMap: a loaded map is cached, and refresh fetches it again", async () => {
  await withGitHub({}, async (calls) => {
    await loadCustomerMap();
    await loadCustomerMap();
    assert.equal(contentsCalls(calls), 1);
    await loadCustomerMap({ refresh: true });
    assert.equal(contentsCalls(calls), 2);
  });
});

test("loadCustomerMap: concurrent calls on a cold cache share one fetch", async () => {
  await withGitHub({}, async (calls) => {
    const maps = await Promise.all([loadCustomerMap(), loadCustomerMap(), loadCustomerMap()]);
    assert.equal(contentsCalls(calls), 1);
    assert.ok(maps.every((m) => m.source === "github"));
  });
});
