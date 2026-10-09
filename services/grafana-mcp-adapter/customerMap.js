// Customer -> namespace mapping for Gravitee Cloud (Cockpit) tenants.
//
// Cockpit customers do not carry their name anywhere in their Loki labels. A
// tenant lives in `apim-dp-<controlPlaneId>-<dataPlaneId>`, so a free-text search
// for "acme" matches nothing at all — the customers this tooling is most
// useful for were the ones it could not find. The mapping from customer name to
// those ids lives in cloud-deployments-configuration/docs/summary.
//
// Fetched from GitHub at runtime so it is current, with a bundled snapshot as a
// fallback for when GitHub is unreachable. Which source answered is always
// reported: resolving a customer against stale data without saying so is exactly
// the kind of quiet wrongness this adapter exists to avoid.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "./grafanaClient.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, "customers-snapshot.json");

const REPO = process.env.GRAFANA_CUSTOMER_MAP_REPO || "gravitee-io/cloud-deployments-configuration";
const PATH = process.env.GRAFANA_CUSTOMER_MAP_PATH || "docs/summary/customers_summary.csv";
const REF = process.env.GRAFANA_CUSTOMER_MAP_REF || "prod";
// Customers are added over days, not seconds; an hour of cache is plenty and
// keeps GitHub out of the hot path for a burst of tool calls.
const TTL_MS = Number(process.env.GRAFANA_CUSTOMER_MAP_TTL_SECONDS || 3600) * 1000;
// A log lookup must not hang because GitHub is slow. Fall back fast instead.
const FETCH_TIMEOUT_MS = Number(process.env.GRAFANA_CUSTOMER_MAP_TIMEOUT_MS || 5000);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Minimal RFC4180-ish CSV reader. Needed because the URLs and Custom DNS columns
// are quoted lists that themselves contain commas — splitting on "," loses the
// column alignment and silently shifts every field after them.
export function parseCsv(text = "") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text).replace(/\r\n/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

// The deployment's environment is the prefix of its gravitee.io gateway host
// (`prod-org-acme...`). We keep only that derived word, never the hostnames
// themselves: the snapshot is committed to a repo, and customer DNS is not
// needed to resolve a namespace.
export function extractEnv(urls = "") {
  for (const raw of String(urls).split(",")) {
    const host = raw.trim();
    const m = /^([a-z0-9-]+?)-org-.*\.gateway\.gravitee\.io$/i.exec(host);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// `trial-tt0001-dp0011` -> `trial-tt0001`, the identifier a trial is known by.
const TRIAL_ID_RE = /^(trial-[0-9a-z]+)-/i;

// Turn the CSV into the minimum needed to resolve a customer to namespaces.
export function parseCustomerCsv(text = "") {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iCustomer = idx("Customer");
  const iCp = idx("ControlPlaneId");
  const iDp = idx("DataPlaneId");
  const iRegion = idx("Region");
  const iProvider = idx("Provider");
  const iUrls = idx("URLs");
  if (iCustomer === -1 || iDp === -1) return [];

  const out = [];
  for (const r of rows.slice(1)) {
    const customer = (r[iCustomer] || "").trim();
    const dataPlaneId = (r[iDp] || "").trim();
    if (!dataPlaneId) continue;

    // Trial tenants have no customer name at all — the CSV carries "N/A". They
    // are still findable, by the identifier they DO have, which is embedded in
    // the data plane id: `trial-tt0001-dp0011` belongs to trial `trial-tt0001`.
    // Dropping them made a whole population invisible to every tool.
    //
    // Their control plane id needs deriving too. The CSV's value is the literal
    // string "trial", which would build `apim-cp-trial` — verified against Loki,
    // the real namespaces are `apim-cp-trial-<id>` and `apim-dp-<id>-<dp>`.
    const trial = TRIAL_ID_RE.exec(dataPlaneId);
    const isTrial = trial !== null || customer.toUpperCase() === "N/A";
    if (isTrial && !trial) continue; // no name and no trial id: genuinely unusable
    const slug = isTrial ? trial[1].toLowerCase() : customer.toLowerCase();
    if (!slug) continue;

    out.push({
      customer: slug,
      control_plane_id: isTrial ? trial[1] : (r[iCp] || "").trim(),
      data_plane_id: dataPlaneId,
      region: (r[iRegion] || "").trim() || null,
      provider: (r[iProvider] || "").trim() || null,
      env: iUrls === -1 ? null : extractEnv(r[iUrls]),
      ...(isTrial ? { is_trial: true } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export const dataPlaneNamespace = (dataPlaneId) => `apim-dp-${dataPlaneId}`;
export const controlPlaneNamespace = (controlPlaneId) => `apim-cp-${controlPlaneId}`;

// Match a free-text customer fragment against the CSV's customer slugs. Exact
// matches win outright: "orbit" must not also drag in a slug that merely contains
// it. Only when nothing matches exactly do we fall back to substring matching.
export function matchCustomers(rows = [], core = "") {
  const needle = String(core || "").trim().toLowerCase();
  if (!needle) return [];
  const exact = rows.filter((r) => r.customer === needle);
  if (exact.length) return exact;
  const words = needle.split(/\s+/).filter(Boolean);
  return rows.filter((r) => words.every((w) => r.customer.includes(w)));
}

// Look a customer up by the ONLY handle a Cockpit tenant really has: its ids.
// Support sees `apim-dp-cp1111-dp0001` in an alert, a pod name or a dashboard —
// never a customer name — so "whose is this?" is the question that actually gets
// asked, and it is the reverse of what name search answers.
//
// Also covers the partially-known case. The CSV does not list every live data
// plane (measured: 116 live ones are absent, 49 of them on a control plane the
// CSV does know). For those, the control plane still narrows the field from 148
// customers to the handful sharing it — reported as candidates, never as an
// answer, because a control plane is shared.
export function lookupById(rows = [], query = "") {
  const id = String(query || "").trim().toLowerCase().replace(/^apim-(dp|cp)-/, "");
  if (!id) return null;

  const byDataPlane = rows.filter((r) => r.data_plane_id.toLowerCase() === id);
  if (byDataPlane.length) {
    return { kind: "data_plane", id, customer: byDataPlane[0].customer, deployments: byDataPlane };
  }

  const byControlPlane = rows.filter((r) => String(r.control_plane_id).toLowerCase() === id);
  if (byControlPlane.length) {
    const customers = [...new Set(byControlPlane.map((r) => r.customer))].sort();
    return {
      kind: "control_plane",
      id,
      customers,
      note:
        customers.length > 1
          ? `Control plane ${id} is shared by ${customers.length} customers (${customers.join(", ")}). ` +
            "A log search scoped to it would mix them."
          : undefined,
    };
  }

  // Unlisted data plane: fall back to its control plane, if that much is known.
  const cpPart = id.split("-").slice(0, -1).join("-");
  const siblings = cpPart ? rows.filter((r) => String(r.control_plane_id).toLowerCase() === cpPart) : [];
  if (siblings.length) {
    const candidates = [...new Set(siblings.map((r) => r.customer))].sort();
    return {
      kind: "unlisted_data_plane",
      id,
      control_plane_id: cpPart,
      candidate_customers: candidates,
      note:
        `Data plane ${id} is not in the customer map, but its control plane ${cpPart} is, and hosts ` +
        `${candidates.join(", ")}. It probably belongs to one of them — the map does not say which, so this is ` +
        "a lead, not an attribution.",
    };
  }

  return { kind: "unknown", id, note: `Neither ${id} nor its control plane appears in the customer map.` };
}

// Summarise one customer for a disambiguation prompt: enough to choose between
// candidates without dumping every deployment.
function describeCustomer(rows) {
  return {
    customer: rows[0].customer,
    deployments: rows.length,
    control_planes: [...new Set(rows.map((r) => r.control_plane_id).filter(Boolean))],
    envs: [...new Set(rows.map((r) => r.env).filter(Boolean))].sort(),
    regions: [...new Set(rows.map((r) => r.region).filter(Boolean))].sort(),
  };
}

export function groupByCustomer(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.customer)) groups.set(r.customer, []);
    groups.get(r.customer).push(r);
  }
  return groups;
}

// Resolve a customer (and optional env words) to the namespaces to search.
//
// Two separate hazards, handled differently because they are not the same thing:
//
//  1. A fragment matching SEVERAL customers ("man" -> northwind, southwind; "co" ->
//     six of them). Merging those returns one customer's logs under another
//     customer's name. That is a data-boundary problem, so it is refused, not
//     ranked — the caller gets the candidates and picks.
//
//  2. ONE customer spanning several control planes, i.e. several Cockpit
//     organizations sharing a name (12 of 148 do; `gravitee` spans 11). Every
//     result really does belong to the name asked for, so this resolves — but it
//     is reported, because "22 namespaces across 11 organizations" is a materially
//     different answer from what the caller probably pictured.
//
// Data-plane namespaces only, by default. A control-plane namespace is SHARED by
// every customer on that control plane (apim-cp-cp1111 carries beacon,
// thirdco and acme together), so including it would return one
// customer's logs under another's name — wrong, and a data-boundary problem, not
// just a precision one.
// Split a free-text phrase into a customer the map knows and a tail describing
// the deployment, by asking the map instead of a word list.
//
// The old split classified each word against 16 known environment names. Anything
// it had not seen stayed part of the customer name, so the name matched nobody:
// measured across the whole map, 39 of 416 deployments could not be resolved at
// all — `acme recette`, `beacon staging`, `orbit gatewaytesting`, and
// `production` failing where `prod` worked.
export function splitNameAndTail(rows = [], phrase = "") {
  const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
  for (let n = words.length; n > 0; n--) {
    const core = words.slice(0, n).join(" ");
    if (matchCustomers(rows, core).length) return { core, tail: words.slice(n) };
  }
  return { core: words.join(" "), tail: [] };
}

const normalise = (v) => String(v || "").toLowerCase().replace(/[\s_-]/g, "");

// Does this deployment answer to that word? Environment, region and provider are
// all things a person says out loud ("acme dev europe"), and region separates 30
// of the 46 customer+environment pairs that have more than one deployment.
function qualifierMatches(row, word) {
  const w = normalise(word);
  if (!w) return true;
  return [row.env, row.region, row.provider].some((v) => {
    const n = normalise(v);
    return n && (n === w || (w.length >= 3 && n.startsWith(w)));
  });
}

export function resolveCustomerNamespaces(rows = [], { core, envs = [], qualifiers = [], includeControlPlane = false, controlPlaneId } = {}) {
  const matched = matchCustomers(rows, core);
  if (!matched.length) return { matched: [], namespaces: [], control_plane_namespaces: [] };

  // Hazard 1: refuse to merge distinct customers.
  const groups = groupByCustomer(matched);
  if (groups.size > 1) {
    const candidates = [...groups.values()].map(describeCustomer).sort((a, b) => a.customer.localeCompare(b.customer));
    return {
      matched: [],
      namespaces: [],
      control_plane_namespaces: [],
      ambiguous: true,
      candidates,
      reason:
        `"${core}" matches ${candidates.length} different customers (${candidates.map((c) => c.customer).join(", ")}). ` +
        "Searching them together would return one customer's logs under another's name, so nothing was searched. " +
        "Use the exact customer name.",
    };
  }

  const wanted = envs.map((e) => String(e).toLowerCase());
  // Env words only narrow when they actually select something; a customer with no
  // matching env is better served by all of its deployments than by none.
  const envFiltered = wanted.length ? matched.filter((r) => r.env && wanted.includes(r.env)) : [];
  // Free-text qualifiers (the tail of the phrase) are matched against what the
  // deployment actually is, not against a list of allowed words.
  const quals = (qualifiers || []).map(String).filter(Boolean);
  const qualFiltered = quals.length ? matched.filter((r) => quals.every((q) => qualifierMatches(r, q))) : [];
  const rowsToUse = qualFiltered.length ? qualFiltered : envFiltered.length ? envFiltered : matched;
  // A tail that describes none of this customer's deployments is reported, with
  // what they do have — the answer to "what if the word matches no environment?".
  const unknownQualifiers = quals.length && !qualFiltered.length ? quals : [];

  // A trial's control plane is its own: `apim-cp-trial-tt0002` hosts exactly that
  // trial (verified — every trial control plane maps to a single trial), unlike
  // `apim-cp-cp1111`, which carries three different customers. So for trials the
  // control-plane namespace is single-tenant and safe to search, and is included
  // deliberately rather than arriving by accident through the namespace matcher.
  const allTrials = rowsToUse.length > 0 && rowsToUse.every((r) => r.is_trial);

  // Optional narrowing to one organization when a name spans several.
  const cpFiltered = controlPlaneId ? rowsToUse.filter((r) => r.control_plane_id === controlPlaneId) : rowsToUse;

  // An id that narrows to nothing is refused, never ignored. Falling back to
  // every deployment would turn a filter into a widening: a mistyped or foreign
  // id would return all of the customer's organizations as if they were the one
  // asked for.
  if (controlPlaneId && !cpFiltered.length) {
    const valid = [...new Set(rowsToUse.map((r) => r.control_plane_id).filter(Boolean))].sort();
    const ownsIt = matched.some((r) => r.control_plane_id === controlPlaneId);
    return {
      matched: [],
      namespaces: [],
      control_plane_namespaces: [],
      unknown_control_plane: true,
      requested_control_plane_id: controlPlaneId,
      control_plane_ids: valid,
      reason: ownsIt
        ? `"${controlPlaneId}" is one of ${matched[0].customer}'s Cockpit organizations, but none of the ` +
          `deployments matching ${quals.length ? `"${quals.join(" ")}"` : "the requested environment"} is on it ` +
          `(those are on: ${valid.join(", ")}). Nothing was searched.`
        : `"${controlPlaneId}" is not one of ${matched[0].customer}'s Cockpit organizations ` +
          `(${valid.join(", ")}). Nothing was searched.`,
    };
  }
  const finalRows = cpFiltered;

  const namespaces = [...new Set(finalRows.map((r) => dataPlaneNamespace(r.data_plane_id)))];
  const controlPlanes = [...new Set(finalRows.map((r) => r.control_plane_id).filter(Boolean).map(controlPlaneNamespace))];
  const orgs = [...new Set(finalRows.map((r) => r.control_plane_id).filter(Boolean))];

  return {
    matched: finalRows,
    namespaces: includeControlPlane || allTrials ? [...namespaces, ...controlPlanes] : namespaces,
    control_plane_namespaces: controlPlanes,
    ...(allTrials ? { control_plane_is_single_tenant: true } : {}),
    env_filter_applied: envFiltered.length > 0 || qualFiltered.length > 0,
    ...(unknownQualifiers.length
      ? {
          unknown_qualifiers: unknownQualifiers,
          known_environments: [...new Set(matched.map((r) => r.env).filter(Boolean))].sort(),
          known_regions: [...new Set(matched.map((r) => r.region).filter(Boolean))].sort(),
          qualifier_note:
            `"${unknownQualifiers.join(" ")}" does not describe any deployment of ${matched[0].customer}: ` +
            "all of their deployments are included instead. The environments and regions they do have are listed here.",
        }
      : {}),
    control_plane_ids: orgs,
    // Hazard 2: same name, several Cockpit organizations. Resolved, but said out
    // loud so a very wide answer is not mistaken for a precise one.
    ...(orgs.length > 1
      ? {
          spans_multiple_organizations: true,
          organizations_note:
            `"${core}" resolves to ${namespaces.length} deployments across ${orgs.length} separate Cockpit ` +
            `organizations (control planes: ${orgs.join(", ")}). They share a name but are distinct tenants. ` +
            "Pass control_plane_id, or add an env word, to narrow to one.",
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Loading: GitHub first, bundled snapshot as the fallback
// ---------------------------------------------------------------------------

// A map fetched live can still be months out of date. Report the age rather than
// letting `source: "github"` imply currency.
function staleness(generatedAt) {
  if (!generatedAt) return {};
  const days = Math.floor((Date.now() - Date.parse(generatedAt)) / 86400000);
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
let cachedAt = 0;
// Concurrent tool calls on a cold cache must not each fetch: they await the same
// request. Without this, a burst of calls at connect time all pay the round trip.
let inFlight = null;

// How old the map may be before it is called out. The summary is a GENERATED
// artifact committed to its repo, so "fetched from GitHub" says nothing about
// when it was last regenerated — and a stale map fails by omission, which is the
// hardest kind of wrong to notice.
const STALE_AFTER_DAYS = Number(process.env.GRAFANA_CUSTOMER_MAP_STALE_DAYS || 30);

// The date the source file was last COMMITTED, i.e. last regenerated. Best-effort:
// a failure here must not stop the map loading.
async function fetchGeneratedAt(token) {
  try {
    const url =
      `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(PATH)}` +
      `&sha=${encodeURIComponent(REF)}&per_page=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "grafana-mcp-adapter" },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const commits = await res.json();
      return commits?.[0]?.commit?.committer?.date || commits?.[0]?.commit?.author?.date || null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

async function fetchFromGitHub() {
  const token = (process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN is not set");
  const url = `https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${encodeURIComponent(REF)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "User-Agent": "grafana-mcp-adapter",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSnapshot() {
  const raw = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  return { rows: raw.customers || [], generated_at: raw.generated_at || null };
}

// Returns { rows, source, generated_at, warning }. `source` is always reported so
// a caller can tell a live answer from a fallback one.
export async function loadCustomerMap({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
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
    const rows = parseCustomerCsv(await fetchFromGitHub());
    if (!rows.length) throw new Error("fetched customer CSV parsed to zero rows");
    const generatedAt = await fetchGeneratedAt((process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim());
    cache = { rows, source: "github", generated_at: generatedAt, ...staleness(generatedAt) };
    cachedAt = Date.now();
    return cache;
  } catch (err) {
    log("warn", "Customer map: GitHub fetch failed, falling back to bundled snapshot", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const snap = await loadSnapshot();
      cache = {
        rows: snap.rows,
        source: "bundled_snapshot",
        generated_at: snap.generated_at,
        warning:
          `Customer mapping came from the bundled snapshot (generated ${snap.generated_at || "unknown"}), ` +
          `because GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}. ` +
          "Customers created or moved since then will not resolve.",
      };
      cachedAt = Date.now();
      return cache;
    } catch (snapErr) {
      // Both sources gone: return an empty map rather than throwing, so the
      // logs tools still work for hosted customers, which need no mapping.
      log("error", "Customer map unavailable from both GitHub and the bundled snapshot", {
        github_error: err instanceof Error ? err.message : String(err),
        snapshot_error: snapErr instanceof Error ? snapErr.message : String(snapErr),
      });
      return {
        rows: [],
        source: "unavailable",
        generated_at: null,
        warning:
          "Customer mapping is unavailable (GitHub unreachable and no usable bundled snapshot), so " +
          "Gravitee Cloud customers cannot be resolved by name. Hosted customers are unaffected.",
      };
    }
  }
}

// Test seam: drop the cache so a test or a refresh can start clean.
export function resetCustomerMapCache() {
  cache = null;
  cachedAt = 0;
  inFlight = null;
}

// Start loading at server startup so the fetch overlaps the MCP handshake rather
// than landing in the middle of someone's first query. Fire-and-forget: a failure
// here is not fatal, the next call falls back to the snapshot as usual.
export function warmCustomerMap() {
  loadCustomerMap().catch(() => {});
}
