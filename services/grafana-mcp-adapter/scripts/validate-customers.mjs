// Measure the customer map against what Loki actually has. How to run it, and
// what it needs: README, "Checking the map against Loki".
//
// The map is neither complete nor eternally fresh, and both directions matter:
//   forward  - customers whose mapped namespaces no longer exist (stale ids, so a
//              lookup returns "no logs" for a customer that has plenty)
//   reverse  - live data planes the map does not know about at all
// Run it to get numbers instead of an impression.
import { loadCustomerMap, readNumberSettings } from "../customerMapLoader.js";
import { requireConfig } from "../grafanaClient.js";
import { fetchLabelValues } from "../lokiDiscovery.js";
import { validateCustomerMap, VALIDATE_SETTINGS } from "./validateCustomerMap.js";

// Every setting is checked before GitHub or Loki is asked anything, and every
// problem is reported at once.
const { values, errors } = readNumberSettings(process.env, VALIDATE_SETTINGS);
try {
  requireConfig();
} catch (err) {
  errors.push(err.message);
}
const UID = (process.env.GRAFANA_LOGS_DATASOURCE_UID || "").trim();
if (!UID) errors.push("GRAFANA_LOGS_DATASOURCE_UID is required (the uid of the Loki datasource holding your logs).");
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

const WINDOW_DAYS = values.VALIDATE_WINDOW_DAYS;
const live = await fetchLabelValues(UID, "namespace", { from: `now-${WINDOW_DAYS}d` });

const map = await loadCustomerMap({ refresh: true });
console.log(`window: ${WINDOW_DAYS}d | live namespaces: ${live.length} | map: ${map.rows.length} rows from ${map.source}`);
if (map.warning) console.log(`WARNING: ${map.warning}`);

const result = validateCustomerMap({
  map,
  liveNamespaces: live,
  maxStale: values.VALIDATE_MAX_STALE,
});
if (result.measured) {
  console.log(`\nforward: ${result.customers} customers | fully resolvable: ${result.full} | with missing namespaces: ${result.stale.length}`);
  for (const s of result.stale) {
    console.log(`  ${s.customer}: ${s.present}/${s.mapped} present, missing ${s.missing.join(", ")}`);
  }
  console.log(`\nreverse: ${result.liveDataPlanes} live data planes | not in the map: ${result.orphans} (${result.orphanPercent}%)`);
}
for (const error of result.errors) console.error(`\n${error}`);
if (!result.ok) process.exit(1);
