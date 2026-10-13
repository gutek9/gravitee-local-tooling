// Measure the customer map against what Loki actually has.
//
//   GITHUB_PERSONAL_ACCESS_TOKEN=... GRAFANA_* =... npm run validate-customers
//
// The map is neither complete nor eternally fresh, and both directions matter:
//   forward  - customers whose mapped namespaces no longer exist (stale ids, so a
//              lookup returns "no logs" for a customer that has plenty)
//   reverse  - live data planes the map does not know about at all
// Run it to get numbers instead of an impression.
import { loadCustomerMap } from "../customerMapLoader.js";
import { grafanaDatasourceProxyGet } from "../grafanaClient.js";
import { validateCustomerMap } from "./validateCustomerMap.js";

const UID = process.env.GRAFANA_LOGS_DATASOURCE_UID;
if (!UID) {
  console.error("GRAFANA_LOGS_DATASOURCE_UID is required.");
  process.exit(1);
}

const WINDOW_DAYS = Number(process.env.VALIDATE_WINDOW_DAYS || 30);
const start = `${(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000) * 1e6}`;
const data = await grafanaDatasourceProxyGet(UID, "loki/api/v1/label/namespace/values", { start });
const live = data?.data || [];

const map = await loadCustomerMap({ refresh: true });
console.log(`window: ${WINDOW_DAYS}d | live namespaces: ${live.length} | map: ${map.rows.length} rows from ${map.source}`);
if (map.warning) console.log(`WARNING: ${map.warning}`);

const result = validateCustomerMap({
  map,
  liveNamespaces: live,
  maxStale: Number(process.env.VALIDATE_MAX_STALE || 20),
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
