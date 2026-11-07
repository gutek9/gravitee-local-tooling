# Repository instructions

These rules apply to all work in this repository. Read them before planning or
editing code. Apply the quality bar to new and changed code; existing oversized
files are a reason to extract the responsibility being changed, not a template
to copy or a mandate for an unrelated rewrite.

More specific instructions may add stricter requirements, but must not weaken
the RAG/MCP workflow below. Also read [security guidance](docs/security.md) and
the README/tests of each affected component.

## Evidence and tool workflow

- For every non-trivial task, call vectordb MCP `rag_prepare_task` **before
  analysis or edits**, with `hybrid=true` and `limit>=8` for broad work.
- Use `rag_search`, preferably hybrid, whenever context is incomplete, ambiguous,
  or needs narrowing. Retrieved chunks are orientation: verify material claims
  against current project files or authoritative live sources before acting.
  Cite retrieved knowledge as `[source:path]` when it materially supports a result.
- Ingest reusable, non-sensitive knowledge with `rag_ingest`, using a stable
  `source`, `path`, raw `text`, and structured `metadata`; verify with `rag_search`.
  Never ingest secrets, credentials, tokens, personal data, or sensitive material.
- Use `rag_health` after a failed or unexpectedly empty RAG operation, or when
  availability is uncertain. If a required RAG tool is unavailable or unhealthy,
  continue only with directly verified sources when safe and report the missing
  step. Do not silently skip this workflow.
- Before the first browser action, website fetch, or web search for each target
  service, inspect the MCP tools actually available in the session, including
  discoverable app/plugin tools. Repeat when the service changes. Use a suitable
  connector or documentation MCP first. Browser/web is a fallback when the tool
  lacks the operation or fails; explain the fallback when relevant. If the user
  explicitly requests a browser, check MCP first, then use the requested interface.
  Do not install a plugin/server or connect an account just to satisfy this check.
- Search the code with `rg`; inspect callers, tests, and service documentation.
  Check `git status` first and preserve unrelated user changes.

## Design the change before growing the code

- State the observable outcome, scope, compatibility constraints, and failure
  cases. Identify the modules that own the work and how the result will be tested.
  Keep this brief for small changes; no design document or approval ceremony is
  required for routine implementation decisions.
- Make each PR deliver one coherent capability or fix, including its tests and
  documentation. Split independently useful features and unrelated refactoring.
  For broad requested work, use independently reviewable commits/PRs with an
  explicit dependency order while retaining the full requested scope.
- Separate mechanical moves from behavior changes so reviewers can verify each.
  Preserve intended behavior during extraction; fix known scope/safety defects
  explicitly with regression coverage instead of carrying them into new modules.
- Prefer the smallest complete solution. Reuse established boundaries and
  dependencies. Introduce abstractions for concrete responsibilities or repeated
  behavior, not hypothetical future consumers. Do not build a framework to split
  a function, or create one-line forwarding modules just to reduce file sizes.

## Module boundaries and maintainability

| Area | Responsibility |
| --- | --- |
| `bin/local-tooling` | CLI parsing and orchestration; delegate domain behavior to `local_tooling/`. |
| `local_tooling/` | Focused Python modules for configuration, manifests, workflow, and runtime operations. |
| `services/*/server.js` | MCP schema/registration, validation, service calls, and response adaptation. |
| Adapter service modules | Domain decisions and workflows; independent of MCP transport. |
| Adapter HTTP clients | Authentication, request policy, timeouts, and external API calls. |
| `services/vectordb/` | Ingestion/retrieval API; keep embedding providers, retrieval, and persistence concerns distinct as they grow. |

- Give each module one cohesive responsibility and a descriptive domain name.
  Parsing, remote loading/caching, matching, query construction, analysis, and
  link formatting should not accumulate in one handler or catch-all module.
- Keep transport handlers thin: validate input, call the owning service, adapt
  output. A handler that also parses CSV, loads GitHub data, resolves customers,
  builds LogQL, aggregates results, and constructs URLs must be decomposed before
  delivery. Moving that whole handler into one `*Service` file is insufficient.
- Keep domain logic testable without network access or an MCP server. Pass data
  into pure transformations; isolate I/O in clients/loaders. Inject clients or
  clocks where that makes meaningful behavior deterministic in tests.
- Dependencies should flow from entrypoints to services to focused domain
  modules/clients. Lower-level modules must not import entrypoints; avoid cycles
  and hidden initialization effects. Start transports only from entrypoints.
- Review cohesion before adding to `helpers.js`, `utils`, or a large `server.js`.
  Extract the domain responsibility being extended when the file mixes concerns.
  Several hundred lines, long parameter lists, or unrelated sections are review
  signals, not universal numeric limits. Judge by reasons to change and whether
  a reviewer can understand a responsibility without reading the entire service.
- Use clear names and explicit inputs/outputs; avoid boolean mode combinations
  with surprising behavior. Comments explain invariants, API quirks, and tradeoffs,
  rather than narrating statements or embedding investigation transcripts.
- Keep one implementation for the same contract, such as URL encoding, selector
  escaping, or time conversion. Expose explicit options for genuine variants.
  Similar-looking code with different semantics need not share an abstraction.

## Correctness, customer scope, and honest results

- Preserve explicit restrictions throughout the pipeline. Customer, environment,
  region, control-plane, namespace, and cluster filters must only narrow scope.
  An unknown or ambiguous restriction must not silently become an unfiltered
  query. Refuse with useful valid choices before issuing the broader data query.
