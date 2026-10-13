// Customer -> namespace mapping for Gravitee Cloud (Cockpit) tenants.
//
// Cockpit customers do not carry their name anywhere in their Loki labels. A
// tenant lives in `apim-dp-<controlPlaneId>-<dataPlaneId>`, so a free-text search
// for "acme" matches nothing at all — the customers this tooling is most
// useful for were the ones it could not find. The mapping from customer name to
// those ids lives in cloud-deployments-configuration/docs/summary.
//
// Matching a name, an id or a qualifier against the map's rows, and turning the
// rows that match into namespaces. Pure, no I/O, so it can be unit-tested
// directly; customerMapLoader.js supplies the rows.

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
  const finalRows = cpFiltered.length ? cpFiltered : rowsToUse;

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
