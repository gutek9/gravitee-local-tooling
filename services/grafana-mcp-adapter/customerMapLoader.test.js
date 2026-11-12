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

const { loadCustomerMap, resetCustomerMapCache, buildSnapshot, fetchGeneratedAt, readNumberSettings } = await import(
  "./customerMapLoader.js"
);

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

// The CSV was generated weeks before the snapshot was refreshed: the two dates
// must stay apart.
const CSV_COMMITTED_AT = daysAgo(40);

function writeSnapshot(
  content = buildSnapshot({ customers: [SNAPSHOT_ROW], sourceGeneratedAt: CSV_COMMITTED_AT, refreshedAt: "2026-10-09" }),
) {
  return writeFile(SNAPSHOT, JSON.stringify(content));
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
      return Promise.resolve(new Response(JSON.stringify([{ commit: { committer: { date: committedAt } } }])));
    }
    if (csv === null) return Promise.resolve(new Response("", { status: 503 }));
    return Promise.resolve(new Response(csv));
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

test("loadCustomerMap: a live map whose date cannot be read says its age is unknown", async () => {
  // Regression: no commit date meant no age and no warning, so `source: "github"`
  // read as a current map.
  // A date in the future too: it gave a negative age, so the map was never
  // called stale.
  for (const committedAt of [null, "not-a-date", daysAgo(-3)]) {
    resetCustomerMapCache();
    await withGitHub({ committedAt }, async () => {
      const map = await loadCustomerMap();
      assert.equal(map.source, "github");
      assert.equal(map.generated_days_ago, undefined);
      assert.match(map.warning, /its age is unknown/, `for committedAt=${committedAt}`);
    });
  }
});

test("loadCustomerMap: a commit date a few hours ahead of this clock is today, not unknown", async () => {
  await withGitHub({ committedAt: daysAgo(-0.25) }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.generated_days_ago, 0);
    assert.equal(map.warning, undefined);
  });
});

test("loadCustomerMap: a row of the live CSV it cannot use is left out, and the map's warning names it", async () => {
  // Regression (#9 review): such a row was taken as it was (a shifted row
  // searched a namespace that does not exist, reported as a stale map), or
  // dropped with nothing said.
  const shifted = "globex, inc,cp2222,cp2222-dp0001,europe,az,westeurope,None,None\n";
  const notAnId = (n) => `globex,cp2222,cp2222 dp000${n},europe,az,westeurope,None,None\n`;
  await withGitHub({ csv: CSV + shifted + notAnId(2), committedAt: daysAgo(40) }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "github");
    assert.deepEqual(map.rows.map((r) => r.data_plane_id), ["cp1111-dp0001"]);
    // Next to the stale warning, not instead of it.
    assert.match(map.warning, /^The customer map was last regenerated 40 days ago/);
    assert.ok(
      map.warning.endsWith(
        " 2 rows of the customer CSV could not be used and were left out (line 3: 9 fields where the header has 8; " +
          "line 4, globex: the data plane id is not lower-case letters and digits in dash-separated parts): a " +
          "customer on them resolves only partly, or not at all, until the CSV is fixed.",
      ),
      map.warning,
    );
  });
  // Three are named, then a count.
  resetCustomerMapCache();
  await withGitHub({ csv: CSV + [1, 2, 3, 4, 5].map(notAnId).join("") }, async () => {
    const map = await loadCustomerMap();
    assert.match(map.warning, /left out \(line 3, globex: [^;]+; line 4, [^;]+; line 5, [^;]+; and 2 more\)/);
  });
});

test("loadCustomerMap: GitHub down falls back to the snapshot, dated by its source CSV, not its refresh", async () => {
  // Regression (#9 review): the snapshot's only date was the refresh date, so
  // refreshing an old CSV today made the fallback report a map generated today.
  await writeSnapshot();
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "bundled_snapshot");
    assert.deepEqual(map.rows, [SNAPSHOT_ROW]);
    assert.equal(map.generated_at, CSV_COMMITTED_AT);
    assert.equal(map.generated_days_ago, 40);
    assert.match(
      map.warning,
      new RegExp(`bundled snapshot \\(source CSV generated ${CSV_COMMITTED_AT.slice(0, 10)} \\(40 days ago\\), refreshed 2026-10-09\\)`),
    );
    assert.match(map.warning, /GitHub responded 503/);
  });
});

