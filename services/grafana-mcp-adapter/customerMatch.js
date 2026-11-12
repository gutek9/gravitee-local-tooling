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
// A data plane id is `<controlPlaneId>-<its own id>`. A control plane id can
// hold a dash of its own (`trial-tt0001`), so it is everything before the last
// segment; "" when there is no dash.
export const controlPlaneOf = (dataPlaneId) => String(dataPlaneId).split("-").slice(0, -1).join("-");

// The namespaces these deployments are searched in, and the control-plane
// namespaces they only share. A control-plane namespace is SHARED by every
// customer on that control plane (apim-cp-cp1111 carries several), so it is
// never searched under one customer's name. A trial's is the exception:
// `apim-cp-trial-<id>` hosts only that trial, so it is the trial's own,
// searched with it, and flagged so the answer says why it is there.
export function namespacesOf(rows = []) {
  const withControlPlane = rows.filter((r) => r.control_plane_id);
  const own = withControlPlane.filter((r) => r.is_trial).map((r) => controlPlaneNamespace(r.control_plane_id));
  const shared = withControlPlane.filter((r) => !r.is_trial).map((r) => controlPlaneNamespace(r.control_plane_id));
  return {
    namespaces: [...new Set([...rows.map((r) => dataPlaneNamespace(r.data_plane_id)), ...own])],
    shared_control_plane_namespaces: [...new Set(shared)],
    ...(own.length ? { control_plane_is_single_tenant: true } : {}),
  };
}
// The customers the map lists each data plane under, keyed by the data plane's
// id in lower case. A data plane is one customer's deployment, so a second
// customer on it is a fault in the map: its logs cannot be said to be either's,
// and every lookup asks this one place rather than trusting the first row.
export function dataPlaneOwners(rows = []) {
  const owners = new Map();
  for (const r of rows) {
    const id = String(r.data_plane_id).toLowerCase();
    if (!owners.has(id)) owners.set(id, new Set());
    owners.get(id).add(r.customer);
  }
  return new Map([...owners].map(([id, customers]) => [id, [...customers].sort()]));
}

// Gravitee Cloud namespaces (`apim-dp-<cp>-<dp>`, `apim-cp-<cp>`) carry ids,
// not a customer's name. One pattern, case-insensitive, for the check here and
// for the LogQL matcher that keeps the service_name search out of them; LogQL
// anchors a regex at both ends, so it is written to match a whole namespace.
export const CLOUD_NAMESPACE_PATTERN = "apim-(dp|cp)-.+";
const CLOUD_NAMESPACE = new RegExp(`^(?:${CLOUD_NAMESPACE_PATTERN})$`, "i");
export const isCloudNamespace = (namespace) => CLOUD_NAMESPACE.test(String(namespace));

// The data planes whose own id, the last segment of `apim-dp-<cp>-<dp>`, is
// `id`, in the map or in Loki, with their customer when the map has one (all
// of them, as `customers`, when it lists the data plane under several). An id
// with a dash or a space is not a data plane's own id: lookupById handles
// `cp1111-dp0001`.
export function dataPlanesWithId(rows = [], namespaceValues = [], id = "") {
  const want = String(id).trim().toLowerCase();
  if (!want || /[\s-]/.test(want)) return [];
  const owners = dataPlaneOwners(rows);
  const found = new Map();
  for (const r of rows) {
    const namespace = dataPlaneNamespace(r.data_plane_id);
    const customers = owners.get(String(r.data_plane_id).toLowerCase());
    found.set(namespace.toLowerCase(), customers.length === 1 ? { namespace, customer: customers[0] } : { namespace, customers });
  }
  for (const namespace of namespaceValues) {
    const key = String(namespace).toLowerCase();
    if (key.startsWith("apim-dp-") && !found.has(key)) found.set(key, { namespace });
  }
  return [...found.entries()]
    .filter(([key]) => {
      const segments = key.split("-");
      return segments.length >= 4 && segments.at(-1) === want;
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, dataPlane]) => dataPlane);
}

// Names compare with separators aside: "north star", "north-star" and
// "northstar" are the same name.
const normalise = (v) => String(v || "").toLowerCase().replace(/[\s_-]/g, "");
const nameWords = (v) => String(v || "").trim().split(/[\s_-]+/).filter(Boolean);
export const sameName = (a, b) => normalise(a) === normalise(b);

// At most this many names in a refusal or a note: a one-letter fragment can
// match most of the map.
export const MAX_NAMES = 10;

// "a, b, c" or "a, b, c and 7 more".
export function listNames(names = []) {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES ? `${shown} and ${names.length - MAX_NAMES} more` : shown;
}

