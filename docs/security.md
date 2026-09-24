# Security

`local-tooling` defaults to read-only integrations.

## Defaults

- GitHub MCP runs with `stdio --read-only`.
- Generated agent configs disable GitHub write tools.
- Generated agent configs disable Jira mutation tools.
- Zendesk is disabled by default and, when enabled, exposes only read-only tools plus local vectordb ingestion.
- Grafana is disabled by default and, when enabled, exposes read-only datasource queries and log links.
- Secrets are read from `.env` by `bin/local-tooling`; generated agent configs do not embed tokens.

## Token guidance

- Use least-privilege tokens.
- Prefer read-only scopes where supported.
- Do not commit `.env`.
- Rotate tokens if you paste logs or config into shared channels.
- Zendesk ticket content may contain customer data; only index queries that are appropriate for your team and machine.
- Use a read-only Grafana service account token. Datasource queries may return sensitive telemetry, so share query results and log links only with authorized recipients.

## Write tools

Write-capable MCP tools should be opt-in and reviewed per developer. Do not enable them globally in shared templates.
