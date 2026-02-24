# YOLO Agent

A VS Code coding agent powered by multiple AI providers. YOLO Agent gives you an interactive chat interface with tool-calling capabilities — file editing, terminal execution, diagnostics, sandboxed environments, MCP server integration, and more — all from the VS Code sidebar.

>Hey! It's a human over here. So... I just wanted to chime in and let you know that this is just an experiment I'm trying to build in my free time. It's not polished, it might be buggy, and it may even break your code or mess with your files. Please use it with caution, and maybe even on a test project first. I don't want to be responsible for any lost work or corrupted files.
>
>The whole idea behind this project is that most of the cheaper models DO eventually get to the right answer, but they need a lot of tries and some help from the user to get there. So I wanted to build a tool that makes it easy to have that back-and-forth interaction, where the model can ask for clarification, you can give it feedback, and it can iteratively improve its output until it's good enough. It uses a TODO system and asks the model to update the TODOs based on its own feedback, asking the model to clarify specifically what was implemented over and over until it gets it right. It's a bit like having a pair programming partner that doesn't get frustrated and can keep trying until it gets it right.
>
>100% of the code in this repo was written by **Claude Opus 4.6** and **Z.ai's GLM 5 using Kilo Code**. I just stitched it together and added some glue code here and there. So if you find any issues or have suggestions, please keep in mind that it's not a polished product, but rather a fun experiment that I'm sharing with the world. Thanks for understanding!

## Features

- **Multi-provider support** — Anthropic (Claude), OpenAI, OpenAI-compatible endpoints, Claude Code CLI, and Kilo Gateway.
- **Multiple modes**
  - **Sandboxed Smart To-Do** *(default)* — Iterative plan → execute → verify loop with OS-level sandbox isolation.
  - **Smart To-Do** — Same iterative loop without sandboxing.
  - **Sandbox Orchestrator** — Isolated development with git worktrees and OS-level restrictions.
  - **Agent** — Full autonomy with all tools.
  - **Plan** — Read-only exploration and planning.
  - **Ask** — Chat only, no tool execution.
- **Tool system** — Read/write files, run terminal commands, fetch diagnostics, manage sandboxes.
- **MCP integration** — Connect to Model Context Protocol servers for additional tools.
- **Context awareness** — Automatically discovers skills from `.kilo/`, `.claude/`, `.cline/` directories and `AGENTS.md` files.
- **Multi-session** — Run multiple agent sessions in the background and switch between them.
- **Model selector** — Switch models on the fly from the top bar.

## Getting Started

### Prerequisites

- VS Code **1.96+**
- Node.js **18+**
- npm (included with Node.js)

### Building from Source

```bash
git clone https://github.com/FacuM/yolo-agent.git
cd yolo-agent
npm install
npm run compile
```

### Installation

#### Option A — Development Mode

Open the cloned repository in VS Code and press **F5** to launch the Extension Development Host with the extension loaded.

#### Option B — Install as a .vsix Package

1. Install the packaging tool:

   ```bash
   npm install -g @vscode/vsce
   ```

2. Build the `.vsix` file:

   ```bash
   vsce package
   ```

3. Install in VS Code:

   ```bash
   code --install-extension yolo-agent-0.0.1.vsix
   ```

   Or open VS Code → **Extensions** → **⋯** menu → **Install from VSIX…** and select the file.

### Configure a Provider

1. Open the YOLO Agent sidebar (activity bar icon).
2. Click the **⚙︎** button → **Providers** tab → **+ Add Provider**.
3. Select an API kind (e.g. `anthropic`), paste your API key, and pick a model.

## Project Structure

```
src/
├── extension.ts          # Activation entry point
├── config/               # Settings helpers
├── context/              # Workspace context scanner (skills, AGENTS.md)
├── mcp/                  # MCP client, bridge, and config
├── modes/                # Mode presets, types, and manager
├── providers/            # LLM provider implementations and registry
├── sandbox/              # Sandbox manager (bubblewrap / git worktree)
├── sessions/             # Multi-session manager
├── tools/                # Tool definitions (file-ops, terminal, diagnostics, sandbox)
└── webview/              # Webview panel, HTML, JS, CSS
```

## Development

```bash
npm run compile   # One-shot build
npm run watch     # Rebuild on change
npm run lint      # ESLint
npm run test:e2e  # VS Code integration tests
```

The build is handled by [esbuild](https://esbuild.github.io/) — see `esbuild.js`.

## License

[MIT](LICENSE)
