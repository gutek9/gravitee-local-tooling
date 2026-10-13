// The checks behind `npm run validate-customers`: the customer map measured
// against the namespaces Loki has actually seen. Pure, no I/O, so the verdict,
// including its failure paths, can be unit-tested directly.
import { resolveCustomerNamespaces, dataPlaneNamespace } from "../customerMatch.js";

export function validateCustomerMap({ map, liveNamespaces = [], maxStale = 20 }) {
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

  // Non-zero exit if the map has drifted badly, so this can gate a refresh.
  const tooStale = stale.length > maxStale;
  return {
    ok: !tooStale,
    measured: true,
    errors: tooStale
      ? [`${stale.length} customers have missing namespaces (threshold ${maxStale}). Run: npm run refresh-customers`]
      : [],
    customers: customers.length,
    full,
    stale,
    liveDataPlanes: liveDataPlanes.length,
    orphans: orphans.length,
    orphanPercent: liveDataPlanes.length ? Math.round((orphans.length / liveDataPlanes.length) * 100) : 0,
  };
}