function matchCustomersExactly(rows, core) {
  const needle = normalise(core);
  if (!needle) return [];
  return rows.filter((r) => normalise(r.customer) === needle);
}

// Part of a name, for a single word only. In "acme dev" the second word is what
// the caller said about the deployment; reading both words as parts of one name
// found `acmedevices` instead of acme's dev deployment.
function matchCustomersPartly(rows, core) {
  const needle = normalise(core);
  if (!needle || nameWords(core).length !== 1) return [];
  return rows.filter((r) => normalise(r.customer).includes(needle));
}

// Match a free-text customer name against the CSV's customer slugs. The whole
// name wins outright: "orbit" must not also drag in a slug that merely contains
// it. Only when nothing matches whole may a single word be part of a slug ("acm"
// finds `acme`).
export function matchCustomers(rows = [], core = "") {
  const exact = matchCustomersExactly(rows, core);
  return exact.length ? exact : matchCustomersPartly(rows, core);
}

// Look a customer up by the ONLY handle a Cockpit tenant really has: its ids.
// Support sees `apim-dp-cp1111-dp0001` in an alert, a pod name or a dashboard —
// never a customer name — so "whose is this?" is the question that actually gets
// asked, and it is the reverse of what name search answers.
//
// Also covers the partially-known case. The CSV does not list every live data
// plane, and some of the unlisted ones sit on a control plane it does know. For
// those, the control plane still narrows the field from every customer to the
// few sharing it — reported as candidates, never as an answer, because a
// control plane is shared.
export function lookupById(rows = [], query = "") {
  const id = String(query || "").trim().toLowerCase().replace(/^apim-(dp|cp)-/, "");
  if (!id) return null;

  const byDataPlane = rows.filter((r) => r.data_plane_id.toLowerCase() === id);
  if (byDataPlane.length) {
    const customers = dataPlaneOwners(byDataPlane).get(id);
    if (customers.length === 1) return { kind: "data_plane", id, customer: customers[0], deployments: byDataPlane };
    return {
      kind: "data_plane",
      id,
      customers,
      deployments: byDataPlane,
      note:
        `The customer map lists data plane ${id} under ${customers.length} customers (${listNames(customers)}), ` +
        "so whose it is cannot be said.",
    };
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
  const cpPart = controlPlaneOf(id);
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

// Summarise one Gravitee Cloud customer, the same way in a refusal's candidates
// and in grafana_find_customer: enough to choose between them without dumping
// every deployment. control_plane_ids are what control_plane_id accepts.
export function describeCustomer(rows) {
  return {
    customer: rows[0].customer,
    kind: "gravitee_cloud",
    deployments: rows.length,
    control_plane_ids: [...new Set(rows.map((r) => r.control_plane_id).filter(Boolean))],
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

// Split a free-text phrase into a customer the map knows and a tail describing
// the deployment, by asking the map instead of a word list. A list of known
// environment names left every unlisted word in the customer name, so the name
// matched nobody (`acme recette`, and `production` failing where `prod` worked).
//
// Every cut is tried for a whole name before any is tried for part of one:
// "acme dev" cuts after "acme", a whole name, rather than keeping both words as
// part of `acmedevices`. `partial` says which it was.
export function splitNameAndTail(rows = [], phrase = "") {
  const words = String(phrase || "").trim().split(/\s+/).filter(Boolean);
  for (const match of [matchCustomersExactly, matchCustomersPartly]) {
    for (let n = words.length; n > 0; n--) {
      const core = words.slice(0, n).join(" ");
      if (match(rows, core).length) {
        return { core, tail: words.slice(n), partial: match === matchCustomersPartly };
      }
    }
  }
  return { core: words.join(" "), tail: [], partial: false };
}

// Does this deployment answer to that word? Environment, region and provider are
// all things a person says out loud ("acme dev europe"), and when a customer has
// more than one deployment in an environment, region is often what tells them
// apart.
function qualifierMatches(row, word) {
  const w = normalise(word);
  if (!w) return true;
  return [row.env, row.region, row.provider].some((v) => {
    const n = normalise(v);
    return n && (n === w || (w.length >= 3 && n.startsWith(w)));
  });
}

// Resolve a customer, and the words after its name (qualifiers), to the
// namespaces to search.
//
// Two separate hazards, handled differently because they are not the same thing:
//
//  1. A fragment matching SEVERAL customers ("man" -> northwind, southwind; "co" ->
//     several more). Merging those returns one customer's logs under another
//     customer's name. That is a data-boundary problem, so it is refused, not
//     ranked — the caller gets the candidates and picks.
//
//  2. ONE customer spanning several control planes, i.e. several Cockpit
//     organizations sharing a name, which is not rare. Every result really does
//     belong to the name asked for, so this resolves — but it is reported,
//     because "N namespaces across M organizations" is a materially different
//     answer from what the caller probably pictured.
//
// Data-plane namespaces only, except a trial's own control plane (below). A
// control-plane namespace is SHARED by every customer on that control plane
// (apim-cp-cp1111 carries beacon, thirdco and acme together), so including it
// would return one customer's logs under another's name — wrong, and a
// data-boundary problem, not just a precision one.
export function resolveCustomerNamespaces(rows = [], { core, qualifiers = [], controlPlaneId } = {}) {
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
        `"${core}" matches ${candidates.length} different customers (${listNames(candidates.map((c) => c.customer))}). ` +
        "Searching them together would return one customer's logs under another's name, so none of them was searched. " +
        "Use the exact customer name.",
    };
  }

  // Qualifiers (the tail of the phrase: environment, region, provider) only ever
  // narrow. They are matched against what the deployment actually is, not
  // against a list of allowed words.
  const quals = (qualifiers || []).map(String).filter(Boolean);
  const rowsToUse = quals.length ? matched.filter((r) => quals.every((q) => qualifierMatches(r, q))) : matched;

  // Words that describe none of the customer's deployments are refused, never
  // dropped. Falling back to every deployment would turn a filter into a
  // widening: "acme staging" for a customer with only prod and dev would search
  // both, with no staging constraint at all. What they do have is listed so the
  // caller can retry.
  if (quals.length && !rowsToUse.length) {
    const knownEnvironments = [...new Set(matched.map((r) => r.env).filter(Boolean))].sort();
    const knownRegions = [...new Set(matched.map((r) => r.region).filter(Boolean))].sort();
    return {
      matched: [],
      namespaces: [],
      control_plane_namespaces: [],
      unknown_qualifiers: quals,
      known_environments: knownEnvironments,
      known_regions: knownRegions,
      reason:
        `"${quals.join(" ")}" does not describe any deployment of ${matched[0].customer} ` +
        `(environments: ${knownEnvironments.join(", ") || "none listed"}; regions: ${knownRegions.join(", ") || "none listed"}). ` +
        "Nothing was searched. Retry without it, or with one of those.",
    };
  }

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
          `deployments matching "${quals.join(" ")}" is on it ` +
          `(those are on: ${valid.join(", ")}). Nothing was searched.`
        : `"${controlPlaneId}" is not one of ${matched[0].customer}'s Cockpit organizations ` +
          `(${valid.join(", ")}). Nothing was searched.`,
    };
  }
  const finalRows = cpFiltered;

  // A data plane the map lists under another customer too is refused, never
  // searched under this one's name: its logs may be the other customer's. The
  // customer's data planes with no second owner are named, so they can still
  // be searched one by one through their id.
  const owners = dataPlaneOwners(rows);
  const ownersOf = (r) => owners.get(String(r.data_plane_id).toLowerCase());
  const shared = [...new Map(finalRows.filter((r) => ownersOf(r).length > 1).map((r) => [r.data_plane_id, r])).values()];
  if (shared.length) {
    const others = [...new Set(matched.filter((r) => ownersOf(r).length === 1).map((r) => r.data_plane_id))];
    return {
      matched: [],
      namespaces: [],
      control_plane_namespaces: [],
      shared_data_planes: shared.map((r) => ({ data_plane_id: r.data_plane_id, customers: ownersOf(r) })),
      reason:
        `The customer map lists ${listNames(shared.map((r) => `${r.data_plane_id} (${ownersOf(r).join(", ")})`))} ` +
        `under more than one customer, so whose logs ${shared.length > 1 ? "they hold" : "it holds"} cannot be said. ` +
        "Nothing was searched." +
        (others.length ? ` ${matched[0].customer}'s other data planes can be searched by id: ${listNames(others)}.` : ""),
    };
  }

  // A trial's control plane is searched with it, never a shared one: the
  // difference is encoded in namespacesOf, not left to the namespace matcher.
  const { namespaces, shared_control_plane_namespaces: controlPlanes, control_plane_is_single_tenant } =
    namespacesOf(finalRows);
  const orgs = [...new Set(finalRows.map((r) => r.control_plane_id).filter(Boolean))];

  return {
    matched: finalRows,
    namespaces,
    control_plane_namespaces: controlPlanes,
    ...(control_plane_is_single_tenant ? { control_plane_is_single_tenant: true } : {}),
    env_filter_applied: quals.length > 0,
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
