import { test } from "node:test";
import assert from "node:assert/strict";

import { matchNamespaces, matchNamespacesPhrase } from "./namespaceMatch.js";

// ---------------------------------------------------------------------------
// matchNamespaces
// ---------------------------------------------------------------------------

const NAMESPACES = [
  "prod",
  "nonprod",
  "april-prod",
  "april-rec",
  "blueyonder-plt-live",
  "blueyonder-multitenant",
  "lyonaeroports-prod",
];

test("matchNamespaces: returns the customer's own namespaces", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, "april"), ["april-prod", "april-rec"]);
  assert.deepEqual(matchNamespaces(NAMESPACES, "blueyonder"), ["blueyonder-plt-live", "blueyonder-multitenant"]);
});

test("matchNamespaces: customer with no dedicated namespace -> [] (fall back to service_name)", () => {
  // 'equigy' lives only in the shared `prod`/`nonprod` namespaces.
  assert.deepEqual(matchNamespaces(NAMESPACES, "equigy"), []);
});

test("matchNamespaces: empty core matches nothing (avoids matching every namespace)", () => {
  assert.deepEqual(matchNamespaces(NAMESPACES, ""), []);
  assert.deepEqual(matchNamespaces(NAMESPACES, "   "), []);
});

// ---------------------------------------------------------------------------
// Tiered namespace matching
// ---------------------------------------------------------------------------

const FLEET = [
  "acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox",
  "orbit-plt-live", "orbit-plt-live-ap", "orbit-plt-live-au", "orbit-multitenant",
  "beacon-management-prod1", "beacon-management-uat",
  "prod", "dev",
];

test("matchNamespaces: the whole name wins over its own siblings", () => {
  // Substring matching returned plt-live AND plt-live-ap/au for "orbit plt live".
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live"), ["orbit-plt-live"]);
  assert.deepEqual(matchNamespaces(FLEET, "beacon management uat"), ["beacon-management-uat"]);
});

test("matchNamespaces: a namespace that IS an environment word still resolves", () => {
  // splitClientEnv classified the whole phrase as environment, leaving no name.
  assert.deepEqual(matchNamespaces(FLEET, "prod"), ["prod"]);
  assert.deepEqual(matchNamespaces(FLEET, "dev"), ["dev"]);
});

test("matchNamespaces: a customer name alone returns their whole estate", () => {
  assert.deepEqual(matchNamespaces(FLEET, "acme"), ["acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox"]);
});

test("matchNamespaces: falls back from segments to substring", () => {
  // "plt live ap" are whole segments; "ultitenant" is only a substring.
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live ap"), ["orbit-plt-live-ap"]);
  assert.deepEqual(matchNamespaces(FLEET, "orbit ultitenant"), ["orbit-multitenant"]);
  assert.deepEqual(matchNamespaces(FLEET, "nosuchcustomer"), []);
  assert.deepEqual(matchNamespaces(FLEET, ""), []);
});

test("matchNamespacesPhrase: drops the tail only when the whole phrase names nothing, and returns it", () => {
  assert.deepEqual(matchNamespacesPhrase(FLEET, "acme rec"), { namespaces: ["acme-rec"], name: "acme rec", tail: [] });
  // "gatewaytesting" is a Cockpit environment: no hosted namespace has it, so the
  // tail comes back for the map to explain rather than being thrown away.
  assert.deepEqual(matchNamespacesPhrase(FLEET, "acme gatewaytesting"), {
    namespaces: ["acme-int", "acme-ppr", "acme-prod", "acme-rec", "acme-sandbox"],
    name: "acme",
    tail: ["gatewaytesting"],
  });
  assert.deepEqual(matchNamespacesPhrase(FLEET, "nobody here"), { namespaces: [], name: "", tail: ["nobody", "here"] });
});
