---
name: knowledge-base-generator
description: Detects when an agent is stuck in a loop hitting the same error or issue repeatedly, then searches the internet (via search-capable MCPs) for matching GitHub issues and known workarounds. Automatically creates or updates an AGENTS.md knowledge base with links and solutions. Triggers on repeated failures, "Same issue" appearing twice, agent looping on the same error, recurring error messages, "still failing", "same error again", "stuck on the same problem".
---

# Knowledge Base Generator

Detect when an agent is looping on the same issue and break the cycle by searching for known solutions online, then persisting findings in a project-level knowledge base (`AGENTS.md`).

## Trigger Condition

Activate this skill when **the same issue appears more than twice** during a session. Indicators include:

- The agent (or user) says "Same issue", "same error", "still failing", or equivalent **two or more times** for the same root cause.
- The agent applies a fix and the identical (or substantially identical) error message reappears.
- A tool or build command produces the same failure output across three or more consecutive attempts.

> **Rule of thumb:** if you have seen the same error message (or a close paraphrase) three times total, stop retrying and invoke this skill immediately.

## Prerequisites

### Search-capable MCPs

This skill relies on MCP tools that can search the web or GitHub. Check for available search tools:

1. **GitHub MCP tools** (preferred) — look for tools matching `mcp_io_github_git_search_issues` or `mcp_io_github_git_search_code`.
2. **Web search MCP tools** — look for tools matching patterns like `search`, `web`, `fetch`, or `browse`.

If **no search-capable MCP is available**, inform the user:

> I'm stuck on a recurring issue and need to search for known solutions, but no
> search-capable MCP server is configured. To enable internet search, install one
> of the following:
>
> - **GitHub MCP server** — provides `search_issues` and `search_code` tools.
>   See: https://github.com/github/github-mcp-server
> - **Playwright / Browser MCP** — enables web browsing and search.
>   See: https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-server-playwright
> - **Fetch MCP** — allows fetching arbitrary URLs.
>   See: https://github.com/modelcontextprotocol/servers/tree/main/src/fetch
>
> Install one of these, then retry.

## Workflow

### Step 1: Identify the recurring issue

1. Capture the **exact error message** or failure output that keeps repeating.
2. Extract the most specific, searchable fragment — strip file paths, timestamps, and variable data to get the stable core of the message.
3. Note the **technology/framework** involved (e.g., `webpack`, `pytest`, `php`, `docker`).
4. Formulate a concise summary:
   - **Error:** `<stable error fragment>`
   - **Context:** `<language/framework/tool>`

### Step 2: Search for existing solutions

#### Option A — GitHub Issues (preferred)

Use the GitHub MCP search tools to look for matching issues:

```
Search query: "<stable error fragment>" — scoped to relevant repos if known.
```

Concrete steps:

1. Use `tool_search_tool_regex` with pattern `search_issues|search_code` to discover available GitHub search tools.
2. Call the discovered tool, e.g. `mcp_io_github_git_search_issues`, with:
   - `q`: the stable error fragment, optionally combined with the framework name.
   - Inspect the top 5–10 results for workarounds, fixes, or confirmations of known bugs.
3. For each promising issue:
   - Record the **issue URL**, **title**, and the **suggested workaround** (quote the relevant comment).

#### Option B — Web search (fallback)

If no GitHub-specific tools are available but a general web/fetch MCP exists:

1. Construct a search URL: `https://www.google.com/search?q=<URL-encoded error fragment>+site:github.com`
2. Fetch or browse that URL using the available MCP tool.
3. Extract relevant issue links and workaround descriptions from the results.

#### Option C — No MCP available

If neither GitHub nor web search MCPs are available:

1. Print the prerequisite message from the section above.
2. Suggest the user manually search for the error and provide links.
3. Still proceed to **Step 3** — create the `AGENTS.md` entry with what is known so far, marking the workaround as `TODO: search for "<error fragment>" on GitHub`.

### Step 3: Create or update the Knowledge Base (`AGENTS.md`)

The knowledge base lives at the **project root** as `AGENTS.md`.

#### If `AGENTS.md` does not exist

Create it with this structure:

```markdown
# AGENTS.md

Project-level guidance and known issues for AI agents working on this codebase.

## Knowledge Base

### <Short title describing the issue>

- **Error:** `<exact or representative error message>`
- **Context:** <when/where this occurs>
- **Root cause:** <brief explanation if known>
- **Workaround:**
  <steps or code to resolve the issue>
- **Source:** [<issue title or description>](<URL>)
- **Date found:** <YYYY-MM-DD>
```

#### If `AGENTS.md` already exists

1. Read the file and check if the **Knowledge Base** section already has an entry for this error (fuzzy match on the error message).
   - **If a matching entry exists:** update it with any new information (additional workaround, newer source link, updated date).
   - **If no match:** append a new entry under the `## Knowledge Base` heading using the template above.
2. If the file exists but has no `## Knowledge Base` section, append the section at the end of the file.

### Step 4: Apply the workaround

1. If a clear workaround was found, apply it to the codebase.
2. Re-run the failing command to verify the fix.
3. If the issue persists, update the `AGENTS.md` entry to note that the workaround did not resolve the problem and continue searching or escalate to the user.

### Step 5: Report to the user

Summarize what was done:

1. **Issue detected:** describe the recurring error.
2. **Search performed:** list queries and sources checked.
3. **Resolution:** what was applied (or that no fix was found).
4. **Knowledge base updated:** confirm the `AGENTS.md` entry was created/updated with a link to the relevant section.

## Example `AGENTS.md` entry

```markdown
### Docker Compose build fails with "no matching manifest for linux/arm64"

- **Error:** `no matching manifest for linux/arm64/v8 in the manifest list entries`
- **Context:** Running `docker compose build` on Apple Silicon (M1/M2) Macs.
- **Root cause:** The base image does not publish an ARM64 variant.
- **Workaround:**
  Add `platform: linux/amd64` to the service in `docker-compose.yml`, or set
  `DOCKER_DEFAULT_PLATFORM=linux/amd64` before building.
- **Source:** [moby/moby#42due](https://github.com/moby/moby/issues/42due)
- **Date found:** 2026-02-19
```

## Tips

- Keep error fragments **concise but unique** — overly generic strings like `"error"` or `"failed"` produce noisy results.
- Prefer GitHub issues from the **upstream repository** of the tool/library in question.
- When multiple workarounds exist, list them in order of preference (least invasive first).
- Periodically review `AGENTS.md` entries and remove those that have been properly fixed upstream.
