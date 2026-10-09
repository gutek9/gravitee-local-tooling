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
| `grafana_query` | Run a read-only query against a datasource uid over a time range. Pass `expr` for Prometheus/Loki, or `query` (the datasource's own fields) for Elasticsearch/Tempo/Graphite/Pyroscope. Returns a compact digest by default. |
| `grafana_logs_trend` | "When did this start?" — counts matching lines into fixed time buckets and reports total, onset, last seen and peak. Counts only, no log lines. |
| `grafana_logs_patterns` | "What is dominating this log volume?" — Loki's detected line shapes, ranked by volume. **Does not surface rare lines** (see below). |
| `grafana_logs_link` | Build a shareable Grafana logs link for a customer's logs. Discovers matching streams via Loki's `/series` (label sets only, no log lines) to scope the link. Defaults to Logs Drilldown links (per-namespace); pass `link_style="explore"` for a raw LogQL Explore link. |
| `grafana_logs_context` | Every line around a moment in time, **unfiltered** — "what else was happening right then". Refuses a line filter, because a filter is what hides the continuation lines. |
| `grafana_logs_noise` | What is actually filling a stream: lines reduced to their shape, ranked, each with a pasteable LogQL exclusion. Covers what pattern detection cannot see below its floor. |
| `grafana_first_occurrence` | "When did this start?" — the exact first matching line (to the nanosecond), a per-minute ramp around it, and whether the pattern was already running before the window. |
| `grafana_failure_topology` | "Is it the application or the node?" — matching log lines per pod, joined to nodes, with healthy sibling pods for contrast and a verdict. |
| `grafana_explore_link` | An Explore link for any set of queries: several in one pane, split panes, or mixed datasources. Absolute range by default. |
| `grafana_find_customer` | Which customer or deployment is this, by name or by id — and **which cluster** they are on. Touches no logs. |
| `grafana_http_requests` | HTTP request logs from both ingress controllers: status distribution, latency percentiles, retries, and failures per upstream pod and node. The only tool that can reach them (see below). |

### HTTP request logs are not in the customer's namespace

Every `client`-scoped tool resolves the customer to their **own** namespaces, and
those hold application logs only. The access logs — status code, request
duration, upstream response time — are emitted by shared ingress controllers and
identified by the **cluster** label. There are **two**, carrying different traffic:

| Controller | Job | Carries |
| --- | --- | --- |
| ingress-nginx | `flow/ingress-nginx-ingress-nginx` | gateways, management API |
| AKS app-routing | `flow/app-routing-system-` | bridge (`/_bridge/...`) — data plane to control plane sync |

Searching one for traffic that went through the other returns a clean, scanned,
empty result. `grafana_http_requests` searches both by default (`ingress=all`)
and reports them separately. Bridge calls terminate on the **control plane**,
which usually runs on a different cluster from its data planes: pass
`control_plane_id` (and `cluster`) to read them. A control plane is shared by every
customer in its Cockpit organization, so it is never included implicitly.

No namespace-scoped query can reach them. The failure mode is not a missing
feature: a question like "is the Management API slow for this customer" gets
probed with `client`-scoped queries, every one comes back empty, and the empty
results read as evidence the data does not exist.

So `grafana_find_customer` returns `clusters` alongside the namespaces, every
`client`-scoped tool carries a `scope_note` saying what it did **not** search,
and `grafana_http_requests` resolves the cluster for you.

Scoping is handled rather than left to the caller. On a cluster dedicated to one
customer the cluster-wide ingress stream *is* their request log. On a shared
cluster it is not, so the query is narrowed to requests whose upstream is one of
that customer's namespaces — with the one honest limit stated in the response: a
request rejected at the ingress before an upstream was chosen carries no upstream
and is therefore excluded.

Prefer it over a line filter on the raw stream. The access-log line carries
several bare numbers, so `|= " 499 "` also matches 200s whose request length
happened to be 499 bytes; `status_filter` matches the parsed field only.

### Retries, failing pods and nodes

When nginx retries a request against another upstream it writes every attempt,
comma-separated, into each upstream field (`10.0.1.11:8082, 10.0.1.12:8082 …
502, 200`). A space-delimited parser shifts every field after the first comma,
and a single unparseable value makes Loki reject the whole unwrap query with
HTTP 400 — which is why the tool used to fail on longer windows. The upstream
fields are now captured as whole lists, every unwrap is guarded to admit only a
single number, and only the request count can fail a call: a refinement Loki
rejects is reported under `partial_failures` with its query and Loki's reason.

Aggregate mode reports `by_upstream`: attempts and failures per upstream pod IP,
with retries split pairwise (a request that ended 200 after a 502 is one bad pod
and one good one). With `GRAFANA_METRICS_DATASOURCE_UID` set to a Prometheus
datasource scraping kube-state-metrics, IPs are resolved to pods and nodes
(`kube_pod_ips` joined to `kube_pod_info` — the latter has no pod IP of its own)
and rolled up in `by_node`: one bad node shows up as the row carrying the
failures while its siblings elsewhere are clean.

`nginx_ingress_controller_requests` is scraped (labels `exported_namespace`,
`ingress`, `status`, `controller_class`), but **not on every cluster** — check
coverage for the cluster before reading an empty result as "no requests".

### Metric step and timelines

`/api/ds/query` does not derive a step from `maxDataPoints`: without `intervalMs`
Loki and Prometheus metric queries evaluate at 1s, so an hour returned 3,601
points per series — unreadable in the digest and over the tool-result limit raw.
`grafana_query` now sends `intervalMs` from `max_data_points` (or an explicit
`step`), reports `step_seconds`, and `output="timeline"` returns
`[timestamp, value]` pairs so you can see *when* something changed.

### Explore links

Multi-query and split-pane Explore links used to be URL-encoded by hand.
`grafana_explore_link` takes `queries` with `split` (one pane per query, at most
two), or explicit `panes`, and returns the URL. A pane holding queries for more
than one datasource uses Grafana's Mixed datasource. Every datasource is checked
against the read-only allowlist; CloudWatch Logs Insights is refused and a
CloudWatch link carries the billing notice, since opening it runs the query.

The format was verified on this instance (Grafana 13.3) by opening each shape
and reading back the URL Grafana rewrote itself to: split panes, a Mixed pane,
a Loki logs pane, absolute and relative ranges. Grafana adds editor state of its
own on load (`editorMode`, `direction`, `compact`) and may replace the pane ids
with its own; neither changes what the link shows. The tool's own output was
opened the same way before this shipped: datasources, queries and ranges came
through unchanged.

**Time zones.** Explore displays times in the *viewer's* time-zone preference
and ignores a `timezone` parameter in the URL. Links therefore default to an
**absolute** range in epoch milliseconds: every viewer sees the same instants,
each in their own zone. A relative range such as `now-1h` is re-evaluated when
the link is opened, so a link pasted into a ticket would show a different window
tomorrow; pass `absolute: false` if that is what you want.

### Is it the application or the node?

In an incident the cause only became clear once errors were grouped by pod and
the pods joined to nodes: every failing pod sat on one node, and sibling pods on
other nodes were healthy. That took three manual queries across Loki and
Prometheus. `grafana_failure_topology` does it in one call:

1. Matching lines per pod — a Loki count grouped by `cluster, namespace, pod` and
   the sampling label.
2. Sibling pods — the pods whose streams match the same selector in the window,
   from Loki's index (`/series`, no log bodies). "Healthy" means logging, without
   matching lines.
3. Node placement — `kube_pod_info` via `GRAFANA_METRICS_DATASOURCE_UID`, batched
   per cluster, 40 namespaces a query.

Each node reports its share of matching lines **next to its share of pods**. A
node running most of the pods is expected to carry most of the errors, so error
share alone would single it out wrongly. The verdict — `node_concentrated`,
`nodes_concentrated`, `spread`, `uneven`, `single_node`, `no_errors` or
`insufficient` — comes from comparing the two over the whole fleet, and the
thresholds are in every result:

- `distribution_distance_pct` — how far where the lines are is from where the
  pods are, over all nodes (half the summed difference of shares). Under 30% is
  `spread`.
- `concentration` — the fewest nodes carrying 80% of the lines and the share of
  pods they run. Concentrated when that is at most half the pods, at least twice
  their pod share, no more than a quarter of the nodes, and clean siblings exist
  elsewhere.

It is measured over the whole distribution because a per-node check cannot see
concentration on several nodes. Checked live: every "mongo" line across 777
control-plane pods sat on 5 of 39 nodes, each only ~25 points over its pod share,
and a per-node check called that "spread".

Sampling is reported per pod, and flagged when it is uneven: checked against the
live instance, two of five gateway pods had lines in a sampled group and three
did not, and a pod whose lines are not sampled looks worse than a sampled sibling
with the same problem.

For HTTP failures per upstream pod and node, `grafana_http_requests` already
reports `by_upstream` and `by_node`.

### Who owns a broad result

Sync errors on "126 namespaces across 10 clusters" read as a global problem. They
were all data planes of 19 control planes — and control planes own data planes in
every region, so trouble on the control-plane side surfaces everywhere at once.

A Gravitee Cloud data-plane namespace carries its owner in its name:
`apim-dp-<controlPlaneId>-<dataPlaneId>` (trials: `apim-dp-trial-<id>-<dp>`).
Checked against the live instance: every `apim-dp-*` namespace has that shape,
and every control-plane id derived from one has a live `apim-cp-<id>` namespace.
So attribution is exact, not a map lookup.

When a `grafana_query` result spans three or more data-plane namespaces,
`owner_rollup` groups them:

- `by_control_plane` — each owning control plane, the cluster it runs on (from
  its own `apim-cp-<id>` namespace), its customers from the deployment map, how
  many data planes are affected and across which clusters.
- `by_control_plane_cluster` — the same, rolled up to where the control planes
  run.
- a `note` that says so plainly when the result spreads across more data-plane
  clusters than its control planes run on.

The rollup is built from the raw result, not the digest: the digest keeps 50
series, and a rollup over a truncated list would undercount exactly the broad
results it exists for.

### Onset: the first line, not the first bucket

Loki stamps a `count_over_time` point at the **end** of the interval it counts: at
a 5m step, the point stamped 17:15 holds the lines from (17:10, 17:15]. Filed under
its own stamp, every trend bucket read one interval late — an onset read off
5-minute buckets came out at 10:35 for an error that began at 10:30. Buckets are
now labelled by the **start** of their interval (every result with buckets says so
in `bucket_covers`), and the range query asks for one step past the end so the
final interval is counted.

A bucket still only says "somewhere in this interval". `grafana_first_occurrence`
finds the onset bucket, then the exact first line inside it with a forward,
limit-1 query, and a per-minute ramp around it. Two things it will not do:

- **Call a window edge an onset.** It counts the minutes before `from`; if the
  pattern was already occurring, the result says the first line marks where the
  *window* starts and to widen `from`.
- **Treat the first line that reached Loki as the first line written.** On a
  sampled stream the true first occurrence can be earlier, and the result says so.

`first_occurrence.ns` goes straight into `grafana_logs_context` as `at`.

### Finding a customer without guessing which word is the environment

`client: "acme rec"` has to be split into a customer and an environment. That
split used to run against a list of 16 known environment words. A list cannot be
finished: measured against every live customer, **38 of 82** multi-namespace
customers have a suffix it did not contain (`staging`, `prd`, `sit`, `qualif`,
`multitenant`, `plt-live-ap`), and `one customer`'s environments are `ab`, `ge`,
`pr`, `se`.

Worse, an unlisted word was not noticed at all. It stayed part of the name, the
name matched nobody, and the answer was empty with no reason given — **39 of 416**
Cockpit deployments (`acme recette`, `beacon staging`, and `production`
failing where `prod` worked). The reverse bit too: seven namespaces are *called*
`prod` or `dev`, so the split left an empty name.

Nothing is classified now. Both routes match the phrase as typed, and give ground
only when it matches nothing:

- **Namespaces** in tiers — whole name, then whole `-` segments, then substring.
  `orbit plt live` returns that namespace, not it plus its `-ap`/`-au`/`-eu`
  siblings.
- **The map** is asked where the name ends: drop one trailing word at a time
  until a customer matches. The tail is then matched against what the deployment
  *is* — environment, region or provider — so `acme dev europe` narrows, and a
  tail describing nothing is reported along with the environments that customer
  actually has.

Measured live after the change: hosted **286 of 286** exact (was 104, with 7
resolving to nothing), Cockpit **0** failures (was 39). The 133 Cockpit phrases
that still return several deployments are genuinely several: 46 customer+
environment pairs have more than one data plane, and region or provider
separates 30 of them.

One consequence: a pinned namespace already expresses the environment, so
`service_name` no longer repeats it — and the "drop the env token and retry"
fallback is gone with it.

### Compare against the same window, earlier

`grafana_query`, `grafana_logs_trend` and `grafana_http_requests` take
`compare_offset` (`1d`, `7d`, `1w`). The identical query runs again over the
same-length window that much earlier, and each result answers two questions
separately:

- `already_present` — did this exist in the baseline at all? This is the
  "was it already happening?" answer.
- `change` — did its level move? `similar` (within x0.75-x1.33), `higher`,
  `lower`, `new`, `gone`, `none`, or `no_baseline`.

It exists because a baseline taken earlier the same day — a quieter hour — made a
chronic 499 pattern and pre-existing restarts read as incident impact. A fixed
offset compares the same time of day.

The two are kept apart because one label cannot carry both. With a single
x0.5-x2 "similar" band, a halving came back "similar ... already happening then":
right about presence, wrong about level. Now it is `lower` and `already_present`
— not new, but not at the same level either.

- The window is shifted rather than the query rewritten with `offset`
  modifiers, so it is exact for every datasource and query shape.
- An offset shorter than the window is refused: an overlapping baseline drags
  every ratio towards `similar`.
- A baseline window with no data at all (outside retention, or before a
  deployment existed) is `no_baseline`, not `new` — for Loki this is checked
  against `/series`, so a genuine zero still reads as a zero.
- Two log results capped at `max_lines` are flagged: that compares two caps, not
  two volumes. Use `grafana_logs_trend` for volume.
- `grafana_logs_trend` puts a `baseline` count on every bucket;
  `grafana_http_requests` puts `baseline_count`, `ratio`, `change` and
  `baseline_p95_seconds` on every status row; `output="timeline"` adds
  `baseline_points` shifted onto the current timestamps.
- It doubles the queries a call runs. On CloudWatch that means two billable
  queries, and the result says so.

### Adaptive Logs sampling is reported, not assumed

Grafana Adaptive Logs discards lines before they reach Loki, and marks the
affected streams with an `__adaptive_logs_sampled__` label. That label was
already on every stream Loki returned; nothing read it, so a stream that was
dropping lines looked exactly like a complete one.

`adaptive_logs_sampling` is reported wherever it can be seen: from stream labels
on returned lines (`grafana_query`, `grafana_logs_context`, `grafana_logs_noise`),
from counts grouped by the label (`grafana_logs_trend`, `grafana_http_requests`),
and — where results cannot carry it — by a short spot check on the stream selector.
That last case matters most: an empty log result has no streams to carry the
label, and a request-id lookup that found nothing on a sampled stream was
reported as `EMPTY_BUT_SCANNED`, "a trustworthy negative". It is now
`EMPTY_BUT_SAMPLED`: the absence of one line is not proof it was never logged.
Counts from a sampled stream are lower bounds. Multi-line content suffers
worst: an exception header can survive while its stack frames are dropped, which
reads as a truncated log rather than as a retention rule someone can lift — a
per-cluster/job exemption can be requested from the Platform team.

### Which datasources `grafana_query` will touch

The read-only guarantee comes from the **query language**, not from token
permissions, so each datasource type is allowed individually:

| Allowed | Why |
| --- | --- |
| `prometheus`, `loki` | PromQL/LogQL have no write statements |
| `elasticsearch` | Grafana's backend only issues `_msearch` |
| `graphite`, `grafana-pyroscope-datasource`, `grafanacloud-cardinality-datasource` | read-only query paths |
| `cloudwatch` | **billable, metrics only** — Logs Insights refused; every result carries a `billing_notice` (see below) |

Deliberately blocked, because these can **act**, not just read:

| Blocked | Why |
| --- | --- |
| `alertmanager` | the Alertmanager API can create silences |
| `grafana-incident-datasource` | can create and modify incidents |
| `k6-datasource` | can trigger load test runs against real targets |
| `grafana-knowledgegraph-datasource` | unreviewed plugin surface |
| `tempo` | read-only, but unused here — unused surface is surface nobody verifies |

#### CloudWatch is metrics-only

CloudWatch is the one type where the datasource type alone is not a sufficient
guard. Metrics mode reads published metrics; **Logs Insights bills per GB
scanned**, an unbounded cost a single careless query can run up. The query
payload is therefore inspected, and anything that is not plainly a Metrics query
is refused *before the request is sent* — `queryMode: "Logs"`, `logGroups`,
`logGroupNames`, `queryLanguage`, or `subtype: "StartQuery"`.

This blocks the unbounded cost, not literally every cost: `GetMetricData` is
itself metered by AWS at a small per-request rate. There is no way to query
CloudWatch for free; the guard removes the failure mode that can produce a large
bill.

Because of that, **every** CloudWatch result carries a `billing_notice` alongside
`results` (on the raw response too), and each CloudWatch query emits a `warn`
log line. Results from other datasources carry no such notice — a warning
attached to free datasources would just train the reader to ignore it.

```jsonc
{
  "billing_notice": "BILLABLE: this query was run against CloudWatch, which AWS meters per request ...",
  "results": { "A": { ... } }
}
```

#### Drilldown links and multiple services

Verified against the live Logs Drilldown app, because both obvious approaches
fail silently:

- A `=~` regex alternation does **not** work. The app treats a filter value as a
  literal and regex-escapes it, so `a|b` reaches Loki as `service_name=~"a\|b"`
  and matches **nothing**.
- The app's own multi-value operator (`=|`) keeps only the **first two** values.
  Observed 1→1, 2→2, 3→2, 5→2, consistently and regardless of settle time.

So a link pins `service_name` only when exactly one service matched. With several
it is scoped to the namespace — broader, but never silently wrong — and the
response carries `scope: "namespace"` plus a `scope_note`. The exact set is always
available in `service_names` and in the `explore_url`, which honours the full
LogQL.

`expr` works **only** for Prometheus and Loki — Elasticsearch rejects it with
HTTP 400 (Tempo, when it was briefly enabled, rejected it with HTTP 500). Use
`query` for the others, e.g.

```jsonc
// Elasticsearch: count over time
{"query": "*", "timeField": "@timestamp",
 "metrics": [{"id": "1", "type": "count"}],
 "bucketAggs": [{"id": "2", "type": "date_histogram", "field": "@timestamp",
                 "settings": {"interval": "auto"}}]}

// Graphite
{"target": "some.metric"}
```

The datasource is always pinned from `datasource_uid` after `query` is merged, so
a caller cannot redirect a query to an unverified (or blocked) datasource.

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

Identify a customer/component with free text (`client='april'`,
`component='gateway'`); it matches case-insensitively against the `service_name`
label, which on this instance encodes both (e.g.
`graviteeio-ae-april-rec-engine`). Returns `{ query, link_style,
resolved_namespaces, links, range, matched_count, matched_streams }`, where
`matched_streams` is the list of `{ namespace, service_name }` label sets the
selector matched (discovered via Loki's `/series` — no log lines are fetched) and
`resolved_namespaces` is the customer's own namespace(s) the `client` resolved to
(empty when the customer only lives in a shared namespace — see the drilldown
section). The default range is the last hour; widen with `from`/`to`. When nothing
matches, it returns close `service_name` values as `suggestions` so typos like
`aprl → april` surface.

Two conditional fields also appear:

- `env_filter_dropped: true` — set when the query pinned the customer's namespace,
  the `client` asked for an env (e.g. `prod`), the first `/series` discovery
  returned nothing, and dropping the env token and retrying *did* find streams.
  Env tokens aren't reliably in `service_name` for every tenant (some name prod
  `plt-live`/`multitenant`), so this flags that the reported streams are the
  customer's namespace-wide results, not env-narrowed ones.
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

> **Multitenant note.** On the multitenant Cockpit instance the customer name is
> *not* in `service_name`/`namespace` (it uses a tenant id, e.g. `cp2222`), so a
> free-text `client` won't find those tenants. Resolving customer → tenant id is
> a planned improvement; for now pass the tenant's namespace/id you were given.

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

(The environment — `prod`, `rec`, `dev` — isn't a separate argument: it lives
inside `service_name`, so just fold it into `client` as another word. Words are
matched as case-insensitive substrings with `.*` between them, so `northwind
prod` matches `…-northwind-prod-…`. Known environment words (`prod`, `rec`,
`dev`, `nonprod`, `preprod`, `qa`, `int`, `ppr`, `sandbox`, …) are anchored to a
whole `service_name` segment, so `prod` matches `…-prod-…` but **not** the
`prod` inside `nonprod`/`preprod`. Non-env words stay plain substrings, so a
partial customer name like `arcelor` still matches `arcelor-mittal`.)

Each call returns `links` — shareable Grafana links (Logs Drilldown per namespace
by default; see `link_style` above) — plus `matched_streams`, the
`{ namespace, service_name }` label sets the selector matched. No log lines are
fetched; open a link to read the logs in Grafana.

## Setup

This service ships as part of `local-tooling`. It is **opt-in** and disabled by
default, so teams that don't use Grafana are unaffected.

To enable it, set the following in your `local-tooling` `.env` (which is
git-ignored — never hardcode the token):

```bash
GRAFANA_ENABLED=true
GRAFANA_BASE_URL=https://your-grafana-host   # e.g. https://gravitee.grafana.net
GRAFANA_TOKEN=...                            # service account token (see Auth above)
```

Then rerun `bin/local-tooling setup` with your usual `--agents` and `--repo`
values, and restart the agent. With `GRAFANA_ENABLED=true`, setup adds the
`grafana` MCP server to your agent config (`.mcp.json` / Codex) just like
`zendesk` / `vectordb` / `github`, with no manual wiring. It only needs HTTPS
egress to the Grafana instance.

`GRAFANA_LOGS_DATASOURCE_UID` is **required** — it has no default. A uid that is
correct for one Grafana org is a silent, plausible failure in every other one, so
the adapter refuses to guess: `doctor` reports it as a config error and the logs
tools fail with a clear message rather than returning an empty result.

Find it under Connections > Data sources > (Loki). **The uid is not always the
same as the display name.** On the Gravitee instance the datasource is displayed
as `grafanacloud-gravitee-logs` but its uid is `grafanacloud-logs`.

### Rotating the token (or any `GRAFANA_*` value)

`bin/local-tooling exec-mcp grafana` starts a fresh container for every MCP
connection (`docker compose run --rm -T grafana-mcp-adapter`), and compose fills
the service's `environment:` block from `.env` at that moment. So `.env` is
authoritative at **connect** time:

```bash
# edit .env, then reconnect the MCP client. Nothing to rebuild or recreate.
```

An **already-connected** MCP session keeps the values it started with, because
its container is still running. Reconnect that client to pick up a new token —
`doctor` reads `.env` and so describes what the *next* connection will use.

### The customer snapshot is never committed

`customers-snapshot.json` is a **local fallback cache** and is deliberately
gitignored. It is generated from `gravitee-io/cloud-deployments-configuration`,
which is **private**, and it contains the customer list with their control-plane
and data-plane ids. **This repository is public** — committing that file would
publish who Gravitee's customers are and how their infrastructure is addressed.

Generate it locally when you want an offline fallback:

```bash
cd services/grafana-mcp-adapter
GITHUB_PERSONAL_ACCESS_TOKEN=... npm run refresh-customers
```

Nothing breaks without it. The Dockerfile's `COPY customers-snapshot.jso[n]` is a
no-op when the file is absent, so a fresh clone builds; the adapter fetches the
map from GitHub at runtime and, if GitHub is unreachable AND no snapshot exists,
reports that Gravitee Cloud customers cannot be resolved rather than failing or
guessing. Hosted customers are unaffected either way — they resolve from Loki.

### Customer-map environment variables

The Gravitee Cloud customer map is fetched at runtime from a private GitHub repo.
These variables control where it comes from and how it is cached. Only the token
is required for a live fetch. Without it, the adapter falls back to the local
snapshot (if you generated one) or reports that Cloud customers cannot be
resolved. Hosted customers are not affected.

| Variable | Default | What it does |
|---|---|---|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | *(none)* | Auth for the GitHub fetch. Used at **runtime** every time the map loads, not only by `npm run refresh-customers`. |
| `GRAFANA_CUSTOMER_MAP_REPO` | `gravitee-io/cloud-deployments-configuration` | Repo holding the customer CSV. |
| `GRAFANA_CUSTOMER_MAP_PATH` | `docs/summary/customers_summary.csv` | Path to the CSV inside that repo. |
| `GRAFANA_CUSTOMER_MAP_REF` | `prod` | Branch or tag the CSV is read from. |
| `GRAFANA_CUSTOMER_MAP_TTL_SECONDS` | `3600` | How long a successful fetch stays cached in memory. |
| `GRAFANA_CUSTOMER_MAP_TIMEOUT_MS` | `5000` | Timeout for the GitHub fetch. |
| `GRAFANA_CUSTOMER_MAP_STALE_DAYS` | `30` | Age after which the map is reported as stale. |

> **Token type.** The token needs read access to
> `gravitee-io/cloud-deployments-configuration`. In our tests a classic token
> worked and a fine-grained one returned 404. We have not confirmed why. If you
> use a fine-grained token and get a 404, check that its resource owner is
> `gravitee-io` and that the org has approved it, or use a classic token instead.

### Why hosted customers are NOT in the bundled map

The map covers Gravitee Cloud (Cockpit) tenants only. Hosted/standalone customers
are resolved by matching Loki's `namespace` label, and that is deliberate — the
question was measured, not assumed.

`gravitee-techops-hosted-customers` lists 93 standalone customers as directory
names, but those directories are **not** namespaces, and the namespace string does
not appear in that repo at all (verified: GitHub code search finds
`adminPassword` 30 times and `arcelor-prod` zero times — namespaces are generated
at deploy time). Checked against a 30-day window of live namespaces:

| | |
| --- | --- |
| 71 of 93 | resolve today via the namespace matcher |
| 8 of 93 | directory name differs from the real namespace |
| 14 of 93 | no live namespace at all (dormant/decommissioned) |

The 8 are the reason not to bundle: `arcelor-mittal` -> `arcelor-prod`,
`falcon-air` -> `falcon-prod`, `nimbusco` -> `nimbus-prod`, `zenithfr` ->
`zenith-prod`, `blueyonder-apac` -> `blueyonder-plt-live`. Bundling the
directory names would add eight customer names that match no namespace, while the
existing matcher already resolves all eight from the name a human would type
(`arcelor`, `falcon`, `nimbus`). Loki is the authority for this population.

### `grafana_logs_patterns` has a volume floor

Loki's pattern detection only reports patterns above a volume threshold. Rare
lines are **absent entirely**, not ranked last. Measured on this instance over a
48h window: the smallest reported pattern was **34 lines**, while a 10-line
`DeserializationException` in the same window did not appear at all.

So an error missing from the pattern list is **not** evidence it did not happen.
Every response carries `smallest_pattern_count` and a `coverage_note` saying so.
To find or count a specific or rare error, use `grafana_logs_trend` (which counts
a `line_filter` over time) or `grafana_query`.

`lines_in_patterns` counts only the lines Loki assigned to some pattern — it is
not a total line count for the range.

## Testing

Tests use Node's built-in runner — no extra framework. Run them with:

```bash
npm test          # node --test
npm run check     # syntax-check the source files
```

Coverage:

- `helpers.test.js` — the pure helpers (`helpers.js`).
- `grafanaClient.test.js` — the HTTP client (`grafanaClient.js`): config
  validation, auth headers, param handling.
- `server.test.js` — the `server.js` orchestration that talks to Loki, with
  `fetch` stubbed per Loki endpoint: `grafana_logs_link`'s namespace resolution,
  per-namespace drilldown grouping, the `explore_url` fallback, the env
  auto-retry, and the empty-result `note`/`suggestions` branches, plus
  `grafana_query`'s digest-vs-`raw` output. `server.js` only starts the stdio
  transport when run as the entrypoint, so tests import it and invoke the
  registered tool handlers directly (via the exported `tools` map).