test("loadCustomerMap: a snapshot from before the dates were split says its source date is unknown", async () => {
  // Its `generated_at` was the refresh date: kept as such, never shown as the
  // CSV's date or used for the map's age.
  await writeSnapshot({ generated_at: "2026-10-09", customers: [SNAPSHOT_ROW] });
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "bundled_snapshot");
    assert.equal(map.generated_at, null);
    assert.equal(map.generated_days_ago, undefined);
    assert.match(map.warning, /source CSV date unknown, refreshed 2026-10-09/);
  });
});

test("loadCustomerMap: an empty snapshot is not taken as a map, so the map is reported unavailable", async () => {
  // Regression: a snapshot with zero customers loaded as `bundled_snapshot` with
  // no rows, so no Cloud customer resolved and nothing said the map was empty.
  await writeSnapshot(buildSnapshot({ customers: [], sourceGeneratedAt: CSV_COMMITTED_AT }));
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "unavailable");
    assert.deepEqual(map.rows, []);
    assert.match(map.warning, /Customer mapping is unavailable/);
  });
});

test("buildSnapshot: records the CSV's date and the refresh date apart, and no customer hostnames", () => {
  const snap = buildSnapshot({ customers: [SNAPSHOT_ROW], sourceGeneratedAt: "2026-09-01T08:00:00Z", refreshedAt: "2026-10-09" });
  assert.equal(snap.source_generated_at, "2026-09-01T08:00:00Z");
  assert.equal(snap.refreshed_at, "2026-10-09");
  assert.equal(snap.generated_at, undefined);
  assert.deepEqual(snap.customers, [SNAPSHOT_ROW]);
  // An unreadable CSV date is recorded as unknown, never as today.
  assert.equal(buildSnapshot({ customers: [], sourceGeneratedAt: null }).source_generated_at, null);
});

