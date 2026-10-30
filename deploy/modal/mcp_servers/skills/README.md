# Skills

Agent-writable directory for **verified** multi-step workflows. A skill is a
plain Python module with a docstring (its description) and an optional
`run(**kwargs)` entry point.

Rules:

1. Only save a skill after the workflow actually succeeded in this session.
2. Keep it small and parameterised; no hard-coded credentials.
3. Re-verify before reuse — these files are agent-written code.

```python
from skills import save, list_skills, run

save(
    "example_title",
    """
from playwright import navigate

def run():
    page = navigate("https://example.com")
    return page["title"]
""",
    description="Return the title of example.com",
)

print(list_skills())
print(run("example_title"))
```

Persist across sessions with `sb.snapshot_directory("/mnt/mcp_servers/skills")`
or a Modal Volume mounted at this path.
