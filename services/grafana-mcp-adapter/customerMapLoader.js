// Where the Gravitee Cloud customer map comes from.
//
// Fetched from GitHub at runtime so it is current, with a bundled snapshot as a
// fallback for when GitHub is unreachable. Which source answered is always
// reported: resolving a customer against stale data without saying so is exactly
// the kind of quiet wrongness this adapter exists to avoid.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log, RESTART_HINT } from "./grafanaClient.js";
import { githubGet } from "./githubClient.js";
import { parseCustomerCsv, rowProblem, describeLeftOut } from "./customerCsv.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// The snapshot next to this module: the file the image copies at build time and
// refresh-customers writes by default.
export const DEFAULT_SNAPSHOT_PATH = join(HERE, "customers-snapshot.json");
// Where the fallback is read from. Under Docker the override is a path inside the
// container, so it is read here only, never by the host-side refresh script; the
// tests point it at a file of their own and never read a real local snapshot.
const SNAPSHOT_PATH = process.env.GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH || DEFAULT_SNAPSHOT_PATH;

const REPO = process.env.GRAFANA_CUSTOMER_MAP_REPO || "gravitee-io/cloud-deployments-configuration";
const PATH = process.env.GRAFANA_CUSTOMER_MAP_PATH || "docs/summary/customers_summary.csv";
const REF = process.env.GRAFANA_CUSTOMER_MAP_REF || "prod";

// The numeric settings, with their defaults and the range a value must fall in.
// Defaults: customers are added over days, not seconds, so an hour of cache is
// plenty and keeps GitHub out of the hot path for a burst of tool calls; a log
// lookup must not hang because GitHub is slow, so the fetch gives up fast; a map
// older than 30 days is called out as stale.
// Every setting has an upper bound too, so the message always states the real
// range: a cache held for more than a day keeps a new customer unresolvable for
// that long, and a stale threshold past a year never warns.
// local_tooling/grafana.py has the same table, so `doctor` accepts exactly what
// the adapter accepts and reports a bad value before the adapter starts.
const NUMBER_SETTINGS = [
  { name: "GRAFANA_CUSTOMER_MAP_TTL_SECONDS", fallback: 3600, min: 1, max: 86400 },
  { name: "GRAFANA_CUSTOMER_MAP_TIMEOUT_MS", fallback: 5000, min: 1, max: 60000 },
  { name: "GRAFANA_CUSTOMER_MAP_STALE_DAYS", fallback: 30, min: 1, max: 365 },
];

// Empty or unset means the default; anything else must be a whole number in
// range. A value read as-is with Number() fails quietly: "abc" is NaN, and a NaN
// timeout aborts the GitHub fetch at once, a NaN TTL never caches, a NaN stale
// threshold calls every map stale. Returns the values by name, and one message
// per bad setting. `settings` defaults to the map's; validate-customers passes
// its own, so every number setting follows the one rule.
export function readNumberSettings(env = process.env, settings = NUMBER_SETTINGS) {
  const values = {};
  const errors = [];
  for (const { name, fallback, min, max } of settings) {
    const raw = String(env[name] ?? "").trim();
    const value = raw === "" ? fallback : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isSafeInteger(value) && value >= min && value <= max) {
      values[name] = value;
    } else {
      errors.push(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
    }
  }
  return { values, errors };
}

const SETTINGS = readNumberSettings();
const TTL_MS = SETTINGS.values.GRAFANA_CUSTOMER_MAP_TTL_SECONDS * 1000;
const FETCH_TIMEOUT_MS = SETTINGS.values.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS;
const STALE_AFTER_DAYS = SETTINGS.values.GRAFANA_CUSTOMER_MAP_STALE_DAYS;

// A bad setting stops every map load, and the scripts' fetch, with the
// setting's name, instead of running on a value it cannot use. In this process
// the tools that do not use the map are unaffected, but `local-tooling mcp
// grafana` checks the same values first (local_tooling/grafana.py) and does not
// start the adapter at all with a bad one.
function requireValidSettings() {
  if (!SETTINGS.errors.length) return;
  throw new Error(
    `Invalid customer map configuration: ${SETTINGS.errors.join("; ")}. Fix it in .env, or leave it ` +
      `empty for the default. ${RESTART_HINT}`,
  );
}

// A date the map's age can be read from: text Date.parse reads, at most a day
// ahead (a clock running a little fast is no reason to drop it). Anything else
// is an unknown date: one from the future would give the map a negative age, so
// it would never be called stale.
const DAY_MS = 86400000;
function readDate(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + DAY_MS ? value : null;
}

// A map fetched live can still be months out of date: the summary is a
// GENERATED file committed to its repo, so "fetched from GitHub" says nothing
// about when it was last regenerated, and a stale map fails by omission, which
// is the hardest kind of wrong to notice. Report the age rather than letting
// `source: "github"` imply currency, with a warning once it reaches
// STALE_AFTER_DAYS.
function staleness(generatedAt) {
  if (!generatedAt) return {};
  // readDate lets a date through up to a day ahead: that is today.
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / DAY_MS));
  if (!Number.isFinite(days)) return {};
  if (days < STALE_AFTER_DAYS) return { generated_days_ago: days };
  return {
    generated_days_ago: days,
    warning:
      `The customer map was last regenerated ${days} days ago (${String(generatedAt).slice(0, 10)}). It is a ` +
      "GENERATED file, so fetching it live does not make it current: deployments created since then are absent " +
      "entirely, and a customer that does not resolve may simply be missing rather than nonexistent. " +
      "Regenerate it by running docs/summary/generate_summary.py in the source repository.",
  };
}

