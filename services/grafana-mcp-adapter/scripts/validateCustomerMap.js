// The checks behind `npm run validate-customers`: the customer map measured
// against the namespaces Loki has actually seen. Pure, no I/O, so the verdict,
// including its failure paths, can be unit-tested directly.
import { dataPlaneNamespace, dataPlaneOwners, groupByCustomer } from "../customerMatch.js";
import { describeLeftOut } from "../customerCsv.js";

// The script's two numbers, read with readNumberSettings like the map settings:
// empty means the default, anything else must be a whole number in range. A
// threshold of 0 is the strict setting: any customer with a missing namespace
// fails the check.
export const VALIDATE_SETTINGS = [
  { name: "GRAFANA_VALIDATE_WINDOW_DAYS", fallback: 30, min: 1, max: 365 },
  { name: "GRAFANA_VALIDATE_MAX_STALE", fallback: 20, min: 0, max: 10000 },
];

export function validateCustomerMap({ map, liveNamespaces = [], maxStale = 20 }) {
  // A threshold that is not a whole number passes every map: "stale > NaN" is
  // false however many are stale. Refused here too, whoever the caller is.
  if (!Number.isInteger(maxStale) || maxStale < 0) {
    throw new Error(`maxStale must be a whole number of 0 or more, got ${maxStale}`);
  }
  // Nothing to measure is a failure, not a pass. With no map rows nothing can
  // be stale, and with no live namespaces there is nothing to compare with:
  // either way the threshold would judge a check that never ran.
  const errors = [];
  const leftOut = map.leftOut || [];
  if (!map.rows.length) {
    errors.push(
      leftOut.length
        ? "No row of the customer map can be used, so nothing was validated."
        : "The customer CSV has no rows, so nothing was validated: check the file that " +
            "GRAFANA_CUSTOMER_MAP_REPO and GRAFANA_CUSTOMER_MAP_PATH name.",
    );
  }
  if (!liveNamespaces.length) {
    errors.push(
      "Loki returned no namespaces for this window, so nothing was validated. " +
        "Check GRAFANA_LOGS_DATASOURCE_UID and GRAFANA_VALIDATE_WINDOW_DAYS.",
    );
  }
  // Rows of the CSV that could not be used are a fault in the map whatever the
  // threshold: grafana_logs_link leaves them out. Every one is listed, for
  // whoever fixes the CSV.
  const leftOutErrors = leftOut.length
    ? [
        `${leftOut.length} row(s) of the customer CSV cannot be used, so grafana_logs_link leaves them out ` +
          "and a customer on them resolves only partly, or not at all:\n" +
          leftOut.map((entry) => `  ${describeLeftOut(entry)}`).join("\n"),
      ]
    : [];
  if (errors.length) return { ok: false, measured: false, errors: [...errors, ...leftOutErrors] };

  // Each customer is measured on the data planes the map lists under it, not
  // through what grafana_logs_link would search for its name: a customer that
  // search refuses (a data plane shared with another customer, a name that
  // reads the same as another's) can still have data planes that are gone, and
  // leaving it out would let the threshold pass without it.
  const liveSet = new Set(liveNamespaces);
  const byCustomer = groupByCustomer(map.rows);
  const stale = [];
  let full = 0;
  for (const [customer, rows] of byCustomer) {
    const dps = [...new Set(rows.map((r) => dataPlaneNamespace(r.data_plane_id)))];
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
    ok: !tooStale && !sharedDataPlanes.length && !leftOut.length,
    measured: true,
    errors: [
      ...(tooStale
        ? [
            `${stale.length} customers have missing namespaces (threshold ${maxStale}). A refresh writes the same ` +
              "rows into the snapshot, so it would not fix them: if those data planes are gone, the CSV needs " +
              "correcting at its source.",
          ]
        : []),
      ...(sharedDataPlanes.length
        ? [
            `${sharedDataPlanes.length} data plane(s) listed under more than one customer: ` +
              sharedDataPlanes.map((d) => `${d.data_plane_id} (${d.customers.join(", ")})`).join("; ") +
              ". grafana_logs_link refuses them until the map lists each under one customer.",
          ]
        : []),
      ...leftOutErrors,
    ],
    customers: byCustomer.size,
    full,
    stale,
    liveDataPlanes: liveDataPlanes.length,
    orphans: orphans.length,
    orphanPercent: liveDataPlanes.length ? Math.round((orphans.length / liveDataPlanes.length) * 100) : 0,
  };
}