- Resolve customer ownership before querying a shared cluster or control plane.
  An explicit cluster does not establish customer ownership. Never present shared
  tenant data as one customer's results; broader queries require explicit intent.
- Distinguish no matches, failed lookup, unavailable source, stale fallback,
  partial coverage, sampling, and truncation in the returned data. Do not turn a
  failed lookup into an empty success or discard a warning because another route
  produced some results. Keep source age separate from local refresh time.
- Account for server-side pagination and caps, including results exactly at the
  requested limit. Report what was actually scanned/returned; a truncated page
  is not a complete time window. Counts and samples must describe their real scope.
- Keep stable identity when grouping/comparing series: labels alone may not
  distinguish numeric fields. Make time zones, units, window boundaries, missing
  baselines, and empty values explicit. Validate inputs at their owning boundary.
- Escape values for their actual destination (LogQL, regex, URL, SQL, or shell);
  use parameterized SQL and structured subprocess arguments. String concatenation
  must not let user values alter query structure or execution scope.
- Catch errors where a deliberate recovery policy exists. Preserve actionable
  context without leaking sensitive payloads. Bound timeouts, concurrency, retries,
  and output sizes. Retry only appropriate transient/idempotent operations.

## Configuration, integrations, and reproducible builds

- External integrations are read-only by default. Enforce allowed operations at
  the HTTP client boundary and test actual requests; tool names, comments, and
  source-text scans are not runtime enforcement. Read-only POST query endpoints
  require explicit method/path allowances. Write capabilities remain opt-in.
- Keep optional services disabled by default and usable without their credentials
  when disabled. Default services must not depend on an inactive Compose profile.
- For each configuration addition/change, reconcile `.env.example`, environment
  loading/validation, Compose forwarding, runtime consumers, and documentation.
  Verify non-default overrides reach the process that uses them; a documented
  variable is not implemented merely because code reads `process.env`.
- Validate required settings clearly; avoid instance-specific defaults that can
  produce plausible empty results elsewhere. Document restart/rebuild, migration,
  and re-indexing steps when required, including sources a bootstrap does not cover.
- Pin new container/runtime dependencies to tested versions or digests; avoid
  `latest` and unversioned runtime downloads. Preserve lockfiles and use `npm ci`
  for installs/builds backed by a lockfile. Keep dependency upgrades scoped.
- This repository is public. Never commit tokens, real customer maps/snapshots,
  ticket bodies, private hostnames, or telemetry. Use synthetic fixtures. Check
  gitignore and Docker build context when introducing local caches or artifacts.
  Do not print credentials or embed them in generated agent configuration.
- Local changes do not authorize posting comments, merging PRs, publishing data,
  or modifying live services. Follow the user's explicit scope for external writes.

## Tests and verification

- Test observable behavior and invariants at the boundary that owns them. Add a
  regression test that reproduces a fixed defect; for existing behavior, explain
  why current coverage suffices. Avoid tests that mirror implementation or only
  search source for function names. Text assertions are appropriate when the text
  itself is the contract, such as a generated configuration file.
- Use Node's built-in test runner and Python `unittest` unless a concrete need
  justifies another dependency. Keep module tests alongside their JS modules and
  Python tests under `tests/`. Test service logic without booting an MCP transport.
- Stub external I/O with synthetic data. Cover both domain decisions and their
  orchestration: a refused resolution must also prevent the broad outbound query.
  Restore environment/global stubs and isolate caches between tests. Default unit
  tests must not depend on real credentials, snapshots, the network, or Docker.
- For affected behavior, cover ambiguity/unknown restrictions, missing config,
  failed/empty upstreams, stale fallback, partial results, exact-limit responses,
  and shared-tenant scope. Choose applicable cases, not a ceremonial test matrix.
- Run the relevant checks from the repo root:

  ```bash
  python3 -m unittest discover -s tests
  npm --prefix services/grafana-mcp-adapter test
  npm --prefix services/grafana-mcp-adapter run check
  npm --prefix services/zendesk-mcp-adapter test
  npm --prefix services/zendesk-mcp-adapter run check
  ```

  Run suites for changed components and consumers, not every unrelated service.
  Syntax-check each changed JS file not covered by the component's check script.
  For Compose/build changes, render affected enabled/disabled configurations and
  verify the affected image builds without private files. Use isolated test
  configuration; do not restart a developer's running stack for routine checks.
  Docs-only changes need link/content and diff checks, not new executable tests.

## Before delivery

- Inspect the complete diff for unrelated edits, accidental data, duplicated logic,
  mixed responsibilities, and unnecessary size. Resolve these before review rather
  than leaving the decomposition as follow-up work.
- Recheck the original outcome, failure paths, compatibility, and documentation.
  Green tests are evidence, not a substitute for reviewing the final behavior.
- Run `git diff --check` and `./bin/local-tooling review-change --repo "$PWD"`.
  The latter is a receipt/file-change check, not code review or proof of test
  coverage; it can warn about missing CLI receipts even after MCP retrieval.
- In a PR description or final handoff, state the concrete problem, resulting
  behavior, relevant checks and outcomes, and material remaining limitations.
  Explain significant tradeoffs. Do not claim tests, builds, live validation, or
  fixes that were not performed, and do not bury known defects behind a test count.
