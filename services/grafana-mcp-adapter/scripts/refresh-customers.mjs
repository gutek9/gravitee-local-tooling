// Regenerate the bundled customer snapshot used when GitHub is unreachable. How
// to run it, and how a new snapshot reaches the adapter: README, "The customer
// snapshot is never committed". In short, from this directory:
//
//   node --env-file=../../.env scripts/refresh-customers.mjs [--out FILE]
//
// Writes customers-snapshot.json next to server.js, the file the image copies,
// unless --out names another file. It never reads GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH:
// that is where the adapter reads a snapshot inside its container, so taken from
// .env it would send this host-side script to a container path.
//
// The snapshot is deliberately slimmed to what is needed to resolve a customer to
// a namespace. Customer hostnames and custom DNS are NOT written to disk.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseCustomerCsv, describeLeftOut } from "../customerCsv.js";
import { fetchCustomerCsv, fetchGeneratedAt, buildSnapshot, DEFAULT_SNAPSHOT_PATH } from "../customerMapLoader.js";

const USAGE = "Usage: npm run refresh-customers [-- --out FILE]";

// The arguments are checked before GitHub is asked anything.
let outPath;
try {
  const { values } = parseArgs({ options: { out: { type: "string" } }, strict: true });
  if (values.out === "") throw new Error("--out needs a file name");
  outPath = values.out === undefined ? DEFAULT_SNAPSHOT_PATH : resolve(values.out);
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(1);
}

let csv;
try {
  csv = await fetchCustomerCsv();
} catch (err) {
  console.error(`Could not fetch the customer CSV: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseCustomerCsv(csv);
} catch (err) {
  console.error(`The customer CSV cannot be read, so no snapshot was written: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
// The adapter warns on every answer that rows of a live CSV were left out. A
// snapshot cannot carry that warning, so it is written only from a CSV whose
// every row can be used.
if (parsed.leftOut.length) {
  console.error(
    `${parsed.leftOut.length} row(s) of the customer CSV cannot be used, so no snapshot was written: the adapter ` +
      "would answer without those rows, and nothing would say so. Fix the CSV, then run this again.",
  );
  for (const entry of parsed.leftOut) console.error(`  ${describeLeftOut(entry)}`);
  process.exit(1);
}
const customers = parsed.rows;
if (!customers.length) {
  console.error("Parsed zero customers - refusing to overwrite the snapshot with an empty file.");
  process.exit(1);
}

// The CSV's own date, not today's: the fallback's freshness warning must say how
// old the data is, not when it was copied.
const sourceGeneratedAt = await fetchGeneratedAt();
if (!sourceGeneratedAt) {
  console.warn("Could not read when the CSV was last generated; the snapshot records its source date as unknown.");
}

try {
  await writeFile(outPath, JSON.stringify(buildSnapshot({ customers, sourceGeneratedAt }), null, 2) + "\n");
} catch (err) {
  console.error(`Could not write the snapshot to ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.log(
  `Wrote ${customers.length} deployments (${new Set(customers.map((c) => c.customer)).size} customers) to ${outPath} ` +
    `(source CSV generated ${sourceGeneratedAt ? sourceGeneratedAt.slice(0, 10) : "unknown"})`,
);
