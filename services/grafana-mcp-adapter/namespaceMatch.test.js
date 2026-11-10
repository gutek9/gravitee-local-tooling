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

test("matchNamespaces: falls back to part of the first word, never of the others", () => {
  // "plt live ap" are whole segments; "multiten" is the first word, part of one.
  assert.deepEqual(matchNamespaces(FLEET, "orbit plt live ap"), ["orbit-plt-live-ap"]);
  assert.deepEqual(matchNamespaces(FLEET, "multiten"), ["orbit-multitenant"]);
  // "ultitenant" is only part of a segment and not the first word: no match.
  assert.deepEqual(matchNamespaces(FLEET, "orbit ultitenant"), []);
  assert.deepEqual(matchNamespaces(FLEET, "nosuchcustomer"), []);
  assert.deepEqual(matchNamespaces(FLEET, ""), []);
});

test("matchNamespaces: an environment word is never matched inside another word", () => {
  // Regression: "prod" matched inside nonprod and preprod, so "orbit prod"
  // searched both although orbit has no prod.
  assert.deepEqual(matchNamespaces(["orbit-nonprod", "orbit-preprod"], "orbit prod"), []);
  assert.deepEqual(matchNamespacesPhrase(["orbit-nonprod", "orbit-preprod"], "orbit prod"), {
    namespaces: ["orbit-nonprod", "orbit-preprod"],
    name: "orbit",
    tail: ["prod"],
  });
  // Regression: "dev" matched inside another customer's name.
  assert.deepEqual(matchNamespacesPhrase(["zeta-prod", "zetadevtools-prod"], "zeta dev"), {
    namespaces: ["zeta-prod"],
    name: "zeta",
    tail: ["dev"],
  });
});

test("matchNamespacesPhrase: every cut is tried exactly before any is tried partly", () => {
  // Regression: "acme" read as part of another customer's acmecorp-prod before
  // the exact acme-dev was found by dropping "prod".
  assert.deepEqual(matchNamespacesPhrase(["acme-dev", "acmecorp-prod"], "acme prod"), {
    namespaces: ["acme-dev"],
    name: "acme",
    tail: ["prod"],
  });
});

test("matchNamespaces: separators do not count", () => {
  const values = ["northstar-prod", "northwind-prod"];
  assert.deepEqual(matchNamespaces(values, "north star"), ["northstar-prod"]);
  assert.deepEqual(matchNamespaces(values, "north-star"), ["northstar-prod"]);
  assert.deepEqual(matchNamespaces(values, "north star prod"), ["northstar-prod"]);
  // Part of the first word, the rest whole segments.
  assert.deepEqual(matchNamespaces(["beaconlabs-prod"], "beaconl prod"), ["beaconlabs-prod"]);
  assert.deepEqual(matchNamespaces(["beaconlabs-prod"], "beaconl pro"), []);
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
