# Code-mode MCP bridge

`/mnt/mcp_servers` implements Anthropic's **code execution with MCP** pattern:
the model writes Python instead of loading 100+ JSON tool schemas into its
context. Large intermediate data (accessibility trees, diffs, API payloads) is
filtered here, inside the sandbox, before anything reaches the model.

```
/mnt/mcp_servers
├── client.py               async MCP stdio session + persistent Unix-socket daemon
├── code_mode.py            tools/list -> typed wrappers + index.json
├── bootstrap_code_mode.py  idempotent startup (daemons, wrappers, index)
├── index.json              generated catalogue (servers, tools, modules)
├── playwright/             browser wrappers with in-sandbox DOM filtering
├── github/                 gh CLI + REST wrappers (writes need a broker token)
├── filesystem/             workspace-confined file I/O
└── skills/                 agent-writable verified workflows (snapshot me)
```

## Why a daemon

An MCP server launched per `sb.exec` loses browser state and pays a cold start
every call. `client.py serve` keeps one MCP server subprocess alive behind a
Unix socket at `/tmp/oh-mcp/<server>.sock`, so:

* the Chromium instance and its cookies survive across exec calls;
* the agent pays one launch cost per sandbox, not per call;
* tool calls are ~1 ms of socket overhead instead of a process spawn.

`ensure_daemon()` starts it on first use with `start_new_session=True`, so it
outlives the exec that created it.

## Usage

```python
from playwright import navigate, snapshot_dom, click, type_text, run_axe_audit
from github import get_pr_diff, list_prs
from filesystem import write_text, glob
from skills import save, list_skills, run

page = navigate("https://example.com")
print(page["title"], page["count"], page["truncated"])

snap = snapshot_dom(max_nodes=40)
click(snap["nodes"][0]["ref"])
```

## Design rules

1. **Never return a raw MCP payload to the model.** Every wrapper clips text and
   prunes structures first.
2. **No long-lived secrets in the sandbox.** `github/` reads public repos
   unauthenticated and fails closed on writes. Phase 3 adds a host-side broker
   that mints short-lived, repo-scoped tokens.
3. **The filesystem boundary is enforced in code**, not by convention:
   `filesystem.resolve()` rejects `..` escapes and out-of-root symlinks.
4. **Generated wrappers are disposable.** Delete and regenerate with
   `python code_mode.py build --server playwright`.

## Adding a server

Register a `ServerSpec` in `client.default_specs()` (or pass `--spec` JSON to
`client.py serve`), then:

```bash
python bootstrap_code_mode.py --server <name>
```

That starts the daemon, writes `_generated_<name>.py`, and refreshes
`index.json`.

## Operational notes

* Daemon logs: `/tmp/oh-mcp/<server>.log`
* Stop everything: `python client.py stop --name playwright`
* Health: `python client.py status --name playwright`
* `@modelcontextprotocol/server-github` is **not** used: it is deprecated and
  archived. GitHub access goes through `gh`/`git` plus REST.
* `@modelcontextprotocol/server-filesystem` is optional and only registered when
  the binary is present; `filesystem/` does not depend on it.
