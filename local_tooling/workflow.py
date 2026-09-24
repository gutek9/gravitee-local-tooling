from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
from pathlib import Path

from .env import api_url
from .files import atomic_write
from .http import json_post

SESSION_ROOT_NAME = ".local-tooling"
DEFAULT_CONTEXT_LIMIT = 8


def slugify(value: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.lower()).strip("-")
    if not slug:
        slug = "task"
    return slug[:max_len].strip("-") or "task"


def repo_sessions_dir(repo: Path) -> Path:
    return repo / SESSION_ROOT_NAME / "sessions"


def latest_session_file(repo: Path) -> Path:
    return repo / SESSION_ROOT_NAME / "latest-session"


def session_dir(repo: Path, session_id: str) -> Path:
    return repo_sessions_dir(repo) / session_id


def write_latest_session(repo: Path, session_id: str) -> None:
    atomic_write(latest_session_file(repo), session_id + "\n")


def resolve_session_id(repo: Path, requested: str | None = None) -> str | None:
    if requested:
        return requested
    latest = latest_session_file(repo)
    if latest.exists():
        value = latest.read_text(encoding="utf-8").strip()
        return value or None
    sessions = repo_sessions_dir(repo)
    if not sessions.exists():
        return None
    candidates = sorted([path.name for path in sessions.iterdir() if path.is_dir()])
    return candidates[-1] if candidates else None


def new_session_id(task: str) -> str:
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    digest = hashlib.sha1(task.encode("utf-8")).hexdigest()[:8]
    return f"{timestamp}-{slugify(task)}-{digest}"


def git_output(repo: Path, args: list[str], check: bool = False) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        check=False,
        text=True,
    )
    if check and result.returncode != 0:
        raise SystemExit((result.stderr or result.stdout or "git command failed").strip())
    return result.stdout.strip()


def git_head(repo: Path) -> str:
    head = git_output(repo, ["rev-parse", "HEAD"])
    return head or "unknown"


def changed_files(repo: Path) -> list[str]:
    output = git_output(repo, ["status", "--porcelain=v1", "-uall"])
    files: set[str] = set()
    for line in output.splitlines():
        if len(line) < 4:
            continue
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        if path:
            files.add(path)
    return sorted(files)


