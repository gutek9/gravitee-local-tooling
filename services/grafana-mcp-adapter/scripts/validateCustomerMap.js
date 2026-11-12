// The checks behind `npm run validate-customers`: the customer map measured
// against the namespaces Loki has actually seen. Pure, no I/O, so the verdict,
// including its failure paths, can be unit-tested directly.
import { resolveCustomerNamespaces, dataPlaneNamespace, dataPlaneOwners } from "../customerMatch.js";

// The script's two numbers, read with readNumberSettings like the map settings:
// empty means the default, anything else must be a whole number in range. A
// threshold of 0 is the strict setting: any customer with a missing namespace
// fails the check.
export const VALIDATE_SETTINGS = [
  { name: "VALIDATE_WINDOW_DAYS", fallback: 30, min: 1, max: 365 },
  { name: "VALIDATE_MAX_STALE", fallback: 20, min: 0, max: 10000 },
];

export function validateCustomerMap({ map, liveNamespaces = [], maxStale = 20 }) {
  // A threshold that is not a whole number passes every map: "stale > NaN" is
  // false however many are stale. Refused here too, whoever the caller is.
  if (!Number.isInteger(maxStale) || maxStale < 0) {
    throw new Error(`maxStale must be a whole number of 0 or more, got ${maxStale}`);
  }
  // Nothing to measure is a failure, not a pass. With no map rows (both sources
  // down, or an empty file) or no live namespaces, every count below is zero,
  // which would read as "nothing stale" and exit 0 on a check that never ran.
  const errors = [];
  if (map.source === "unavailable" || !map.rows.length) {
    errors.push(
      `The customer map is ${map.source === "unavailable" ? "unavailable" : "empty"} (source: ${map.source}), ` +
        "so nothing was validated. Check GITHUB_PERSONAL_ACCESS_TOKEN, or run: npm run refresh-customers",
    );
  }
  if (!liveNamespaces.length) {
    errors.push(
      "Loki returned no namespaces for this window, so nothing was validated. " +
        "Check GRAFANA_LOGS_DATASOURCE_UID and VALIDATE_WINDOW_DAYS.",
    );
  }
  if (errors.length) return { ok: false, measured: false, errors };

  const liveSet = new Set(liveNamespaces);
  const customers = [...new Set(map.rows.map((r) => r.customer))];
  const stale = [];
  let full = 0;
  for (const customer of customers) {
    const dps = resolveCustomerNamespaces(map.rows, { core: customer }).namespaces.filter((n) => n.startsWith("apim-dp-"));
    if (!dps.length) continue;
    const present = dps.filter((n) => liveSet.has(n));
    if (present.length === dps.length) full++;
    else stale.push({ customer, present: present.length, mapped: dps.length, missing: dps.filter((n) => !liveSet.has(n)) });
  }
  stale.sort((a, b) => a.present - b.present);

  const mapped = new Set(map.rows.map((r) => dataPlaneNamespace(r.data_plane_id)));
  const liveDataPlanes = liveNamespaces.filter((n) => n.startsWith("apim-dp-"));
  const orphans = liveDataPlanes.filter((n) => !mapped.has(n));

  // A data plane listed under two customers is a fault in the map whatever the
  // threshold: grafana_logs_link refuses it, so it is reported and fails.
  const sharedDataPlanes = [...dataPlaneOwners(map.rows)]
    .filter(([, customers]) => customers.length > 1)
    .map(([id, customers]) => ({ data_plane_id: id, customers }));

  // Non-zero exit if the map has drifted badly, so this can gate a refresh.
  const tooStale = stale.length > maxStale;
  return {
    ok: !tooStale && !sharedDataPlanes.length,
    measured: true,
    errors: [
      ...(tooStale ? [`${stale.length} customers have missing namespaces (threshold ${maxStale}). Run: npm run refresh-customers`] : []),
      ...(sharedDataPlanes.length
        ? [
            `${sharedDataPlanes.length} data plane(s) listed under more than one customer: ` +
              sharedDataPlanes.map((d) => `${d.data_plane_id} (${d.customers.join(", ")})`).join("; ") +
              ". grafana_logs_link refuses them until the map lists each under one customer.",
          ]
        : []),
    ],
    customers: customers.length,
    full,
    stale,
    liveDataPlanes: liveDataPlanes.length,
    orphans: orphans.length,
    orphanPercent: liveDataPlanes.length ? Math.round((orphans.length / liveDataPlanes.length) * 100) : 0,
  };
}
