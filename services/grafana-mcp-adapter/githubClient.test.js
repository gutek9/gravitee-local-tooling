import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { githubGet } from "./githubClient.js";

// Records every request exactly as fetch receives it, and answers with `respond`
// (a real Response by default).
let calls;
let origFetch;
let respond;

beforeEach(() => {
  calls = [];
  origFetch = globalThis.fetch;
  respond = () => new Response("body text", { status: 200 });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(init);
  };
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_test_token";
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
});

const CONTENTS = ["repos", "acme-org", "acme-repo", "contents", "docs", "summary.csv"];

test("githubGet: sends one GET to api.github.com with the token, the accept type and a user agent", async () => {
  const body = await githubGet(CONTENTS, { params: { ref: "main" }, accept: "application/vnd.github.raw", timeoutMs: 5000 });
  assert.equal(body, "body text");
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://api.github.com/repos/acme-org/acme-repo/contents/docs/summary.csv?ref=main");
  assert.equal(init.method, "GET");
  assert.deepEqual(init.headers, {
    Authorization: "Bearer ghp_test_token",
    Accept: "application/vnd.github.raw",
    "User-Agent": "grafana-mcp-adapter",
  });
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.body, undefined);
});

test("githubGet: the accept type defaults to GitHub's JSON, and no params means no query string", async () => {
  await githubGet(["repos", "acme-org", "acme-repo"], { timeoutMs: 5000 });
  assert.equal(calls[0].url, "https://api.github.com/repos/acme-org/acme-repo");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github+json");
});

test("githubGet: each segment is encoded, so a value cannot cut the URL short or add a query", async () => {
  await githubGet(["repos", "acme-org", "acme-repo", "contents", "docs", "customers#v2 final?.csv"], {
    params: { ref: "prod" },
    timeoutMs: 5000,
  });
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://api.github.com");
  assert.equal(decodeURIComponent(url.pathname), "/repos/acme-org/acme-repo/contents/docs/customers#v2 final?.csv");
  assert.equal(url.hash, "");
  assert.deepEqual([...url.searchParams], [["ref", "prod"]]);
});

test("githubGet: an empty, '.' or '..' segment is refused before any request", async () => {
  // ".." survives encoding and the URL parser resolves it: repos/acme-org/..
  // would reach /repos/contents/..., another endpoint.
  for (const bad of ["..", ".", ""]) {
    await assert.rejects(
      githubGet(["repos", "acme-org", bad, "contents", "x.csv"], { timeoutMs: 5000 }),
      /empty, "\." and "\.\." segments are not allowed/,
      JSON.stringify(bad),
    );
  }
  assert.equal(calls.length, 0);
});

test("githubGet: without a token nothing is sent", async () => {
  for (const token of [undefined, "", "   "]) {
    if (token === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
    await assert.rejects(githubGet(CONTENTS, { timeoutMs: 5000 }), { message: "GITHUB_PERSONAL_ACCESS_TOKEN is not set" });
  }
  assert.equal(calls.length, 0);
});

test("githubGet: a missing timeout is refused before any request", async () => {
  for (const timeoutMs of [undefined, 0, -1, 1.5, "5000"]) {
    await assert.rejects(githubGet(CONTENTS, { timeoutMs }), /needs timeoutMs/, String(timeoutMs));
  }
  assert.equal(calls.length, 0);
});

test("githubGet: a failed response names the status, never the token or the body", async () => {
  respond = () => new Response("Bad credentials for ghp_test_token", { status: 401 });
  await assert.rejects(githubGet(CONTENTS, { timeoutMs: 5000 }), (err) => {
    assert.equal(err.message, "GitHub responded 401");
    return true;
  });
});

// Resolves when the request's signal aborts, like fetch does.
const abortedBy = (signal) =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

test("githubGet: a GitHub that never answers is given up on after timeoutMs", { timeout: 2000 }, async () => {
  respond = (init) => abortedBy(init.signal);
  const started = Date.now();
  await assert.rejects(githubGet(CONTENTS, { timeoutMs: 20 }), /aborted/);
  assert.ok(Date.now() - started < 2000);
});

test("githubGet: the timeout also bounds a body that starts but never finishes", { timeout: 2000 }, async () => {
  respond = (init) => ({ ok: true, status: 200, text: () => abortedBy(init.signal) });
  const started = Date.now();
  await assert.rejects(githubGet(CONTENTS, { timeoutMs: 20 }), /aborted/);
  assert.ok(Date.now() - started < 2000);
});
