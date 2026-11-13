// Measure the customer map against what Loki actually has. How to run it, and
// what it needs: README, "Checking the map against Loki".
//
// The map is neither complete nor eternally fresh, and both directions matter:
//   forward  - customers whose mapped namespaces no longer exist (stale ids, so a
//              lookup returns "no logs" for a customer that has plenty)
//   reverse  - live data planes the map does not know about at all
// Run it to get numbers instead of an impression.
//
// It measures the map as GitHub has it now, read the way refresh-customers
// reads it, and never the bundled snapshot: a fallback measured as if it were
// the map would pass the very check meant to catch an outdated one, and
// GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH is a path in the container, not here.
import { parseCustomerCsv } from "../customerCsv.js";
import { fetchCustomerCsv, fetchGeneratedAt, readNumberSettings } from "../customerMapLoader.js";
import { requireConfig } from "../grafanaClient.js";
import { fetchLabelValues } from "../lokiDiscovery.js";
import { validateCustomerMap, VALIDATE_SETTINGS } from "./validateCustomerMap.js";

// Every setting is checked before GitHub or Loki is asked anything, and every
// problem is reported at once.
const { values, errors } = readNumberSettings(process.env, VALIDATE_SETTINGS);
// The map's own numbers too (its fetch timeout is used here).
errors.push(...readNumberSettings(process.env).errors);
try {
  requireConfig();
} catch (err) {
  errors.push(err.message);
}
const UID = (process.env.GRAFANA_LOGS_DATASOURCE_UID || "").trim();
if (!UID) errors.push("GRAFANA_LOGS_DATASOURCE_UID is required (the uid of the Loki datasource holding your logs).");
if (!(process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "").trim()) {
  errors.push("GITHUB_PERSONAL_ACCESS_TOKEN is required: the map is read from GitHub, never from the bundled snapshot.");
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

const WINDOW_DAYS = values.GRAFANA_VALIDATE_WINDOW_DAYS;
let live;
try {
  live = await fetchLabelValues(UID, "namespace", { from: `now-${WINDOW_DAYS}d` });
} catch (err) {
  console.error(
    `Could not read Loki's namespace list: ${err instanceof Error ? err.message : String(err)}. Nothing was validated.`,
  );
  process.exit(1);
}

let csv;
try {
  csv = await fetchCustomerCsv();
} catch (err) {
  console.error(
    `Could not read the customer map from GitHub: ${err instanceof Error ? err.message : String(err)}. Nothing was validated.`,
  );
  process.exit(1);
}
let parsed;
try {
  parsed = parseCustomerCsv(csv);
} catch (err) {
  console.error(`The customer map from GitHub cannot be read: ${err instanceof Error ? err.message : String(err)}. Nothing was validated.`);
  process.exit(1);
}
const generatedAt = await fetchGeneratedAt();
const map = { rows: parsed.rows, leftOut: parsed.leftOut };
console.log(
  `window: ${WINDOW_DAYS}d | live namespaces: ${live.length} | map: ${map.rows.length} rows from GitHub` +
    `${map.leftOut.length ? `, ${map.leftOut.length} left out` : ""} ` +
    `(CSV generated ${generatedAt ? generatedAt.slice(0, 10) : "on an unknown date"})`,
);

const result = validateCustomerMap({
  map,
  liveNamespaces: live,
  maxStale: values.GRAFANA_VALIDATE_MAX_STALE,
});
if (result.measured) {
  console.log(
    `\nforward: ${result.customers} customers | with every data plane live: ${result.full} | ` +
      `with missing namespaces: ${result.stale.length}`,
  );
  for (const s of result.stale) {
    console.log(`  ${s.customer}: ${s.present}/${s.mapped} present, missing ${s.missing.join(", ")}`);
  }
  console.log(`\nreverse: ${result.liveDataPlanes} live data planes | not in the map: ${result.orphans} (${result.orphanPercent}%)`);
}
for (const error of result.errors) console.error(`\n${error}`);
if (!result.ok) process.exit(1);
