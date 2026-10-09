// Measure the customer map against what Loki actually has.
//
//   GITHUB_PERSONAL_ACCESS_TOKEN=... GRAFANA_* =... npm run validate-customers
//
// The map is neither complete nor eternally fresh, and both directions matter:
//   forward  - customers whose mapped namespaces no longer exist (stale ids, so a
//              lookup returns "no logs" for a customer that has plenty)
//   reverse  - live data planes the map does not know about at all
// Run it to get numbers instead of an impression.
import { loadCustomerMap, resolveCustomerNamespaces, dataPlaneNamespace } from "../customerMap.js";
import { grafanaDatasourceProxyGet } from "../grafanaClient.js";

const UID = process.env.GRAFANA_LOGS_DATASOURCE_UID;
if (!UID) {
  console.error("GRAFANA_LOGS_DATASOURCE_UID is required.");
  process.exit(1);
}

const WINDOW_DAYS = Number(process.env.VALIDATE_WINDOW_DAYS || 30);
const start = `${(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000) * 1e6}`;
const data = await grafanaDatasourceProxyGet(UID, "loki/api/v1/label/namespace/values", { start });
const live = data?.data || [];
const liveSet = new Set(live);

const map = await loadCustomerMap({ refresh: true });
console.log(`window: ${WINDOW_DAYS}d | live namespaces: ${live.length} | map: ${map.rows.length} rows from ${map.source}`);
if (map.warning) console.log(`WARNING: ${map.warning}`);

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

const mapped = new Set(map.rows.map((r) => dataPlaneNamespace(r.data_plane_id)));
const liveDps = live.filter((n) => n.startsWith("apim-dp-"));
const orphans = liveDps.filter((n) => !mapped.has(n));

console.log(`\nforward: ${customers.length} customers | fully resolvable: ${full} | with missing namespaces: ${stale.length}`);
for (const s of stale.sort((a, b) => a.present - b.present)) {
  console.log(`  ${s.customer}: ${s.present}/${s.mapped} present, missing ${s.missing.join(", ")}`);
}
console.log(`\nreverse: ${liveDps.length} live data planes | not in the map: ${orphans.length} (${Math.round((orphans.length / liveDps.length) * 100)}%)`);

// Non-zero exit if the map has drifted badly, so this can gate a refresh.
const threshold = Number(process.env.VALIDATE_MAX_STALE || 20);
if (stale.length > threshold) {
  console.error(`\n${stale.length} customers have missing namespaces (threshold ${threshold}). Run: npm run refresh-customers`);
  process.exit(1);
}
