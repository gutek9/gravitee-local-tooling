# grafana-mcp-adapter

Read-only MCP server that exposes Grafana datasources and metric/log queries as
tools.

## Architecture

The adapter *is* the MCP server. Internally it calls the **Grafana HTTP API**
directly. MCP servers are
not chained to one another.

- Auth (required): this adapter needs a Grafana **service account** and its
  **token**, sent as a Bearer token in the `Authorization` header. The service
  account is provisioned by Gravitee personnel — request it via a change
  management request, scoped to a read-only role (Viewer). Put the token in
  `GRAFANA_TOKEN` in your `.env`.
- Most tools return **raw** payloads (e.g. datasource lists). The exception is
  the high-volume one: `grafana_query` returns a compact per-series digest by
  default (a full `up` query is ~8 MB of frames, far past what an MCP context
  wants); pass `raw=true` for the full frames. `grafana_logs_link` never returns
  log bodies at all — it discovers matching streams via Loki's `/series` (label
  sets only) and returns links plus those stream labels.
- Read-only by design. Note that `grafana_query` is a `POST` (Grafana's
  `/api/ds/query` is POST-shaped) but only **reads** metrics/logs.

## Tools

| Tool | Purpose |
| --- | --- |
| `grafana_health` | Config/connectivity check (makes one authenticated call). |
| `grafana_list_datasources` | List configured datasources (uid, name, type). |
| `grafana_query` | Run a PromQL/LogQL/etc. query against a datasource uid over a time range. Returns a per-series digest by default. |
| `grafana_logs_link` | Build a shareable Grafana logs link for a customer's logs. Discovers matching streams via Loki's `/series` (label sets only, no log lines) to scope the link. Defaults to Logs Drilldown links (per-namespace); pass `link_style="explore"` for a raw LogQL Explore link. |
| `grafana_find_customer` | Which customer or deployment is this, by name or by id. Touches no logs. |

### `grafana_query` response shape

The raw `/api/ds/query` response carries a full timestamp+value array per series,
and a query like `up` can return thousands of series (~8 MB). By default the tool
collapses each series to its labels + a numeric digest and caps the list:

```jsonc
{
  "results": {
    "A": {
      "status": 200,
      "series_count": 3085,        // total series before capping
      "series": [                  // capped to maxSeries (50)
        { "labels": { "job": "..." }, "count": 60, "first": 1, "last": 1, "min": 0, "max": 1, "avg": 0.98 }
      ],
      "truncated": 3035            // how many series were dropped from `series`
    }
  }
}
```

Pass `raw=true` to get the full (potentially very large) frames instead.

### `grafana_logs_link`

