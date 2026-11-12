import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The script always runs on a temp copy of the adapter's modules. Whatever it
// does, even after a change that breaks its argument handling, it can only write
// inside that copy, never to a real local customers-snapshot.json.
const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = mkdtempSync(join(tmpdir(), "refresh-customers-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function adapterCopy() {
  const dir = mkdtempSync(join(ROOT, "adapter-"));
  for (const file of readdirSync(ADAPTER)) {
    if ((file.endsWith(".js") && !file.endsWith(".test.js")) || file === "package.json") {
      cpSync(join(ADAPTER, file), join(dir, file));
    }
  }
  mkdirSync(join(dir, "scripts"));
  cpSync(join(ADAPTER, "scripts", "refresh-customers.mjs"), join(dir, "scripts", "refresh-customers.mjs"));
  return dir;
}

// fetch replaced: every request is printed to stderr, and GitHub's two endpoints
// answer with a made-up CSV and commit date.
const CSV =
  "Customer,ControlPlaneId,DataPlaneId,Region,Provider,Cloud Region,Custom DNS,URLs\n" +
  "acme,cp1111,cp1111-dp0001,unitedstates,aws,us-east-1,None,prod-org-acme.us-aws-us-east-1.gateway.gravitee.io\n";
const fakeGitHub = (csv) => `data:text/javascript,${encodeURIComponent(`
globalThis.fetch = async (url) => {
  process.stderr.write("REQUEST " + url + "\\n");
  const body = new URL(String(url)).pathname.endsWith("/commits")
    ? JSON.stringify([{ commit: { committer: { date: "2026-11-01T00:00:00Z" } } }])
    : ${JSON.stringify(csv)};
  return new Response(body);
};`)}`;

function run(dir, args, env = {}, csv = CSV) {
  return spawnSync(process.execPath, ["--import", fakeGitHub(csv), join(dir, "scripts", "refresh-customers.mjs"), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, GITHUB_PERSONAL_ACCESS_TOKEN: "test-token", ...env },
    encoding: "utf8",
  });
}

const customersIn = (file) => JSON.parse(readFileSync(file, "utf8")).customers.map((c) => c.customer);

test("refresh-customers: --out is where the snapshot goes, and the container path in the env is not used", () => {
  // Regression: the script wrote wherever GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH said.
  // That is a path inside the adapter's container: taken from .env it crashed the
  // host script (no such directory), or wrote the customer list to a host file
  // that git does not ignore.
  const dir = adapterCopy();
  const containerPath = join(dir, "app", "customers-snapshot.json");
  const out = join(dir, "picked.json");
  const r = run(dir, ["--out", out], { GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH: containerPath });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(customersIn(out), ["acme"]);
  assert.ok(r.stdout.includes(`to ${out} `), r.stdout);
  assert.equal(existsSync(containerPath), false);
  assert.equal(existsSync(join(dir, "customers-snapshot.json")), false);

  // A relative --out is taken from where the command runs.
  assert.equal(run(dir, ["--out=relative.json"]).status, 0);
  assert.deepEqual(customersIn(join(dir, "relative.json")), ["acme"]);
});

test("refresh-customers: without --out it writes the snapshot next to server.js, whatever the env says", () => {
  const dir = adapterCopy();
  const elsewhere = join(dir, "my-customers.json");
  const r = run(dir, [], { GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH: elsewhere });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(customersIn(join(dir, "customers-snapshot.json")), ["acme"]);
  assert.equal(existsSync(elsewhere), false);
});

test("refresh-customers: a bad argument stops it before GitHub is asked anything", () => {
  const dir = adapterCopy();
  for (const args of [["--ouy", "x.json"], ["--out"], ["--out", ""], ["--out", "--force"], ["x.json"]]) {
    const r = run(dir, args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.match(r.stderr, /Usage: npm run refresh-customers \[-- --out FILE\]/, JSON.stringify(args));
    assert.doesNotMatch(r.stderr, /REQUEST/, JSON.stringify(args));
  }
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "package.json"), []);
});

test("refresh-customers: a file it cannot write is reported in one line, without a stack trace", () => {
  const dir = adapterCopy();
  const r = run(dir, ["--out", join(dir, "no-such-dir", "x.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Could not write the snapshot to .*no-such-dir.*ENOENT/m);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});

test("refresh-customers: a CSV it cannot read as the map writes nothing", () => {
  // Regression (#9 review): a CSV without URLs or ControlPlaneId was written as a
  // snapshot whose every row lacked that field.
  const dir = adapterCopy();
  const out = join(dir, "picked.json");
  const r = run(dir, ["--out", out], {}, CSV.replace(",ControlPlaneId,", ",Org,"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^The customer CSV cannot be read, so no snapshot was written: the customer CSV has no ControlPlaneId column/m);
  assert.equal(existsSync(out), false);
});

test("refresh-customers: a row it cannot use writes nothing, and every such row is named", () => {
  // The adapter warns on every answer that rows of a live CSV were left out; a
  // snapshot cannot carry that warning.
  const dir = adapterCopy();
  const out = join(dir, "picked.json");
  const bad = "globex, inc,cp2222,cp2222-dp0001,europe,az,westeurope,None,None\nglobex,cp2222,cp2222 dp0002,europe,az,westeurope,None,None\n";
  const r = run(dir, ["--out", out], {}, CSV + bad);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^2 row\(s\) of the customer CSV cannot be used, so no snapshot was written/m);
  assert.match(r.stderr, /^ {2}line 3: 9 fields where the header has 8$/m);
  assert.match(r.stderr, /^ {2}line 4, globex: the data plane id is not /m);
  assert.equal(existsSync(out), false);
});