let cache = null;
// When the cached map expires. A live map is kept for TTL_MS; a fallback (the
// snapshot, or no map at all) only for RETRY_AFTER_MS.
let cacheUntil = 0;
// Concurrent tool calls on a cold cache must not each fetch: they await the same
// request. Without this, a burst of calls at connect time all pay the round trip.
let inFlight = null;

// How long a fallback is kept before GitHub is asked again. Not keeping "no map"
// at all would make every map load during a GitHub outage, and so every
// grafana_logs_link call, even for a hosted customer, wait out the fetch timeout
// again; keeping the snapshot for the full TTL would hide GitHub's return for
// an hour. Fixed rather than a setting: it only bounds how often a failing
// GitHub is asked. Never longer than the TTL, so a fallback never outlives a
// live map.
const RETRY_AFTER_MS = 60_000;

function remember(map, lifetimeMs) {
  cache = map;
  cacheUntil = Date.now() + lifetimeMs;
  return map;
}

// The repository and the file as path segments. A leading, trailing or doubled
// "/" in a setting adds no empty segment; a "." or ".." stays, for githubGet to
// refuse.
const REPO_SEGMENTS = REPO.split("/").filter(Boolean);
const PATH_SEGMENTS = PATH.split("/").filter(Boolean);

// The date the source file was last COMMITTED, i.e. last regenerated. Best-effort:
// a failure here must not stop the map loading.
export async function fetchGeneratedAt() {
  try {
    const body = await githubGet(["repos", ...REPO_SEGMENTS, "commits"], {
      params: { path: PATH_SEGMENTS.join("/"), sha: REF, per_page: 1 },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const commit = JSON.parse(body)?.[0]?.commit;
    return readDate(commit?.committer?.date || commit?.author?.date);
  } catch {
    return null;
  }
}

export async function fetchCustomerCsv() {
  requireValidSettings();
  return githubGet(["repos", ...REPO_SEGMENTS, "contents", ...PATH_SEGMENTS], {
    params: { ref: REF },
    accept: "application/vnd.github.raw",
    timeoutMs: FETCH_TIMEOUT_MS,
  });
}

// The snapshot records two dates: when the source CSV was last generated
// (committed), which is what freshness is about, and when it was copied here.
// Refreshing an old CSV today must not make the fallback report a map generated
// today.
export function buildSnapshot({ customers, sourceGeneratedAt, refreshedAt = new Date().toISOString().slice(0, 10) }) {
  return {
    source_generated_at: sourceGeneratedAt || null,
    refreshed_at: refreshedAt,
    source: `${REPO}@${REF} ${PATH}`,
    note: "Slimmed deliberately: only what is needed to resolve a customer to a namespace. Customer hostnames and custom DNS are NOT included.",
    customers,
  };
}

// A snapshot that has `generated_at` instead of `refreshed_at` holds its copy
// date there: it is read as the refresh date and never passed off as the CSV's.
//
// A snapshot with no customers is no map at all, the same as a fetched CSV with
// no usable row: taking it would report a fallback map that resolves nobody
// instead of saying the map is unavailable.
//
// A snapshot is this adapter's own copy, which refresh-customers writes only
// from a CSV whose every row could be used. A row that cannot be used means the
// file is not such a copy, so none of it is used: a map missing that row would
// answer without it, and nothing would say so. The reasons thrown name no
// content of the file; a missing file keeps its `code`.
async function loadSnapshot() {
  const text = await readFile(SNAPSHOT_PATH, "utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("it is not valid JSON");
  }
  if (!Array.isArray(raw?.customers)) throw new Error("it has no customers list");
  if (!raw.customers.length) throw new Error("it has no customers");
  for (const [i, row] of raw.customers.entries()) {
    const problem = rowProblem(row);
    if (problem) throw new Error(`customers[${i}]: ${problem}`);
  }
  return {
    rows: raw.customers,
    source_generated_at: readDate(raw.source_generated_at),
    refreshed_at: readDate(raw.refreshed_at) || readDate(raw.generated_at),
  };
}

// Why the snapshot did not answer, for the unavailable map's warning. Not
// having one is the usual case and needs no detail.
function snapshotReason(err) {
  if (err?.code === "ENOENT") return "there is no bundled snapshot";
  return `the bundled snapshot cannot be used (${err?.code || (err instanceof Error ? err.message : String(err))})`;
}

// The rows of the live CSV that could not be used, at most three named.
const LEFT_OUT_SHOWN = 3;
function listLeftOut(leftOut) {
  const shown = leftOut.slice(0, LEFT_OUT_SHOWN).map(describeLeftOut).join("; ");
  return leftOut.length > LEFT_OUT_SHOWN ? `${shown}; and ${leftOut.length - LEFT_OUT_SHOWN} more` : shown;
}

function describeSnapshotDates(snap, days) {
  const refreshed = `refreshed ${snap.refreshed_at || "unknown"}`;
  if (!snap.source_generated_at) return `source CSV date unknown, ${refreshed}`;
  const ago = days === undefined ? "" : ` (${days} days ago)`;
  return `source CSV generated ${String(snap.source_generated_at).slice(0, 10)}${ago}, ${refreshed}`;
}

// Returns { rows, source, generated_at, warning }. `source` is always reported so
// a caller can tell a live answer from a fallback one.
export async function loadCustomerMap({ refresh = false } = {}) {
  requireValidSettings();
  if (!refresh && cache && Date.now() < cacheUntil) return cache;
  if (!refresh && inFlight) return inFlight;
  inFlight = loadCustomerMapUncached();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function loadCustomerMapUncached() {
  try {
    const { rows, leftOut } = parseCustomerCsv(await fetchCustomerCsv());
    if (!rows.length) {
      throw new Error(
        leftOut.length ? `no row of the customer CSV can be used: ${listLeftOut(leftOut)}` : "the customer CSV has no rows",
      );
    }
    const generatedAt = await fetchGeneratedAt();
    const { warning: staleWarning, ...age } = staleness(generatedAt);
    const warnings = [
      // No readable commit date means no age, and `source: "github"` alone must
      // not pass for a current map.
      age.generated_days_ago === undefined
        ? "The customer map was fetched from GitHub, but when it was last regenerated could not be read, " +
          "so its age is unknown. It is a GENERATED file: fetching it live does not make it current, and a " +
          "customer that does not resolve may simply be missing from it."
        : staleWarning,
      // A row left out is said on every answer: a customer on it resolves only
      // partly, or not at all, and the CSV is where it is fixed.
      leftOut.length
        ? `${leftOut.length === 1 ? "A row" : `${leftOut.length} rows`} of the customer CSV could not be used ` +
          `and ${leftOut.length === 1 ? "was" : "were"} left out (${listLeftOut(leftOut)}): a customer on ` +
          `${leftOut.length === 1 ? "it" : "them"} resolves only partly, or not at all, until the CSV is fixed.`
        : undefined,
    ].filter(Boolean);
    const live = {
      rows,
      source: "github",
      generated_at: generatedAt,
      ...age,
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
    return remember(live, TTL_MS);
  } catch (err) {
    log("warn", "Customer map: GitHub's map could not be used, falling back to the bundled snapshot", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const snap = await loadSnapshot();
      const { generated_days_ago: days } = staleness(snap.source_generated_at);
      const fallback = {
        rows: snap.rows,
        source: "bundled_snapshot",
        generated_at: snap.source_generated_at,
        ...(days !== undefined ? { generated_days_ago: days } : {}),
        warning:
          `Customer mapping came from the bundled snapshot (${describeSnapshotDates(snap, days)}), ` +
          `because the map could not be read from GitHub: ${err instanceof Error ? err.message : String(err)}. ` +
          "Customers created or moved since then will not resolve.",
      };
      return remember(fallback, Math.min(RETRY_AFTER_MS, TTL_MS));
    } catch (snapErr) {
      // Both sources gone: return an empty map rather than throwing, so the
      // logs tools still work for hosted customers, which need no mapping.
      log("error", "Customer map unavailable from both GitHub and the bundled snapshot", {
        github_error: err instanceof Error ? err.message : String(err),
        snapshot_error: snapErr instanceof Error ? snapErr.message : String(snapErr),
      });
      // Both reasons are said: the map is also unavailable for good when it was
      // never configured (no token), and "retry" would not help then; a
      // snapshot that is there but cannot be used is fixed by refreshing it.
      const none = {
        rows: [],
        source: "unavailable",
        generated_at: null,
        warning:
          `Customer mapping is unavailable: the map could not be read from GitHub (${err instanceof Error ? err.message : String(err)}) ` +
          `and ${snapshotReason(snapErr)}, so Gravitee Cloud customers cannot be resolved by name. ` +
          "Hosted namespaces are still found by name, but a customer that also runs on Gravitee Cloud gets only " +
          "its hosted part.",
      };
      return remember(none, Math.min(RETRY_AFTER_MS, TTL_MS));
    }
  }
}

// Test seam: drop the cache so a test or a refresh can start clean.
export function resetCustomerMapCache() {
  cache = null;
  cacheUntil = 0;
  inFlight = null;
}

// Start loading at server startup so the fetch overlaps the MCP handshake rather
// than landing in the middle of someone's first query. Fire-and-forget: a failure
// here is not fatal, the next call falls back to the snapshot as usual.
export function warmCustomerMap() {
  // An unreachable map resolves as unavailable, so what throws here is a bad
  // setting. Logged so it shows at startup, not only on the first map tool call.
  loadCustomerMap().catch((err) => {
    log("error", "Customer map not loaded", { error: err instanceof Error ? err.message : String(err) });
  });
}