Name the customer in `client` (`client='kestrel'`, or `'kestrel prod'` for one
deployment) and the component in `component` (`component='gateway'`). `client`
is first resolved to the customer's own namespaces: a Gravitee Cloud customer
through the customer map, a hosted customer through Loki's `namespace` label, or
a data plane's full id (see
[Finding a customer](#finding-a-customer-without-guessing-which-word-is-the-environment)).
`component` then narrows by `service_name` inside them. A customer with no
namespace of its own (one that lives in a shared namespace such as `prod`) is
matched against `service_name` instead, outside Gravitee Cloud namespaces.

Returns `{ query, link_style, resolved_namespaces, links, range, matched_count,
matched_streams }` plus the fields below, where `matched_streams` is the list of
`{ namespace, service_name }` label sets the selector matched (discovered via
Loki's `/series` — no log lines are fetched) and `resolved_namespaces` is the
namespaces `client` resolved to (empty on the `service_name` path). A refused
call returns `refused: true`, empty `links` and `resolved_namespaces`, and the
reason in `note` (not repeated in `customer_note`), with no `query` or
`matched_*`: nothing was queried. The default range is the last hour; widen
with `from`/`to`. When nothing matches on the `service_name` path, it returns
close `service_name` values as `suggestions`, so typos like `kestrl → kestrel`
surface. They come from outside Gravitee Cloud namespaces only, like the search
itself. A blank `client` is refused: with nothing to narrow by, it would match
every stream in Loki.

The response also says how the customer was found:

- `resolved_via` — `namespace_label` (a hosted customer whose namespace carries
  its name), `customer_map` (a Gravitee Cloud customer, found through the
  deployment map), both joined with `+`, or `none`.
- `map_source`, `map_generated_at`, `map_warning` — where the map came from
  (`github`, `bundled_snapshot`, `unavailable`) and whether it is stale, or
  whether its age could not be read. When it is `unavailable`, `map_warning`
  says why the map could not be read from GitHub (e.g.
  `GITHUB_PERSONAL_ACCESS_TOKEN is not set`) and, when a snapshot file is there
  but cannot be used, why; no note then calls a name or an id "not in the map".
  When rows of the CSV could not be used (see "What the map must look like"),
  `map_warning` says how many were left out and names the first three.
- `matched_deployments`, `control_plane_ids`, `shared_control_plane_namespaces` —
  the Cloud deployments behind the namespaces. Control-plane namespaces are
  shared by every customer on that control plane, so they are reported but never
  searched under one customer's name. A trial's own control plane
  (`apim-cp-trial-<id>`) hosts only that trial: it is searched with the trial
  (in `resolved_namespaces`, with `control_plane_is_single_tenant`), and never
  listed as shared.
- `ambiguous_customer`, `candidates`, `candidates_truncated`, `customer_note`
  (`note` when refused) —
  the fragment matched several customers: several Cloud ones, hosted namespaces
  of more than one customer (`plt live` in `nova-plt-live` and `vega-plt-live`),
  or a hosted customer and a different Cloud one. Nothing from them is searched.
  Unless a hosted namespace is named after the whole fragment (`beac-prod`, not
  `zeta-beac-prod`), nothing is searched at all
  (`refused`): a `service_name` match across all of Loki would search the same
  ambiguous fragment. Each candidate says its `kind` (`gravitee_cloud` or
  `hosted`); a Cloud one also has the same `deployments`, `control_plane_ids`,
  `envs` and `regions` as in `grafana_find_customer`. At most ten are listed.
  Pass the exact name.
- `similar_names_not_searched`, `customer_note` — names that only contain the
  one asked for, while another customer has it as a whole name: `acme` searches
  the Cloud customer acme, not the hosted `acmecorp-*`. Name one to search it.
- `partial_name_match`, `customer_note` — the name was only part of one
  customer's name (`beaconl`), so it was searched as that customer.
- `refused`, `partial_match_unchecked` — the name was only part of a customer's
  name and the map or Loki's namespace list could not be read, so it cannot be
  checked that no other customer has it as a whole name. Nothing is searched; use
  the full name.
- `matched_by_id`, `owner_unknown` — `client` was an id from an alert or a pod
  name. A data plane (`apim-dp-cp1111-dp0001` or `cp1111-dp0001`) is searched
  alone, with its customer when the map knows it; when only Loki knows it,
  `owner_unknown` says whose it is cannot be told. One the map lists under more
  than one customer is refused, naming them all (`matched_by_id.customers`):
  whose logs it holds cannot be said. A control plane (`cp1111`) is
  refused: its namespace is shared by every customer on that organization. Pass
  the customer's name with `control_plane_id` instead. A trial is named by its
  control-plane id (`trial-tt0001`) and resolves as that customer. A trial's
  control-plane namespace (`apim-cp-trial-tt0001`) hosts only that trial, so it
  is searched alone, like a data plane, with `control_plane_is_single_tenant`;
  when the map does not list the trial or cannot be read, only if Loki has
  it, with `owner_unknown`. A data
  plane's own id alone (`dp0001`) is refused, listing the data planes that carry
  it (`data_planes`, with their customer when the map knows it, or `customers`
  when it lists several, which is never searched): pass the full namespace of
  the one you mean.
- `shared_data_planes`, `shared_data_planes_truncated` — what `client` would
  search includes a data plane the map lists under more than one customer
  (`data_plane_id`, `customers`; at most ten, with how many were left out). Its logs
  cannot be said to be either's, so nothing is searched, hosted namespaces
  included, whatever `control_plane_id` says. The note names the customer's other
  data planes, which can be searched by their id.
- `spans_multiple_organizations`, `organizations_note` — one name, several Cockpit
  organizations. Pass `control_plane_id` to narrow to one.
- `refused`, `unknown_control_plane`, `requested_control_plane_id` — the
  `control_plane_id` selected nothing: it is not one of the customer's
  organizations, the customer is not in the map, or the name is ambiguous.
  Nothing is searched, and `control_plane_ids` lists the valid ids. Case and
  surrounding spaces do not matter (`CP1111` is `cp1111`), and a blank id is
  taken as none. An id only ever narrows; it is never dropped to search more
  widely. A hosted namespace is on no Cockpit organization, so with an id it is
  left out and reported in `skipped_namespaces`.
- `refused`, `unknown_qualifiers`, `known_environments`, `known_regions` — a word
  after the customer name (environment, region or provider) describes none of
  its deployments and none of its namespaces, e.g. `acme staging` when acme only
  has prod, dev and qa. Nothing is searched; retry without the word, or with one
  of the environments, regions or namespaces listed. A word only ever narrows; it
  is never dropped to search more widely. A component typed into `client`
  (`lumen prod gateway`) is refused the same way, and the note says to pass it as
  `component`.
- `skipped_namespaces`, `skipped_namespaces_note` — namespaces found for the
  customer name but not for the words after it, so not searched: `acme dev`
  searches acme's Cloud dev deployment, not its hosted `acme-prod`. To search
  one, name it: `orbit plt live` for `orbit-plt-live`, where `orbit prod` is
  refused.
- `mapped_namespaces_absent_in_range` — namespaces the map lists that Loki has
  not seen in this range. When nothing matches and these exist, the `note` says
  the map is probably stale rather than reporting "no logs".
- `namespace_lookup_failed`, `namespace_lookup_note` — Loki did not return its
  namespace list. The note gives the reason (the request and its HTTP status, or
  the error when Grafana did not answer), and the adapter logs it as a warning.
  Hosted customers could not be matched by namespace, and mapped namespaces were
  not checked against Loki, so none is reported as absent.
- `refused` with `namespace_lookup_failed` or `map_source: "unavailable"` —
  neither route found `client`, and one of them could not run. A customer with
  no namespace of its own (one in a shared `prod`) is found by a `service_name`
  search, but only once both the map and Loki's namespace list answered: without
  them, finding nothing is not "no such customer", and `service_name` alone
  could return another customer's logs. Nothing is searched, and the note says
  whether a retry can help. For Loki, it advises a retry only after a timeout, a
  network error, HTTP 408, 429 or a 5xx; after any other status it says to check
  `GRAFANA_LOGS_DATASOURCE_UID` (the datasource's uid, not its display name) and
  `GRAFANA_TOKEN` instead. `map_warning` says why the map could not be read.
  With only the map down, a data plane can still be searched by its full
  namespace. A map from the bundled snapshot counts as an answer.
- `suggestions` — close `service_name` values (see above), only when the `client`
  matched no namespace **and** no streams.

#### `link_style`: Logs Drilldown (default) vs Explore

`link_style` chooses the link format in `links`:

- **`drilldown`** (default) — links into Grafana's **Logs Drilldown** app (the
  "Logs" menu, plugin `grafana-lokiexplore-app`). This app navigates
  **per-namespace** (`/explore/namespace/{ns}/logs`), so `links` carries **one
  link per namespace** the query matched (a customer's logs can span several
  namespaces — e.g. `april-prod`, `april-rec`). Each link pins the namespace and
  adds a `service_name` filter built from the **exact** service names seen in
  that namespace (the app treats a raw LogQL regex value as a literal and matches
  nothing, so we use `=` for one value or a `=~` alternation for several),
  dropping you in already scoped so you can filter/drill (levels, fields,
  patterns) by hand in the UI.
- **`explore`** — a single raw **Explore** deep link carrying the LogQL `query`
  (Grafana 11+ `panes` form). Use this when you want the raw query view.

Each entry in `links` is `{ url }` (explore) or `{ namespace, service_names, url }`
(drilldown). The matching stream label sets are always returned in
`matched_streams` regardless of `link_style` — no log lines are fetched.

> **Gravitee Cloud customers.** Cockpit tenants live in
> `apim-dp-<controlPlaneId>-<dataPlaneId>` namespaces that carry no customer
> name, so the namespace label cannot find them. `client` is also looked up in
> the Gravitee Cloud customer map, which resolves the name to those namespaces.
> See [Finding a customer](#finding-a-customer-without-guessing-which-word-is-the-environment).

#### Examples (how a user asks for it)

Just ask in plain language — the agent maps it to the `client` / `component` /
`from` / `to` / `line_filter` arguments for you.

> "Give me the last hour of API gateway logs for **Northwind**."
> → `{ "client": "northwind", "component": "gateway" }`

> "Show me the engine logs for **Contoso** over the last 6 hours."
> → `{ "client": "contoso", "component": "engine", "from": "now-6h" }`

> "Find the gateway errors for **Globex** in the last 3 hours."
> → `{ "client": "globex", "component": "gateway", "line_filter": "error", "from": "now-3h" }`

> "I need the UI logs for **Initech** during yesterday's incident between 10:00 and 11:00."
> → `{ "client": "initech", "component": "ui", "from": "<epoch ms 10:00>", "to": "<epoch ms 11:00>" }`

> "Give me the **production** gateway logs for **Northwind**."
> → `{ "client": "northwind prod", "component": "gateway" }`

(The environment — `prod`, `rec`, `dev` — isn't a separate argument: fold it
into `client` as another word. When the customer resolves to its own namespaces,
the phrase picks the namespace (`northwind prod` → `northwind-prod`) and
`service_name` is not filtered by it again; see the next section. When it does
not, the words are matched against `service_name` as case-insensitive substrings
with `.*` between them, so `northwind prod` matches `…-northwind-prod-…`. There,
known environment words (`prod`, `rec`, `dev`, `nonprod`, `preprod`, `qa`,
`int`, `ppr`, `sandbox`, …) are anchored to a whole `service_name` segment, so
`prod` matches `…-prod-…` but **not** the `prod` inside `nonprod`/`preprod`.)

Each call returns `links` — shareable Grafana links (Logs Drilldown per namespace
by default; see `link_style` above) — plus `matched_streams`, the
`{ namespace, service_name }` label sets the selector matched. No log lines are
fetched; open a link to read the logs in Grafana.

### Finding a customer without guessing which word is the environment

`client` is resolved by two routes, always both: the namespace label (hosted
customers, whose namespace carries their name) and the Gravitee Cloud customer
map (Cockpit tenants, whose namespaces carry only ids). A customer can be in both
populations at once, so stopping at the first route that answers would search
half of its logs.

`client: "acme rec"` has to be split into a customer and an environment. That
split used to run against a fixed list of environment words, and no such list
can be finished: customers name their environments their own way (`staging`,
`prd`, `sit`, `qualif`, `multitenant`, ...), some with only two letters.

Worse, an unlisted word was not noticed at all. It stayed part of the name, the
name matched nobody, and the answer was empty with no reason given (`acme
recette`, `beacon staging`, and `production` failing where `prod` worked). The
reverse bit too: some namespaces are *called* `prod` or `dev`, so the split left
an empty name.

Nothing is classified now. Both routes match the phrase as typed, and give ground
only when it matches nothing:

- **Namespaces**: the whole name, then the owner's segment (the first) followed
  by whole `-` segments, and only when nothing matches that way, part of a name:
  the first word as part of a segment, or whole segments after the owner's (the
  other words still whole). Separators do not count (`north star` finds
  `northstar-prod`), and a word is never matched inside another: `prod` does not
  find `nonprod`. `orbit plt live` returns that namespace, not it plus its
  `-ap`/`-au`/`-eu` siblings. Namespaces found only by dropping trailing words
  are reported as `skipped_namespaces`, not searched: they ignore what the
  caller said about the deployment.
- **The map** is asked where the name ends: every cut of the phrase is tried for
  a whole customer name (separators aside) before a single word is tried as part
  of one, so `acme dev` is acme's dev deployment, not a customer whose name
  merely contains `acmedev`. The tail is then matched against what the
  deployment *is* — environment, region or provider — so `acme dev europe`
  narrows, and a tail describing nothing is refused along with the environments
  and regions that customer actually has. When the longest whole name is one
  customer's and a shorter cut is another's, with the rest describing one of
  that other's deployments (customers `acme dev` and acme, which has a dev), the
  phrase reads two ways: it is refused with both as `candidates`, unless
  `control_plane_id` is on only one of them, which picks it.

Both routes try every cut of the phrase as a whole name before any as part of
one. A phrase can still resolve to several deployments when they really are
several: a customer can run more than one data plane per environment, and a
region or provider word narrows those.

On these two routes, what is searched belongs to one customer. A hosted customer
is the first segment of its namespaces (`acmecorp-prod` → acmecorp), so a word
found only after it (`nova` in `zeta-nova-prod`) is part of zeta's namespace
name, never a customer called nova: it is searched as zeta and flagged
`partial_name_match`, or refused like any other part of a name. A whole name on
either route outranks part of a name on the other, and parts of two customers'
names are refused. Cloud namespaces (`apim-dp-*`,
`apim-cp-*`) carry ids, not names, so the namespace route never matches them:
they are reached through the map or through an id typed into `client`. The
`service_name` search used when `client` resolves to no namespace leaves them
out too (`namespace!~"(?i)apim-(dp|cp)-.+"`): their service names carry ids
(`prod-apim-dp-cp1111-dp0001-gateway`), so a fragment of one (`cp11`) would
reach a shared control plane and several customers' data planes. Some limits
follow from reading names off namespaces, and one from that search:

- Infrastructure named per tenant (`apim-cloudgate-<id>`, `logstash-<id>`) or
  shared (`redis-*`, `ingress-*`) has no customer in its first segment, so a
  phrase naming the infrastructure (`cloudgate`) is read as part of one
  customer's name (`apim`) and searches every tenant's, flagged
  `partial_name_match`. A tenant id alone (`<id>`) matches both its
  `apim-cloudgate-` and `logstash-` namespaces, reads as two customers, and is
  refused; name the full namespace instead.
- A namespace called just like an environment (`prod`, `staging`) is shared by
  many customers' services, yet `client: "prod"` searches it, because nothing in
  the namespace list tells it apart from a customer with a single namespace.
- A Cloud customer and a hosted namespace group with the same name are taken
  for one customer, and both are searched. Nothing in either source tells them
  apart when the hosted group is not that customer's, for example shared
  infrastructure that happens to start with the customer's name.
- The `service_name` search matches part of a service name and does not check
  whose it is: a client that has no namespace of its own (it lives in a shared
  `prod`) also finds other customers' services whose names contain it
  (`kestrel` finds `kestrelcorp-gateway`).
- The namespace route does not look for a second reading the way the map
  route does: `acme dev` is acme's whole namespace `acme-dev`, even when another
  hosted owner is called `acmedev` (`acmedev-prod`), and only acme's is searched.

One consequence: a pinned namespace already expresses the environment, so
`service_name` no longer repeats it — and the "drop the env token and retry"
fallback is gone with it.

### `grafana_find_customer`

Answers "who is this, and what do they have?" without querying any logs. Use it
when `grafana_logs_link` reports `ambiguous_customer`, when a name spans several
Cockpit organizations, or to see what a customer has before searching.

`query` is a customer name or fragment (`acme`), or an id as it appears in an
alert, pod name or dashboard (`apim-dp-cp1111-dp0001`, `cp1111-dp0001`,
`cp1111`). The id lookup is always attempted, so pasting a namespace from an
alert tells you whose it is: when the map gives the id one owner, the note
names it, and for a data plane whose namespace Loki has not seen in the last 30
days it adds that the map is probably stale. A blank `query` is refused.

It returns, per Gravitee Cloud customer: deployment count, Cockpit
organizations (`control_plane_ids`, to pass as `control_plane_id`), environments,
regions, the exact namespaces `grafana_logs_link` searches for it (its data
planes, plus a trial's own control plane, flagged `control_plane_is_single_tenant`),
and the shared control-plane
namespaces. A data plane the map also lists under another customer is flagged in
`shared_data_planes`, and `grafana_logs_link` refuses any search that includes
it; an id the map lists under several customers names them
(`matched_by_id.customers`). Hosted customers come back as `hosted_namespaces`. Gravitee Cloud
namespaces whose name matches (`apim-dp-*`, `apim-cp-*`, for example every data
plane on `cp1111`) come back apart as `cloud_namespaces`: their name carries
ids, not the owner, so look one up by its full id. Data planes that
are live on a customer's control plane but missing from the map are listed as
`unattributed_namespaces_on_same_control_plane`: a control plane is shared, so
they may belong to another customer and are never searched as this one.
`max_results` (default 20, at most 50) caps every list in the answer, each
customer's own lists and `matched_by_id`'s included. A count next to each list
(`<list>_truncated`; `gravitee_cloud_truncated` and `unattributed_truncated` for
the customers and their unattributed data planes) says how many were left out,
0 when none were. A note names at most ten, then "and N more". When
Loki does not return its namespace list, `namespace_lookup_failed` says hosted
namespaces and unattributed data planes could not be checked, rather than
reporting that none matched, and `namespace_lookup_note` says why. Likewise, when the customer map cannot be read, the
note says Gravitee Cloud customers and ids were not checked (`map_warning` says
why), rather than that none matched.

## Setup

This service ships as part of `local-tooling`. It is **opt-in** and disabled by
default, so teams that don't use Grafana are unaffected.

To enable it, set the following in your `local-tooling` `.env` (which is
git-ignored — never hardcode the token):

```bash
GRAFANA_ENABLED=true
GRAFANA_BASE_URL=https://your-grafana-host   # e.g. https://gravitee.grafana.net
GRAFANA_TOKEN=...                            # service account token (see Auth above)
GRAFANA_LOGS_DATASOURCE_UID=...              # uid of the Loki datasource (see below)
```

Then rerun `bin/local-tooling setup` with your usual `--agents` and `--repo`
values, and restart the agent. With `GRAFANA_ENABLED=true`, setup adds the
`grafana` MCP server to your agent config (`.mcp.json` / Codex) just like
`zendesk` / `vectordb` / `github`, with no manual wiring. It needs HTTPS egress
to the Grafana instance, and to `api.github.com` for the customer map (below).
While `GRAFANA_ENABLED` is not `true`, the adapter makes no request at all: its
tools say Grafana is disabled, and it does not read the customer map at startup.

`GRAFANA_LOGS_DATASOURCE_UID` is **required** — it has no default. A uid that is
correct for one Grafana org is a silent, plausible failure in every other one, so
it is never guessed: `local-tooling doctor` reports it missing, and
`local-tooling mcp grafana` (what your agent runs) does not start the adapter
without it, so no Grafana tool is available until it is set. Started some other
way, the adapter's map tools (`grafana_logs_link`, `grafana_find_customer`)
refuse with a message naming it rather than returning an empty result.

Find it under Connections > Data sources > (Loki). **The uid is not always the
same as the display name.** On the Gravitee instance the datasource is displayed
as `grafanacloud-gravitee-logs` but its uid is `grafanacloud-logs`.

### The customer snapshot is never committed

`customers-snapshot.json` is a **local fallback cache** and is deliberately
gitignored. It is generated from `gravitee-io/cloud-deployments-configuration`,
which is **private**, and it contains the customer list with their control-plane
and data-plane ids. **This repository is public** — committing that file would
publish who Gravitee's customers are and how their infrastructure is addressed.

Generate it locally when you want an offline fallback. The script runs on the
host, and Node does not read `.env` by itself: pass it the repo's `.env`, which
keeps the token out of your shell history (Node 20.6 or later):

```bash
cd services/grafana-mcp-adapter
node --env-file=../../.env scripts/refresh-customers.mjs
```

It needs `GITHUB_PERSONAL_ACCESS_TOKEN` and uses the same
`GRAFANA_CUSTOMER_MAP_*` repository and timeout settings as the adapter. With
those already in the environment, `npm run refresh-customers` does the same. It
writes `customers-snapshot.json` next to `server.js`, and never reads
`GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH`, which is a path inside the container. To
write another file, add `--out FILE`. A relative `FILE` is taken from the
directory you typed the command in, through npm too (`npm --prefix`, or from a
subdirectory). Keep that file outside this repository, or name it
`customers-snapshot*.json`: git ignores that name anywhere in the repo. It
writes nothing, and exits 1, when the CSV lacks a column the map needs or has a
row that cannot be used (see "What the map must look like").

The adapter does not see a new snapshot until its image is rebuilt. The
Dockerfile copies the file at build time, and the container your agent starts
(`docker compose run --rm`) uses the image as last built. From the repo root:

```bash
./bin/local-tooling start
```

rebuilds it; then restart your agent, or reconnect its `grafana` MCP server. The
image now contains the customer list too: keep it on your machine and never push
it to a registry.

The snapshot records two dates: `source_generated_at`, when the CSV was last
committed in the source repo, and `refreshed_at`, when you ran the command. The
fallback's freshness warning and `map_generated_days_ago` use the CSV's date, so
refreshing an old CSV today does not make the map look current. A snapshot from
before this split says its source date is unknown; run the command again to
record it.

The build does not need it. The Dockerfile's `COPY customers-snapshot.jso[n]` is a
no-op when the file is absent, so a fresh clone builds; the adapter fetches the
map from GitHub at runtime and, if the map cannot be read from GitHub AND no
usable snapshot exists, reports that Gravitee Cloud customers cannot be resolved
rather than failing or guessing. Hosted namespaces still
resolve from Loki by name, but a customer that also runs on Gravitee Cloud then
gets only its hosted part, and the response says so (`map_source: "unavailable"`
and `map_warning`). A `client` that names no hosted namespace is refused rather
than searched by `service_name` alone, because without the map nobody can tell
it is not a Gravitee Cloud customer; this includes customers that live only in a
shared namespace, for as long as the map cannot be read.

A snapshot that is not valid JSON, has no customers, or has a row of another
shape than `refresh-customers` writes is not used at all: it is the adapter's
own copy, written only from a CSV whose every row can be used (see "What the map
must look like"), so one such row means the file is not that copy.
`map_warning` says why. A source date that cannot be read, or lies more than a
day in the future, is reported as unknown.

### What the map must look like

The map is read from six columns of the CSV, found by name: `Customer`,
`ControlPlaneId`, `DataPlaneId`, `Region`, `Provider` and `URLs` (where the
environment is read). Without one of them the CSV is not used as the map: the
adapter falls back as when GitHub cannot be read, and `map_warning` names the
missing column. A row is used when it has as many fields as the header, a
customer (`N/A` for a trial, whose data plane id then starts `trial-<id>-`), a
data plane id made of lower-case letters and digits in two or more
dash-separated parts (what follows `apim-dp-` in a namespace; an id in capitals
is read in lower case), and a control plane id equal to the data plane id
without its last part (a trial's is taken from its data plane id).
Any other row is left out: every answer's `map_warning` says how many, names the
first three by their line in the CSV, and says that a customer on them resolves
only partly, or not at all, until the CSV is fixed. A customer whose every row
was left out is answered as one the map does not list. `refresh-customers` then
writes nothing, and `validate-customers` fails; both list every row left out.

### Customer-map environment variables

The Gravitee Cloud customer map is fetched at runtime from a private GitHub repo.
These variables control where it comes from and how it is cached. Set them in
the repo's `.env`; `docker compose` forwards all of them to the adapter
container, and an empty value means the default. A number that is set must be a
whole number in the range given below: `local-tooling doctor` reports a bad one,
and `local-tooling mcp grafana` does not start the adapter with it, so no
Grafana tool is available until it is fixed. Started some other way, only the
map tools (`grafana_logs_link`, `grafana_find_customer`) refuse, naming the
setting. Only the token is required for
a live fetch. Without it, the adapter falls back to the local snapshot (if you
generated one) or reports that Cloud customers cannot be resolved. Hosted
namespaces still resolve by name, but a customer that also runs on Gravitee
Cloud then gets only its hosted part.

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | *(none)* | Auth for the GitHub fetch. Used at **runtime** every time the map loads, not only by `npm run refresh-customers`, and only while `GRAFANA_ENABLED=true`. |
| `GRAFANA_CUSTOMER_MAP_REPO` | `gravitee-io/cloud-deployments-configuration` | Repo holding the customer CSV. |
| `GRAFANA_CUSTOMER_MAP_PATH` | `docs/summary/customers_summary.csv` | Path to the CSV inside that repo. |
| `GRAFANA_CUSTOMER_MAP_REF` | `prod` | Branch or tag the CSV is read from. |
| `GRAFANA_CUSTOMER_MAP_TTL_SECONDS` | `3600` | How long a successful fetch stays cached in memory. Whole number, 1 to 86400 (a day). A fallback (the snapshot, or no map at all) is kept for at most a minute, so GitHub is asked again soon after it comes back. |
| `GRAFANA_CUSTOMER_MAP_TIMEOUT_MS` | `5000` | Timeout for the GitHub fetch. Whole number, 1 to 60000. |
| `GRAFANA_CUSTOMER_MAP_STALE_DAYS` | `30` | Age after which the map is reported as stale. Whole number, 1 to 365. |
| `GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH` | `customers-snapshot.json` next to `server.js` (`/app/customers-snapshot.json` in the container) | Where the fallback snapshot is read from. Under Docker this is a path inside the container, and Compose mounts no file into it: leave it empty to use the snapshot built into the image. The tests point it at a file of their own. `npm run refresh-customers` does not read it: it writes the file next to `server.js`, or the one given with `-- --out FILE`. |

> **Token type.** The token needs read access to
> `gravitee-io/cloud-deployments-configuration`. In our tests a classic token
> worked and a fine-grained one returned 404. We have not confirmed why. If you
> use a fine-grained token and get a 404, check that its resource owner is
> `gravitee-io` and that the org has approved it, or use a classic token instead.

### Checking the map against Loki

`validate-customers` measures the customer map against the namespaces Loki has
seen: customers whose mapped data planes no longer exist, and live data planes
the map does not know. It reads the map from GitHub as it is now, like
`refresh-customers`, and never the bundled snapshot: a fallback measured as if
it were the map would pass the check meant to catch an outdated one. It exits 0
when the map was measured, no more customers have missing namespaces than
`GRAFANA_VALIDATE_MAX_STALE` allows, no data plane is listed under more than one
customer, and every row of the CSV could be used, so it can gate a refresh. It
exits 1 when a setting is wrong or the GitHub token missing (before any
request), when GitHub or Loki cannot be read (a wrong token included), when the
CSV lacks a column the map needs, when there is nothing to measure (no usable
map row, or no namespaces in the window), above the threshold, when the map
lists a data plane under more than one customer (whatever the threshold:
`grafana_logs_link` refuses such a data plane), or when a row of the CSV cannot
be used (the rest is measured, and every such row is listed:
`grafana_logs_link` leaves them out). Its output names customers, so share it
only where the customer list may be seen.

It runs on the host: the image does not ship `scripts/`, and Node does not read
`.env` by itself. Pass the repo's `.env` to it, which keeps the tokens out of
your shell history (Node 20.6 or later):

```bash
cd services/grafana-mcp-adapter
node --env-file=../../.env scripts/validate-customers.mjs
```

It needs `GRAFANA_ENABLED=true`, `GRAFANA_BASE_URL`, `GRAFANA_TOKEN`,
`GRAFANA_LOGS_DATASOURCE_UID` and `GITHUB_PERSONAL_ACCESS_TOKEN`. With those
already in the environment, `npm run validate-customers` does the same. It also
reads two numbers of its own, listed in `.env.example`; empty means the default,
anything else must be a whole number in range:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRAFANA_VALIDATE_WINDOW_DAYS` | `30` | How many days back a namespace counts as live. 1 to 365. |
| `GRAFANA_VALIDATE_MAX_STALE` | `20` | How many customers may have missing namespaces before it fails. 0 to 10000; 0 fails on any. |

## Testing

Tests use Node's built-in runner — no extra framework. Run them with:

```bash
npm test          # node --test
npm run check     # syntax-check every .js/.mjs file, scripts/ included
```

Coverage:

- `helpers.test.js` — the pure helpers (`helpers.js`).
- `namespaceMatch.test.js` — which namespaces a client phrase names
  (`namespaceMatch.js`): whole name, then the owner's segment and whole
  segments, then part of a name, and giving ground one trailing word at a time.
- `grafanaClient.test.js` — the HTTP client (`grafanaClient.js`): config
  validation, auth headers, param handling.
- `githubClient.test.js` — the GitHub client (`githubClient.js`): the request it
  actually sends (one GET to `api.github.com`, token, headers, encoded path), and
  that a missing token, a bad path segment or a missing timeout sends nothing.
- `lokiDiscovery.test.js` / `logsLinks.test.js` — the Loki reads behind
  `grafana_logs_link` (`fetch` stubbed) and the links it builds from the matched
  streams.
- `customerCsv.test.js` / `customerMatch.test.js` — the Gravitee Cloud customer
  map: CSV parsing (the columns it needs, rows left out with their line), name
  and id lookup, and resolving a customer to namespaces, on made-up rows with
  the real CSV header. No network.
- `customerMapLoader.test.js` — where the map comes from: GitHub, the snapshot
  fallback (a malformed snapshot is none), the unavailable case, caching.
  GitHub is stubbed and the snapshot is a temp file, never a real one.
- `customerResolver.test.js` — resolving a client through both routes (label and
  customer map) from given namespace values and map rows, what of that
  resolution reaches the caller, and finding which customers a name or an id
  matches. No network.
- `scripts/validateCustomerMap.test.js` — the checks behind
  `npm run validate-customers`, including its failure paths: an unavailable or
  empty map, or no live namespaces, fails instead of passing with nothing
  checked, and a bad setting stops the script before any request (the script
  is run with `fetch` replaced, so nothing reaches the network).
- `scripts/refresh-customers.test.js` — `npm run refresh-customers`, run on a temp
  copy of the adapter with `fetch` replaced: where the snapshot is written (next
  to `server.js`, or `--out`, a relative one from where the command was typed,
  never `GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH`), and that a bad argument stops it
  before any request.
- `server.test.js` — the `server.js` orchestration that talks to Loki, with
  `fetch` stubbed per Loki endpoint: `grafana_logs_link`'s namespace resolution
  through both routes (label and customer map), per-namespace drilldown
  grouping, the `explore_url` fallback, and the empty-result
  `note`/`suggestions` branches; `grafana_find_customer`'s name, id, ambiguous
  and unattributed cases; plus `grafana_query`'s digest-vs-`raw` output.
  The stub also answers the customer map's GitHub fetch with a made-up CSV, so
  the tests never read a local `customers-snapshot.json` or the network. `server.js` only starts the stdio
  transport when run as the entrypoint, so tests import it and invoke the
  registered tool handlers directly (via the exported `tools` map).
- `server.disabled.test.js` / `server.no-uid.test.js` — the adapter with Grafana
  disabled (as Compose starts it by default) and with no
  `GRAFANA_LOGS_DATASOURCE_UID`: the map tools say so and make no request at
  all. Each is its own file because those settings are read at import.