def is_test_file(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return (
        "/src/test/" in f"/{normalized}"
        or normalized.endswith(".spec.ts")
        or "/tests/" in f"/{normalized}"
        or normalized.startswith("test/")
        or normalized.startswith("tests/")
    )


def is_production_file(path: str) -> bool:
    normalized = path.replace("\\", "/")
    if is_test_file(normalized):
        return False
    if normalized.endswith((".md", ".adoc", ".txt")):
        return False
    if "/src/main/" in f"/{normalized}" and normalized.endswith((".java", ".kt", ".groovy")):
        return True
    if "/src/" in f"/{normalized}" and normalized.endswith((".ts", ".html", ".scss", ".css")):
        return True
    return False


def production_files(paths: list[str]) -> list[str]:
    return [path for path in paths if is_production_file(path)]


def test_files(paths: list[str]) -> list[str]:
    return [path for path in paths if is_test_file(path)]


def ensure_local_tooling_ignored(repo: Path) -> None:
    exclude = repo / ".git" / "info" / "exclude"
    if not exclude.exists():
        return
    text = exclude.read_text(encoding="utf-8")
    entries = [SESSION_ROOT_NAME + "/", SESSION_ROOT_NAME]
    if any(entry in text.splitlines() for entry in entries):
        return
    suffix = "" if text.endswith("\n") or not text else "\n"
    atomic_write(exclude, text + suffix + f"{SESSION_ROOT_NAME}/\n")


def context_queries(task: str) -> list[str]:
    compact = " ".join(task.split())
    queries = [compact]
    words = compact.split()
    if len(words) > 8:
        queries.append(" ".join(words[:24]))
    if re.search(r"\b[A-Z]+-\d+\b", compact):
        queries.append(re.sub(r"\b[A-Z]+-\d+\b", "", compact).strip() or compact)
    result: list[str] = []
    seen: set[str] = set()
    for query in queries:
        if query and query not in seen:
            result.append(query)
            seen.add(query)
    return result


def prepare_context(repo: Path, task: str, env: dict[str, str], *, limit: int = DEFAULT_CONTEXT_LIMIT) -> Path:
    repo = repo.expanduser().resolve()
    if not repo.is_dir():
        raise SystemExit(f"Repo path is not a directory: {repo}")
    if not task.strip():
        raise SystemExit("Task must not be empty")
    ensure_local_tooling_ignored(repo)

    session_id = new_session_id(task)
    target_dir = session_dir(repo, session_id)
    target_dir.mkdir(parents=True, exist_ok=True)

    queries = context_queries(task)
    searches = []
    for query in queries:
        response = json_post(
            api_url(env),
            "/search",
            {"query": query, "limit": limit, "hybrid": True},
            timeout=60,
        )
        searches.append({"query": query, "response": response})

    payload = {
        "session_id": session_id,
        "repo": repo.as_posix(),
        "repo_name": repo.name,
        "git_head": git_head(repo),
        "task": task,
        "queries": queries,
        "searches": searches,
        "created_at_unix": int(time.time()),
        "note": "RAG context is orientation only. Verify all useful hits in real repo files before editing.",
    }
    atomic_write(target_dir / "task.md", task.strip() + "\n")
    atomic_write(target_dir / "context.json", json.dumps(payload, indent=2) + "\n")
    write_latest_session(repo, session_id)

    print(f"Session: {session_id}")
    print(f"Context receipt: {target_dir / 'context.json'}")
    for search in searches:
        response = search["response"]
        count = response.get("count", 0) if isinstance(response, dict) else 0
        print(f"Query: {search['query']} ({count} results)")
        if isinstance(response, dict):
            for item in response.get("results", [])[:3]:
                if isinstance(item, dict):
                    print(f"- {item.get('source')}:{item.get('path')} score={item.get('score')}")
    return target_dir


def learning_template(task: str = "") -> str:
    return f"""# Learning

## Problem
{task.strip()}

## Root cause / useful pattern

## Fix / answer

## Files / concepts

## Tests

## When to reuse
"""


def learn(
    repo: Path,
    env: dict[str, str],
    *,
    task: str,
    session_id: str | None,
    summary: str,
    summary_file: str | None,
    skip: str | None,
) -> Path:
    repo = repo.expanduser().resolve()
    if not repo.is_dir():
        raise SystemExit(f"Repo path is not a directory: {repo}")
    ensure_local_tooling_ignored(repo)

    resolved_session = resolve_session_id(repo, session_id)
    if not resolved_session:
        resolved_session = new_session_id(task or "learning")
        write_latest_session(repo, resolved_session)
    target_dir = session_dir(repo, resolved_session)
    target_dir.mkdir(parents=True, exist_ok=True)

    files = changed_files(repo)
    metadata = {
        "kind": "learning",
        "repo": repo.name,
        "repo_path": repo.as_posix(),
        "session_id": resolved_session,
        "task": task,
        "git_head": git_head(repo),
        "files_changed": files,
        "created_by": "local-tooling",
        "created_at_unix": int(time.time()),
    }

    if skip:
        payload = {**metadata, "skip_reason": skip}
        path = target_dir / "learning-skip.json"
        atomic_write(path, json.dumps(payload, indent=2) + "\n")
        print(f"Learning skipped: {path}")
        return path

    text = ""
    if summary_file:
        text = Path(summary_file).expanduser().read_text(encoding="utf-8").strip()
    elif summary:
        text = summary.strip()
    if not text:
        text = learning_template(task)
        path = target_dir / "learning.md"
        atomic_write(path, text)
        raise SystemExit(f"Learning summary is empty. Fill the template at {path} and rerun learn --summary-file {path}")

    path = target_dir / "learning.md"
    atomic_write(path, text.strip() + "\n")
    ingest_payload = {
        "source": f"learned/{repo.name}",
        "path": f"{resolved_session}/learning.md",
        "text": text,
        "metadata": metadata,
        "chunk_size": 1200,
        "chunk_overlap": 200,
    }
    response = json_post(api_url(env), "/ingest", ingest_payload, timeout=60)
    receipt = {
        **metadata,
        "source": ingest_payload["source"],
        "path": ingest_payload["path"],
        "ingest_response": response,
    }
    atomic_write(target_dir / "learning.json", json.dumps(receipt, indent=2) + "\n")
    print(f"Learning ingested: {target_dir / 'learning.json'}")
    return target_dir / "learning.json"


def review_change(repo: Path, *, session_id: str | None, strict: bool) -> int:
    repo = repo.expanduser().resolve()
    if not repo.is_dir():
        raise SystemExit(f"Repo path is not a directory: {repo}")
    ensure_local_tooling_ignored(repo)

    resolved_session = resolve_session_id(repo, session_id)
    target_dir = session_dir(repo, resolved_session) if resolved_session else None
    context_present = bool(target_dir and (target_dir / "context.json").exists())
    learning_present = bool(
        target_dir and ((target_dir / "learning.json").exists() or (target_dir / "learning-skip.json").exists())
    )

    files = changed_files(repo)
    prod = production_files(files)
    tests = test_files(files)
    warnings: list[str] = []
    if prod and not context_present:
        warnings.append("production changes detected without a context receipt")
    if prod and not tests:
        warnings.append("production changes detected without test changes")
    if prod and not learning_present:
        warnings.append("learning is recommended for production changes; run learn or learn --skip")

    result = {
        "repo": repo.as_posix(),
        "session_id": resolved_session,
        "git_head": git_head(repo),
        "changed_files": files,
        "production_files": prod,
        "test_files": tests,
        "context_present": context_present,
        "learning_present": learning_present,
        "warnings": warnings,
        "mode": "strict" if strict else "warn",
        "status": "fail" if strict and warnings else ("warn" if warnings else "ok"),
        "created_at_unix": int(time.time()),
    }

    if target_dir:
        target_dir.mkdir(parents=True, exist_ok=True)
        atomic_write(target_dir / "review.json", json.dumps(result, indent=2) + "\n")

    print(json.dumps(result, indent=2))
    if strict and warnings:
        return 1
    return 0


def install_agent_rules(repo: Path, agents: list[str]) -> None:
    repo = repo.expanduser().resolve()
    if not repo.is_dir():
        raise SystemExit(f"Repo path is not a directory: {repo}")

    text = """# local-tooling workflow

Use local-tooling as a workflow assistant, not as the only source of truth.

- For every non-trivial task, call the `rag_prepare_task` MCP tool before analysis or edits (hybrid=true; limit at least 8 for broad work). Use `rag_search` when more context is needed.
- `local-tooling context --repo <this repo> --task "<task>"` is optional for manual inspection or a session receipt; it does not replace the MCP call.
- Treat RAG results as orientation only; verify useful hits in current repo files before editing.
- Before browser access or web search for a target service, check available MCP tools and use a suitable one first. Use the browser only if MCP cannot perform the operation or fails.
- Before final answers or commits, run `local-tooling review-change --repo <this repo>`. It may warn about missing CLI receipts even when MCP was used.
- If the task produced reusable non-sensitive knowledge, call `rag_ingest` and verify retrieval with `rag_search`. Never ingest secrets, credentials, or personal data.
- `local-tooling learn --repo <this repo> --task "<task>" --summary-file <file>` is optional for a local learning receipt; use `--skip "<reason>"` to record no reusable learning.
- For production changes, add focused tests or explain why existing coverage is sufficient.
"""
    written: list[Path] = []
    if "cursor" in agents:
        path = repo / ".cursor" / "rules" / "local-tooling.mdc"
        atomic_write(path, text)
        written.append(path)
    if "codex" in agents:
        path = repo / "LOCAL_TOOLING.md"
        atomic_write(path, text)
        written.append(path)
    if "claude" in agents:
        path = repo / "LOCAL_TOOLING.md"
        if not path.exists():
            atomic_write(path, text)
        written.append(path)
    for path in written:
        print(f"Installed agent rule: {path}")
