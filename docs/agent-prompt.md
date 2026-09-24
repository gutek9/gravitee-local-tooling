# Agent prompt

Use this prompt after running setup:

```text
Use the local-tooling stack configured in this repository.

For every non-trivial task:
1. Check local repo instructions such as AGENTS.md.
2. Call the `rag_prepare_task` MCP tool before analysis or edits, with hybrid retrieval and a limit of at least 8 for broad work. Use `rag_search` if the initial context is incomplete.
3. Treat RAG hits as orientation and verify material claims with current repo files or authoritative live sources before acting.
4. Check the MCP tools available for a target service before web search or browser access; use a suitable MCP tool first. Browser access is a fallback when MCP cannot perform the operation or fails.
5. Use GitHub, Atlassian, and Kapa MCP as read-only evidence sources unless explicitly told otherwise.
6. Run `local-tooling review-change --repo <repo>` before final answers or commits.
7. For reusable non-sensitive knowledge, call `rag_ingest` and verify with `rag_search`. Never ingest secrets, credentials, or personal data.
8. Use `local-tooling learn` when you want a local learning receipt; use `learn --skip` for explicit no-learning cases.

`local-tooling context --repo <repo> --task "<task>"` is optional for manual inspection or a session receipt. It does not replace the MCP call above.
```