test("fetchGeneratedAt: reads the CSV's last commit date, and gives null when GitHub fails", async () => {
  await withGitHub({ committedAt: "2026-09-01T08:00:00Z" }, async (calls) => {
    assert.equal(await fetchGeneratedAt(), "2026-09-01T08:00:00Z");
    assert.ok(calls[0].includes("/commits?path="));
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("", { status: 404 }));
  try {
    assert.equal(await fetchGeneratedAt(), null);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fetchGeneratedAt: without a token it sends nothing and gives null", async () => {
  // Regression: it sent the request anyway, with an empty Bearer header.
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  await withGitHub({}, async (calls) => {
    assert.equal(await fetchGeneratedAt(), null);
    assert.deepEqual(calls, []);
  });
});

// The loader reads its repository settings at import time: a fresh instance
// with these settings, restored afterwards.
async function loaderWith(settings) {
  const saved = Object.fromEntries(Object.keys(settings).map((k) => [k, process.env[k]]));
  Object.assign(process.env, settings);
  try {
    return await import(`./customerMapLoader.js?settings=${encodeURIComponent(JSON.stringify(settings))}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the CSV and its commit date are read from the same file, whatever the path setting contains", async () => {
  // Regression: the path went into the CSV's URL unencoded, so a "#" cut the URL
  // there. The CSV was read from another file, without ?ref, while the commit
  // date came from the right one.
  const loader = await loaderWith({ GRAFANA_CUSTOMER_MAP_PATH: "docs/summary/customers#v2.csv" });
  await withGitHub({}, async (calls) => {
    await loader.fetchCustomerCsv();
    await loader.fetchGeneratedAt();
    const [contents, commits] = calls.map((u) => new URL(u));
    assert.equal(
      decodeURIComponent(contents.pathname),
      "/repos/gravitee-io/cloud-deployments-configuration/contents/docs/summary/customers#v2.csv",
    );
    assert.equal(contents.searchParams.get("ref"), "prod");
    assert.equal(commits.searchParams.get("path"), "docs/summary/customers#v2.csv");
  });
});

test("the CSV and its commit date are read from the same branch", async () => {
  // Without the branch, GitHub dates the file on the repository's default
  // branch: a map read from another one would report that branch's age.
  const loader = await loaderWith({ GRAFANA_CUSTOMER_MAP_REF: "release-2026" });
  await withGitHub({}, async (calls) => {
    await loader.fetchCustomerCsv();
    await loader.fetchGeneratedAt();
    const [contents, commits] = calls.map((u) => new URL(u));
    assert.equal(contents.searchParams.get("ref"), "release-2026");
    assert.equal(commits.searchParams.get("sha"), "release-2026");
  });
});

test("a repository setting with a '..' segment is refused before GitHub is asked", async () => {
  const loader = await loaderWith({ GRAFANA_CUSTOMER_MAP_REPO: "gravitee-io/.." });
  await withGitHub({}, async (calls) => {
    await assert.rejects(loader.fetchCustomerCsv(), /"\." and "\.\." segments are not allowed/);
    assert.equal(await loader.fetchGeneratedAt(), null);
    assert.deepEqual(calls, []);
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

test("loadCustomerMap: a CSV it cannot read as the map is not taken, and the warning says why", async () => {
  await writeSnapshot();
  for (const [csv, reason] of [
    ["nothing,useful\n1,2\n", "the customer CSV has none of the columns the map needs"],
    [CSV.replace(",URLs", ",Hosts"), "the customer CSV has no URLs column, which the map needs"],
    [CSV.split("\n")[0] + "\n", "the customer CSV has no rows"],
    [CSV.replace("cp1111-dp0001", "cp1111 dp0001"), "no row of the customer CSV can be used: line 2, acme: the data plane id"],
  ]) {
    resetCustomerMapCache();
    await withGitHub({ csv }, async () => {
      const map = await loadCustomerMap();
      assert.equal(map.source, "bundled_snapshot");
      assert.ok(map.warning.includes(`because the map could not be read from GitHub: ${reason}`), map.warning);
    });
  }
});

test("loadCustomerMap: both sources gone gives an empty map marked unavailable, without throwing", async () => {
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "unavailable");
    assert.deepEqual(map.rows, []);
    assert.match(map.warning, /Customer mapping is unavailable/);
  });
});

test("loadCustomerMap: an unavailable map says why GitHub could not be read", async () => {
  // Regression: it only said "GitHub unreachable", so a map that was never
  // configured (no token) read like a passing outage worth retrying.
  await withGitHub({ csv: null }, async () => {
    const map = await loadCustomerMap();
    assert.match(map.warning, /the map could not be read from GitHub \(GitHub responded 503\) and there is no bundled snapshot,/);
  });
  resetCustomerMapCache();
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  await withGitHub({}, async (calls) => {
    const map = await loadCustomerMap();
    assert.equal(map.source, "unavailable");
    assert.match(map.warning, /the map could not be read from GitHub \(GITHUB_PERSONAL_ACCESS_TOKEN is not set\)/);
    assert.equal(contentsCalls(calls), 0);
  });
});

test("loadCustomerMap: a snapshot with a row it cannot use is not used at all, and the warning says why", async () => {
  // Regression (#9 review): a snapshot row without a data plane id loaded, and
  // both map tools then threw "Cannot read properties of undefined".
  for (const [customers, reason] of [
    [[{ customer: "acme" }], "customers[0]: no data plane id"],
    [[SNAPSHOT_ROW, null], "customers[1]: not a row"],
    [
      [SNAPSHOT_ROW, { ...SNAPSHOT_ROW, data_plane_id: 'cp1111-dp"3' }],
      "customers[1]: the data plane id is not lower-case letters and digits in dash-separated parts",
    ],
    [[{ ...SNAPSHOT_ROW, control_plane_id: "cp9999" }], "customers[0]: the control plane id is not the start of the data plane id"],
  ]) {
    resetCustomerMapCache();
    await writeSnapshot(buildSnapshot({ customers, sourceGeneratedAt: CSV_COMMITTED_AT }));
    await withGitHub({ csv: null }, async () => {
      const map = await loadCustomerMap();
      assert.equal(map.source, "unavailable");
      assert.deepEqual(map.rows, []);
      assert.ok(map.warning.includes(` and the bundled snapshot cannot be used (${reason}), so `), map.warning);
    });
  }
});

test("loadCustomerMap: a snapshot file that is not a snapshot says so, and never quotes the file", async () => {
  for (const [content, reason] of [
    ["not json, but acme-secret.example", "it is not valid JSON"],
    ["null", "it has no customers list"],
    [JSON.stringify({ customers: { acme: 1 } }), "it has no customers list"],
    [JSON.stringify({ customers: [] }), "it has no customers"],
  ]) {
    resetCustomerMapCache();
    await writeFile(SNAPSHOT, content);
    await withGitHub({ csv: null }, async () => {
      const map = await loadCustomerMap();
      assert.equal(map.source, "unavailable");
      assert.ok(map.warning.includes(` and the bundled snapshot cannot be used (${reason}), so `), map.warning);
      assert.doesNotMatch(map.warning, /acme-secret/);
    });
  }
});

test("loadCustomerMap: a snapshot date that cannot be read, or lies in the future, is an unknown date", async () => {
  // Regression (#9 review): a source date in 2099 gave the map a negative age,
  // so it was never called stale; a refresh date that was not text was printed
  // as "[object Object]".
  for (const [dates, refreshed] of [
    [{ source_generated_at: "2099-01-01T00:00:00Z", refreshed_at: "2026-10-09" }, "2026-10-09"],
    [{ source_generated_at: "last tuesday", refreshed_at: { day: 9 } }, "unknown"],
  ]) {
    resetCustomerMapCache();
    await writeSnapshot({ ...dates, customers: [SNAPSHOT_ROW] });
    await withGitHub({ csv: null }, async () => {
      const map = await loadCustomerMap();
      assert.equal(map.source, "bundled_snapshot");
      assert.equal(map.generated_at, null);
      assert.equal(map.generated_days_ago, undefined);
      assert.ok(map.warning.includes(`(source CSV date unknown, refreshed ${refreshed})`), map.warning);
    });
  }
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

// ---------------------------------------------------------------------------
// Numeric settings
// ---------------------------------------------------------------------------

test("readNumberSettings: empty or unset settings take the documented defaults", () => {
  assert.deepEqual(readNumberSettings({}), {
    values: {
      GRAFANA_CUSTOMER_MAP_TTL_SECONDS: 3600,
      GRAFANA_CUSTOMER_MAP_TIMEOUT_MS: 5000,
      GRAFANA_CUSTOMER_MAP_STALE_DAYS: 30,
    },
    errors: [],
  });
  // Compose forwards an unset variable as "", and .env.example lists them empty.
  const blank = readNumberSettings({
    GRAFANA_CUSTOMER_MAP_TTL_SECONDS: "",
    GRAFANA_CUSTOMER_MAP_TIMEOUT_MS: "  ",
    GRAFANA_CUSTOMER_MAP_STALE_DAYS: "",
  });
  assert.deepEqual(blank.errors, []);
  assert.equal(blank.values.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS, 5000);
});

test("readNumberSettings: whole numbers in range are used as given", () => {
  const { values, errors } = readNumberSettings({
    GRAFANA_CUSTOMER_MAP_TTL_SECONDS: "120",
    GRAFANA_CUSTOMER_MAP_TIMEOUT_MS: "60000",
    GRAFANA_CUSTOMER_MAP_STALE_DAYS: "1",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(values, {
    GRAFANA_CUSTOMER_MAP_TTL_SECONDS: 120,
    GRAFANA_CUSTOMER_MAP_TIMEOUT_MS: 60000,
    GRAFANA_CUSTOMER_MAP_STALE_DAYS: 1,
  });
});

// Regression: these were read with Number() unchecked, so "abc" became NaN and
// the fetch aborted at once, the cache never held, or every map read as stale.
test("readNumberSettings: a value that is not a whole number in range is refused by name", () => {
  for (const bad of ["abc", "0", "-5", "1.5", "1e3", "12abc"]) {
    const { values, errors } = readNumberSettings({ GRAFANA_CUSTOMER_MAP_TTL_SECONDS: bad });
    assert.equal(values.GRAFANA_CUSTOMER_MAP_TTL_SECONDS, undefined, bad);
    assert.deepEqual(errors, [`GRAFANA_CUSTOMER_MAP_TTL_SECONDS must be a whole number from 1 to 86400, got "${bad}"`], bad);
  }
  // The timeout is bounded: a log lookup must not wait minutes for GitHub.
  assert.deepEqual(readNumberSettings({ GRAFANA_CUSTOMER_MAP_TIMEOUT_MS: "60001" }).errors, [
    'GRAFANA_CUSTOMER_MAP_TIMEOUT_MS must be a whole number from 1 to 60000, got "60001"',
  ]);
  // Every bad setting is reported, not only the first.
  const both = readNumberSettings({ GRAFANA_CUSTOMER_MAP_TIMEOUT_MS: "x", GRAFANA_CUSTOMER_MAP_STALE_DAYS: "y" });
  assert.equal(both.errors.length, 2);
});

// The same table as test_customer_map_number_limits_match_the_adapter in
// tests/test_local_tooling.py: doctor and the adapter must accept exactly the
// same values.
const NUMBER_LIMITS = [
  ["GRAFANA_CUSTOMER_MAP_TTL_SECONDS", 86400],
  ["GRAFANA_CUSTOMER_MAP_TIMEOUT_MS", 60000],
  ["GRAFANA_CUSTOMER_MAP_STALE_DAYS", 365],
];

// Regression: TTL and stale days had no upper bound in doctor, while the
// adapter refused anything past 2^53 with "of 1 or more", so doctor passed a
// value the adapter then refused on every map load, saying nothing true about why.
test("readNumberSettings: every setting has an upper bound, the same as doctor's", () => {
  for (const [name, max] of NUMBER_LIMITS) {
    for (const good of ["1", String(max)]) {
      assert.deepEqual(readNumberSettings({ [name]: good }).errors, [], `${name}=${good}`);
    }
    for (const bad of ["0", String(max + 1), "9007199254740993"]) {
      assert.deepEqual(
        readNumberSettings({ [name]: bad }).errors,
        [`${name} must be a whole number from 1 to ${max}, got "${bad}"`],
        `${name}=${bad}`,
      );
    }
  }
});

test("loadCustomerMap: a bad numeric setting stops the map loading, naming it, before any GitHub call", async () => {
  // The loader reads its settings at import, so load a separate copy of it with
  // the bad value set, then put the environment back.
  const before = process.env.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS;
  process.env.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS = "abc";
  let loader;
  try {
    loader = await import("./customerMapLoader.js?bad-timeout");
  } finally {
    if (before === undefined) delete process.env.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS;
    else process.env.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS = before;
  }
  await withGitHub({}, async (calls) => {
    const named = /GRAFANA_CUSTOMER_MAP_TIMEOUT_MS must be a whole number from 1 to 60000, got "abc"/;
    await assert.rejects(loader.loadCustomerMap(), named);
    // Regression: it said to run `docker compose up -d --force-recreate`, which
    // never reaches the container the agent starts for each session.
    await assert.rejects(
      loader.loadCustomerMap(),
      (err) => /restart your agent/.test(err.message) && !/force-recreate/.test(err.message),
    );
    // The refresh script's fetch is stopped the same way.
    await assert.rejects(loader.fetchCustomerCsv(), named);
    assert.deepEqual(calls, []);
  });
});

// ---------------------------------------------------------------------------
// How long a fallback is kept
// ---------------------------------------------------------------------------

// The tests move the clock with a stub of Date.now, so a minute passes at once.
const MINUTE = 60_000;

// Regression: "no map" was not kept at all, so during a GitHub outage every map
// load, and every grafana_logs_link call, waited out the fetch timeout again.
test("loadCustomerMap: with both sources down, GitHub is not asked again for a minute", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await withGitHub({ csv: null }, async (calls) => {
    for (let i = 0; i < 3; i++) {
      const map = await loadCustomerMap();
      assert.equal(map.source, "unavailable");
      assert.match(map.warning, /Customer mapping is unavailable/);
    }
    assert.equal(contentsCalls(calls), 1);
    now += MINUTE + 1000;
    await loadCustomerMap();
    assert.equal(contentsCalls(calls), 2);
  });
});

test("loadCustomerMap: an unavailable map recovers once GitHub answers again", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await withGitHub({ csv: null }, () => loadCustomerMap());
  await withGitHub({}, async (calls) => {
    // Within the minute the failure is remembered, and GitHub is left alone.
    assert.equal((await loadCustomerMap()).source, "unavailable");
    assert.equal(contentsCalls(calls), 0);
    now += MINUTE + 1000;
    assert.equal((await loadCustomerMap()).source, "github");
  });
});

test("loadCustomerMap: refresh asks GitHub even while a failure is remembered", async () => {
  await withGitHub({ csv: null }, () => loadCustomerMap());
  await withGitHub({}, async () => {
    assert.equal((await loadCustomerMap({ refresh: true })).source, "github");
  });
});

// Regression: the snapshot was kept for the full TTL, so GitHub's return went
// unnoticed for an hour.
test("loadCustomerMap: a snapshot fallback is kept a minute, not the TTL, so GitHub's return is picked up", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await writeSnapshot();
  await withGitHub({ csv: null }, async () => {
    assert.equal((await loadCustomerMap()).source, "bundled_snapshot");
  });
  await withGitHub({}, async (calls) => {
    now += MINUTE / 2;
    assert.equal((await loadCustomerMap()).source, "bundled_snapshot");
    assert.equal(contentsCalls(calls), 0);
    now += MINUTE;
    assert.equal((await loadCustomerMap()).source, "github");
  });
});

test("loadCustomerMap: a live map is still kept for the whole TTL", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await withGitHub({}, async (calls) => {
    await loadCustomerMap();
    now += MINUTE + 1000;
    await loadCustomerMap();
    assert.equal(contentsCalls(calls), 1);
    now += 60 * MINUTE;
    await loadCustomerMap();
    assert.equal(contentsCalls(calls), 2);
  });
});
