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
> *not* in `service_name`/`namespace` (it uses a tenant id, e.g. `ba813`), so a
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
| `GRAFANA_CUSTOMER_MAP_SNAPSHOT_PATH` | `customers-snapshot.json` next to `server.js` | Where the fallback snapshot is read from. The tests point it at a file of their own. |

> **Token type.** The token needs read access to
> `gravitee-io/cloud-deployments-configuration`. In our tests a classic token
> worked and a fine-grained one returned 404. We have not confirmed why. If you
> use a fine-grained token and get a 404, check that its resource owner is
> `gravitee-io` and that the org has approved it, or use a classic token instead.

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
- `lokiDiscovery.test.js` / `logsLinks.test.js` — the Loki reads behind
  `grafana_logs_link` (`fetch` stubbed) and the links it builds from the matched
  streams.
- `customerCsv.test.js` / `customerMatch.test.js` — the Gravitee Cloud customer
  map: CSV parsing, name and id lookup, and resolving a customer to namespaces,
  on made-up rows with the real CSV header. No network.
- `customerMapLoader.test.js` — where the map comes from: GitHub, the snapshot
  fallback, the unavailable case, caching. GitHub is stubbed and the snapshot is
  a temp file, never a real one.
- `server.test.js` — the `server.js` orchestration that talks to Loki, with
  `fetch` stubbed per Loki endpoint: `grafana_logs_link`'s namespace resolution,
  per-namespace drilldown grouping, the `explore_url` fallback, the env
  auto-retry, and the empty-result `note`/`suggestions` branches, plus
  `grafana_query`'s digest-vs-`raw` output. `server.js` only starts the stdio
  transport when run as the entrypoint, so tests import it and invoke the
  registered tool handlers directly (via the exported `tools` map).
