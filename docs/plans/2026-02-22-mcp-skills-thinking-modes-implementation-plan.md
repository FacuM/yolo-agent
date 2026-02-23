# MCP, Skills, Thinking, and Modes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCP server support, AGENTS.md/skills reading, thinking display, and mode switching (Agent/Ask/Plan/Custom) to the YOLO Agent VS Code extension.

**Architecture:**
1. **Mode System** - A centralized `ModeManager` that filters tools and provides system prompts per mode. Modes are stored in globalState.
2. **Thinking Display** - Extend `LLMResponse` with optional `thinking` field, extract from Claude/OpenAI reasoning, display in collapsible UI blocks.
3. **Skills & AGENTS.md** - A `ContextManager` that scans workspace for skill files and AGENTS.md, injects relevant content into system prompts, with UI panel for visibility.
4. **MCP Client** - An `MCPClient` class that connects to MCP servers via stdio/SSE, discovers tools, and bridges them to the existing Tool interface.

**Tech Stack:** TypeScript, VS Code Extension API, MCP SDK (@modelcontextprotocol/sdk), existing Anthropic/OpenAI SDKs

**File Structure Changes:**
```
src/
├── modes/
│   ├── types.ts          # Mode definitions, ToolPermission enum
│   ├── manager.ts        # ModeManager class
│   └── presets.ts        # Built-in mode definitions (agent, ask, plan)
├── context/
│   ├── types.ts          # Skill, AGENTS.md types
│   ├── scanner.ts        # File system scanner for skills/AGENTS.md
│   └── manager.ts        # ContextManager - injects into system prompt
├── mcp/
│   ├── client.ts         # MCPClient for stdio/SSE connections
│   ├── bridge.ts         # MCPToolBridge - wraps MCP tools as Tool interface
│   ├── config.ts         # MCP config loader from settings + file
│   └── types.ts          # MCP config types
├── providers/
│   ├── types.ts          # MODIFY: Add thinking to LLMResponse
│   ├── anthropic.ts      # MODIFY: Extract thinking blocks
│   └── openai.ts         # MODIFY: Extract reasoning_content
├── webview/
│   ├── panel.ts          # MODIFY: Handle new message types, modes
│   └── ui/
│       ├── main.js       # MODIFY: Mode selector, thinking UI, context panel
│       └── styles.css    # MODIFY: Styles for thinking blocks, mode selector
└── extension.ts          # MODIFY: Wire up ModeManager, ContextManager, MCPClient
```

---

## PHASE 1: Fix Tool Call Expand Bug (Quick Win)

**Priority:** HIGH - This is a user-facing bug that should be fixed first.

### Task 1.1: Fix Tool Call Expand Arrow

**Files:**
- Modify: `src/webview/ui/main.js:411-487`

**Problem:** In `handleToolCallStarted()` (line 436-440), a click listener is added. In `handleToolCallResult()` (line 457), `header.textContent = ''` clears DOM but NOT listeners. Then a second listener is added (line 475-479). Both fire on click, toggling twice (no net effect).

**Solution:** Store a reference to the handler function on the header element, then remove the old listener before adding a new one.

**Step 1: Read the current implementation**

The relevant code is in lines 411-487 of main.js. Review the `handleToolCallStarted` and `handleToolCallResult` functions.

**Step 2: Modify handleToolCallStarted to store handler reference**

```javascript
function handleToolCallStarted(name, id) {
  const card = document.createElement('div');
  card.className = 'tool-call';
  card.dataset.toolId = id;

  const header = document.createElement('div');
  header.className = 'tool-call-header';

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = '\u25B6';

  const nameEl = document.createElement('strong');
  nameEl.textContent = name;

  const status = document.createElement('span');
  status.style.opacity = '0.6';
  status.textContent = 'running...';

  header.appendChild(icon);
  header.appendChild(document.createTextNode(' '));
  header.appendChild(nameEl);
  header.appendChild(document.createTextNode(' '));
  header.appendChild(status);

  // Store the handler on the header element for later removal
  const toggleHandler = () => {
    header.classList.toggle('expanded');
    const contentEl = card.querySelector('.tool-call-content');
    if (contentEl) { contentEl.classList.toggle('visible'); }
  };
  header._toggleHandler = toggleHandler;
  header.addEventListener('click', toggleHandler);

  const contentEl = document.createElement('div');
  contentEl.className = 'tool-call-content';
  contentEl.textContent = 'Executing...';

  card.appendChild(header);
  card.appendChild(contentEl);
  messagesEl.appendChild(card);
  scrollToBottom();
}
```

**Step 3: Modify handleToolCallResult to remove old listener**

```javascript
function handleToolCallResult(id, name, content, isError) {
  const card = messagesEl.querySelector('.tool-call[data-tool-id="' + CSS.escape(id) + '"]');
  if (card) {
    const header = card.querySelector('.tool-call-header');
    if (header) {
      // Remove old listener if it exists
      if (header._toggleHandler) {
        header.removeEventListener('click', header._toggleHandler);
      }

      header.textContent = '';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '\u25B6';

      const nameEl = document.createElement('strong');
      nameEl.textContent = name;

      const statusEl = document.createElement('span');
      statusEl.style.opacity = '0.6';
      statusEl.textContent = isError ? 'error' : 'done';

      header.appendChild(icon);
      header.appendChild(document.createTextNode(' '));
      header.appendChild(nameEl);
      header.appendChild(document.createTextNode(' '));
      header.appendChild(statusEl);

      // Add new listener
      const toggleHandler = () => {
        header.classList.toggle('expanded');
        const c = card.querySelector('.tool-call-content');
        if (c) { c.classList.toggle('visible'); }
      };
      header._toggleHandler = toggleHandler;
      header.addEventListener('click', toggleHandler);
    }
    const contentEl = card.querySelector('.tool-call-content');
    if (contentEl) {
      contentEl.textContent = content;
    }
  }
  scrollToBottom();
}
```

**Step 4: Test the fix**

Run: `npm run build && npm run test:e2e`
Expected: Tests pass, tool call expand/collapse works in manual testing

**Step 5: Commit**

```bash
git add src/webview/ui/main.js
git commit -m "fix: tool call expand arrow now works correctly"
```

---

## PHASE 2: Mode Switching System

### Task 2.1: Create Mode Types and Presets

**Files:**
- Create: `src/modes/types.ts`
- Create: `src/modes/presets.ts`

**Step 1: Write the type definitions**

Create `src/modes/types.ts`:

```typescript
export type ModeId = 'agent' | 'ask' | 'plan' | 'custom';

export type ToolPermission = 'allow' | 'deny' | 'read-only';

export interface Mode {
  id: ModeId;
  name: string;
  description: string;
  systemPrompt: string;
  toolPermissions: Record<string, ToolPermission>; // tool name -> permission
  isBuiltIn: boolean;
}

export interface CustomMode extends Mode {
  id: 'custom';
  isBuiltIn: false;
  toolAllowList: string[]; // Explicit list of allowed tools
  toolDenyList: string[];  // Explicit list of denied tools
}
```

**Step 2: Write the preset modes**

Create `src/modes/presets.ts`:

```typescript
import { Mode } from './types';

export const BUILT_IN_MODES: Record<string, Mode> = {
  agent: {
    id: 'agent' as const,
    name: 'Agent',
    description: 'Full autonomy - can use all tools',
    systemPrompt: 'You are an AI coding assistant with access to tools. Use tools when helpful to complete the user\'s request.',
    toolPermissions: {
      // All tools allowed
      readFile: 'allow',
      writeFile: 'allow',
      listFiles: 'allow',
      runTerminal: 'allow',
      getDiagnostics: 'allow',
    },
    isBuiltIn: true,
  },

  ask: {
    id: 'ask' as const,
    name: 'Ask',
    description: 'Chat only - no tool execution',
    systemPrompt: 'You are a helpful AI assistant. Answer questions based on your knowledge. Do not attempt to use tools.',
    toolPermissions: {
      // All tools denied
      readFile: 'deny',
      writeFile: 'deny',
      listFiles: 'deny',
      runTerminal: 'deny',
      getDiagnostics: 'deny',
    },
    isBuiltIn: true,
  },

  plan: {
    id: 'plan' as const,
    name: 'Plan',
    description: 'Read-only access - can view but not modify',
    systemPrompt: 'You are a planning assistant. You can read files and explore the codebase, but cannot make changes. Help the user plan their work.',
    toolPermissions: {
      // Read-only tools only
      readFile: 'allow',
      writeFile: 'deny',
      listFiles: 'allow',
      runTerminal: 'deny',
      getDiagnostics: 'allow',
    },
    isBuiltIn: true,
  },
};

export const DEFAULT_MODE: ModeId = 'agent';
```

**Step 3: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/modes/
git commit -m "feat: add mode type definitions and built-in presets"
```

### Task 2.2: Create ModeManager

**Files:**
- Create: `src/modes/manager.ts`

**Step 1: Write ModeManager class**

Create `src/modes/manager.ts`:

```typescript
import * as vscode from 'vscode';
import { Mode, ModeId, CustomMode } from './types';
import { BUILT_IN_MODES, DEFAULT_MODE } from './presets';

export class ModeManager {
  private currentModeId: ModeId = DEFAULT_MODE;
  private customModes: Map<string, CustomMode> = new Map();
  private _onDidChangeMode = new vscode.EventEmitter<ModeId>();
  private _onDidChangeCustomModes = new vscode.EventEmitter<void>();

  readonly onDidChangeMode = this._onDidChangeMode.event;
  readonly onDidChangeCustomModes = this._onDidChangeCustomModes.event;

  constructor(private context: vscode.ExtensionContext) {
    this.loadState();
  }

  private async loadState() {
    // Load current mode
    const savedMode = this.context.globalState.get<ModeId>('currentMode', DEFAULT_MODE);
    this.currentModeId = savedMode;

    // Load custom modes
    const savedCustomModes = this.context.globalState.get<any[]>('customModes', []);
    for (const modeData of savedCustomModes) {
      this.customModes.set(modeData.id, modeData);
    }
  }

  getCurrentMode(): Mode {
    if (this.customModes.has(this.currentModeId)) {
      return this.customModes.get(this.currentModeId)!;
    }
    return BUILT_IN_MODES[this.currentModeId] || BUILT_IN_MODES.agent;
  }

  async setCurrentMode(modeId: ModeId) {
    if (modeId !== this.currentModeId) {
      this.currentModeId = modeId;
      await this.context.globalState.update('currentMode', modeId);
      this._onDidChangeMode.fire(modeId);
    }
  }

  getAllModes(): Mode[] {
    const builtIn = Object.values(BUILT_IN_MODES);
    const custom = Array.from(this.customModes.values());
    return [...builtIn, ...custom];
  }

  async saveCustomMode(mode: CustomMode) {
    this.customModes.set(mode.id, mode);
    const allCustomModes = Array.from(this.customModes.values());
    await this.context.globalState.update('customModes', allCustomModes);
    this._onDidChangeCustomModes.fire();
  }

  async deleteCustomMode(modeId: string) {
    if (this.customModes.has(modeId)) {
      this.customModes.delete(modeId);
      const allCustomModes = Array.from(this.customModes.values());
      await this.context.globalState.update('customModes', allCustomModes);

      // Fall back to agent mode if we deleted the current mode
      if (this.currentModeId === modeId) {
        await this.setCurrentMode('agent');
      }
      this._onDidChangeCustomModes.fire();
    }
  }

  /**
   * Filter tools based on current mode's permissions
   */
  getAllowedTools(allToolNames: string[]): string[] {
    const mode = this.getCurrentMode();
    return allToolNames.filter(name => {
      const permission = mode.toolPermissions[name] || 'deny';
      return permission !== 'deny';
    });
  }

  /**
   * Get the system prompt for the current mode
   */
  getSystemPrompt(): string {
    return this.getCurrentMode().systemPrompt;
  }
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/modes/manager.ts
git commit -m "feat: add ModeManager with state persistence"
```

### Task 2.3: Add Mode Selector to Webview

**Files:**
- Modify: `src/webview/panel.ts`
- Modify: `src/webview/ui/main.js`
- Modify: `src/webview/ui/styles.css`
- Modify: `src/extension.ts`

**Step 1: Update panel.ts to send modes and handle mode changes**

Modify `src/webview/panel.ts` - add new message handlers:

```typescript
// In the message handler switch statement (around line 70), add:
case 'getModes':
  this.handleGetModes();
  break;
case 'setMode':
  if (message.modeId) {
    await this.modeManager.setCurrentMode(message.modeId as ModeId);
    this.postMessage({
      type: 'modeChanged',
      mode: this.modeManager.getCurrentMode(),
    });
  }
  break;
case 'saveCustomMode':
  // Handle saving custom mode
  break;
case 'deleteCustomMode':
  // Handle deleting custom mode
  break;

// Add new handler method:
private handleGetModes() {
  const modes = this.modeManager.getAllModes();
  const currentMode = this.modeManager.getCurrentMode();
  this.postMessage({
    type: 'modes',
    modes,
    currentModeId: currentMode.id,
  });
}

// Modify handleSendMessage to filter tools by mode:
private async handleSendMessage(text: string) {
  // ... existing code ...

  // Get allowed tools based on current mode
  const allToolNames = Array.from(this.tools.keys());
  const allowedToolNames = this.modeManager.getAllowedTools(allToolNames);
  const allowedTools = allowedToolNames.map(name => this.tools.get(name)!.definition);

  // ... rest of existing code, use allowedTools instead of all tools ...

  // Add mode system prompt
  const modePrompt = this.modeManager.getSystemPrompt();
  const messages: ChatMessage[] = [
    { role: 'system', content: modePrompt },
    ...this.conversationHistory,
    userMessage,
  ];
}
```

**Step 2: Update main.js to render mode selector**

Add to `src/webview/ui/main.js`:

```javascript
// Add to state variables (around line 55):
let modes = [];
let currentModeId = 'agent';

// Add mode selector element reference (around line 27):
const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('mode-select'));

// Add message handler case (around line 232):
case 'modes':
  modes = message.modes;
  currentModeId = message.currentModeId;
  updateModeSelector();
  break;
case 'modeChanged':
  currentModeId = message.mode.id;
  updateModeSelector();
  break;

// Add function (around line 650):
function updateModeSelector() {
  modeSelect.textContent = '';
  for (const m of modes) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === currentModeId) { opt.selected = true; }
    modeSelect.appendChild(opt);
  }
}

// Add event listener (around line 90):
modeSelect.addEventListener('change', () => {
  vscode.postMessage({ type: 'setMode', modeId: modeSelect.value });
});

// Add to init (around line 65):
vscode.postMessage({ type: 'getModes' });
```

**Step 3: Update HTML to include mode selector**

Modify `src/webview/panel.ts` HTML template (around line 10), add mode selector in header:

```html
<select id="mode-select" title="Select mode"></select>
```

**Step 4: Add CSS for mode selector**

Add to `src/webview/ui/styles.css` (around line 50):

```css
#mode-select {
  padding: 4px 8px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 3px;
  font-size: var(--vscode-font-size);
  max-width: 100px;
}
```

**Step 5: Wire up ModeManager in extension.ts**

Modify `src/extension.ts`:

```typescript
import { ModeManager } from './modes/manager';

// In activate() function (around line 15), create ModeManager:
const modeManager = new ModeManager(context);

// Pass modeManager to ChatViewProvider:
const chatProvider = new ChatViewProvider(
  registry,
  tools,
  profileManager,
  modeManager  // NEW
);
```

**Step 6: TypeScript check and build**

Run: `npm run build`
Expected: No errors

**Step 7: Update E2E test**

Modify `test/e2e/extension.test.ts` - add test for mode system:

```typescript
test('Mode system is available', async () => {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes('yoloAgent.setMode'),
    'setMode command should be registered'
  );
});
```

**Step 8: Run tests**

Run: `npm run test:e2e`
Expected: All tests pass

**Step 9: Commit**

```bash
git add src/modes/ src/webview/ src/extension.ts test/e2e/
git commit -m "feat: add mode selector UI and integration"
```

---

## PHASE 3: Thinking/Reasoning Display

### Task 3.1: Extend LLMResponse with Thinking Field

**Files:**
- Modify: `src/providers/types.ts`

**Step 1: Add thinking field to LLMResponse**

Modify `src/providers/types.ts` (around line 34):

```typescript
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  thinking?: string;  // NEW: Extended thinking or reasoning content
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'max_tokens' | 'error';
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors (thinking is optional)

**Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add thinking field to LLMResponse"
```

### Task 3.2: Extract Thinking from Anthropic

**Files:**
- Modify: `src/providers/anthropic.ts`

**Step 1: Modify sendMessage to extract thinking blocks**

Modify `src/providers/anthropic.ts` (around line 52-80):

```typescript
async sendMessage(
  messages: ChatMessage[],
  options: RequestOptions,
  onChunk: (chunk: string) => void
): Promise<LLMResponse> {
  if (!this.client) {
    throw new Error('Anthropic API key not set');
  }

  const systemMessage = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const anthropicMessages = nonSystemMessages.map((m) =>
    this.toAnthropicMessage(m)
  );

  const tools = options.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool['input_schema'],
  }));

  const stream = this.client.messages.stream({
    model: options.model || 'claude-sonnet-4-20250514',
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature,
    system: systemMessage?.content,
    messages: anthropicMessages,
    tools,
  });

  let fullContent = '';
  let thinkingContent = '';  // NEW
  const toolCalls: ToolCall[] = [];

  stream.on('text', (text) => {
    fullContent += text;
    onChunk(text);
  });

  // NEW: Extended thinking is not streamed, collect from final message
  const finalMessage = await stream.finalMessage();

  for (const block of finalMessage.content) {
    if (block.type === 'thinking') {
      thinkingContent += block.thinking;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content: fullContent,
    thinking: thinkingContent || undefined,  // NEW
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    },
    finishReason: this.mapStopReason(finalMessage.stop_reason),
  };
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/providers/anthropic.ts
git commit -m "feat: extract thinking blocks from Anthropic responses"
```

### Task 3.3: Extract Reasoning from OpenAI

**Files:**
- Modify: `src/providers/openai.ts`

**Step 1: Modify sendMessage to extract reasoning_content**

First, read the current openai.ts to understand the structure, then modify similarly to extract `reasoning_content` from o-series models.

The modification depends on the OpenAI SDK response format. For o1/o3 models with reasoning:

```typescript
// In the response handling section, look for reasoning_content
if ('reasoning_content' in response && typeof response.reasoning_content === 'string') {
  return {
    content: response.content || '',
    thinking: response.reasoning_content,
    // ... rest of response
  };
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/providers/openai.ts
git commit -m "feat: extract reasoning_content from OpenAI o-series models"
```

### Task 3.4: Add Thinking UI to Webview

**Files:**
- Modify: `src/webview/panel.ts`
- Modify: `src/webview/ui/main.js`
- Modify: `src/webview/ui/styles.css`

**Step 1: Add thinking message type to panel.ts**

Modify `src/webview/panel.ts` - send thinking chunks to UI:

```typescript
// In handleSendMessage, after streaming completes:
if (response.thinking) {
  this.postMessage({
    type: 'thinking',
    content: response.thinking,
  });
}

// Then send the regular stream chunks
```

**Step 2: Add thinking display to main.js**

Add to `src/webview/ui/main.js` (around line 200):

```javascript
// Add message handler case:
case 'thinking':
  handleThinking(message.content);
  break;

// Add function (around line 500):
function handleThinking(content) {
  if (!currentAssistantEl) {
    currentAssistantEl = appendMessage('assistant', '');
  }

  // Find or create thinking container
  let thinkingEl = currentAssistantEl.querySelector('.thinking-block');
  if (!thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking-block';

    const header = document.createElement('div');
    header.className = 'thinking-header';

    const icon = document.createElement('span');
    icon.className = 'thinking-icon';
    icon.textContent = '\u1F4A1'; // Light bulb emoji

    const title = document.createElement('span');
    title.textContent = 'Thinking';

    const toggle = document.createElement('span');
    toggle.className = 'thinking-toggle';
    toggle.textContent = '\u25B6'; // Play/arrow symbol

    header.appendChild(icon);
    header.appendChild(document.createTextNode(' '));
    header.appendChild(title);
    header.appendChild(toggle);

    const contentEl = document.createElement('div');
    contentEl.className = 'thinking-content';
    contentEl.textContent = content;

    thinkingEl.appendChild(header);
    thinkingEl.appendChild(contentEl);

    // Insert at the beginning of the message
    currentAssistantEl.insertBefore(thinkingEl, currentAssistantEl.firstChild);

    // Add toggle handler
    header.addEventListener('click', () => {
      thinkingEl.classList.toggle('expanded');
      toggle.textContent = thinkingEl.classList.contains('expanded') ? '\u25BC' : '\u25B6';
    });
  } else {
    const contentEl = thinkingEl.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = content;
    }
  }
  scrollToBottom();
}
```

**Step 3: Add CSS for thinking blocks**

Add to `src/webview/ui/styles.css` (around line 145):

```css
/* Thinking blocks */
.thinking-block {
  margin: 8px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
  background: var(--vscode-textBlockQuote-background);
}

.thinking-header {
  padding: 6px 10px;
  background: var(--vscode-editor-lineHighlightBackground);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85em;
  opacity: 0.8;
  user-select: none;
}

.thinking-header:hover {
  opacity: 1;
}

.thinking-icon {
  font-size: 1em;
}

.thinking-content {
  display: none;
  padding: 10px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.9em;
  white-space: pre-wrap;
  line-height: 1.4;
  opacity: 0.7;
  max-height: 300px;
  overflow-y: auto;
}

.thinking-block.expanded .thinking-content {
  display: block;
}

.thinking-toggle {
  margin-left: auto;
  transition: transform 0.15s;
}

.thinking-block.expanded .thinking-toggle {
  transform: rotate(90deg);
}
```

**Step 4: Build and test**

Run: `npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add src/webview/ src/providers/
git commit -m "feat: add thinking display UI for Claude and OpenAI reasoning"
```

---

## PHASE 4: Skills and AGENTS.md

### Task 4.1: Create Context Types

**Files:**
- Create: `src/context/types.ts`

**Step 1: Write context types**

Create `src/context/types.ts`:

```typescript
export interface Skill {
  name: string;
  description: string;
  content: string;       // Markdown content
  sourcePath: string;    // Absolute path to skill file
  tags: string[];        // For categorization/filtering
  enabled: boolean;
}

export interface AgentsMd {
  path: string;          // Absolute path
  content: string;       // Full file content
  projectName: string;   // Inferred from directory
}

export interface ContextInjection {
  systemPromptAddition: string;
  skills: Skill[];
  agentsMd: AgentsMd[];
}
```

**Step 2: Commit**

```bash
git add src/context/types.ts
git commit -m "feat: add context types for skills and AGENTS.md"
```

### Task 4.2: Create File Scanner

**Files:**
- Create: `src/context/scanner.ts`

**Step 1: Write file system scanner**

Create `src/context/scanner.ts`:

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { Skill, AgentsMd } from './types';

export class ContextScanner {
  private skills: Map<string, Skill> = new Map();
  private agentsMdFiles: Map<string, AgentsMd> = new Map();
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor() {}

  /**
   * Scan workspace for skills and AGENTS.md files
   */
  async scanWorkspace(): Promise<{ skills: Skill[]; agentsMd: AgentsMd[] }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return { skills: [], agentsMd: [] };
    }

    this.skills.clear();
    this.agentsMdFiles.clear();

    for (const folder of workspaceFolders) {
      await this.scanFolder(folder.uri.fsPath);
    }

    return {
      skills: Array.from(this.skills.values()),
      agentsMd: Array.from(this.agentsMdFiles.values()),
    };
  }

  private async scanFolder(rootPath: string) {
    // Scan for .yolo-agent/skills directory
    const skillsDir = path.join(rootPath, '.yolo-agent', 'skills');
    await this.scanSkillsDirectory(skillsDir);

    // Scan for AGENTS.md in root and subdirectories (up to 2 levels deep)
    await this.scanForAgentsMd(rootPath, 0, 2);
  }

  private async scanSkillsDirectory(skillsDir: string) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(skillsDir));
      if (stat.type !== vscode.FileType.Directory) {
        return;
      }
    } catch {
      // Directory doesn't exist
      return;
    }

    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(skillsDir));

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) {
        continue;
      }

      if (!name.endsWith('.md')) {
        continue;
      }

      const filePath = path.join(skillsDir, name);
      await this.loadSkillFile(filePath);
    }
  }

  private async loadSkillFile(filePath: string) {
    try {
      const contentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const content = Buffer.from(contentBytes).toString('utf-8');

      // Parse skill frontmatter (simple format: ---\nname: ...\ndescription: ...\ntags: ...\n---\ncontent)
      const skill = this.parseSkillContent(content, filePath);
      this.skills.set(skill.name, skill);
    } catch (err) {
      console.error(`Failed to load skill file: ${filePath}`, err);
    }
  }

  private parseSkillContent(content: string, sourcePath: string): Skill {
    let name = path.basename(sourcePath, '.md');
    let description = '';
    let tags: string[] = [];
    let bodyContent = content;

    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      bodyContent = frontmatterMatch[2];

      // Simple YAML parsing (just key: value pairs)
      const nameMatch = frontmatter.match(/name:\s*(.+)/);
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      const tagsMatch = frontmatter.match(/tags:\s*\[(.+)\]/);

      if (nameMatch) name = nameMatch[1].trim();
      if (descMatch) description = descMatch[1].trim();
      if (tagsMatch) {
        tags = tagsMatch[1].split(',').map(t => t.trim());
      }
    }

    return {
      name,
      description,
      content: bodyContent,
      sourcePath,
      tags,
      enabled: true,
    };
  }

  private async scanForAgentsMd(dirPath: string, currentDepth: number, maxDepth: number) {
    if (currentDepth > maxDepth) {
      return;
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));

      // Check for AGENTS.md in current directory
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.toUpperCase() === 'AGENTS.MD') {
          const filePath = path.join(dirPath, name);
          await this.loadAgentsMdFile(filePath, dirPath);
        }
      }

      // Recurse into subdirectories
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && !name.startsWith('.')) {
          await this.scanForAgentsMd(path.join(dirPath, name), currentDepth + 1, maxDepth);
        }
      }
    } catch (err) {
      // Directory not accessible, skip
    }
  }

  private async loadAgentsMdFile(filePath: string, dirPath: string) {
    try {
      const contentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const content = Buffer.from(contentBytes).toString('utf-8');

      const projectName = path.basename(dirPath);

      this.agentsMdFiles.set(filePath, {
        path: filePath,
        content,
        projectName,
      });
    } catch (err) {
      console.error(`Failed to load AGENTS.md: ${filePath}`, err);
    }
  }

  /**
   * Start watching for file changes
   */
  startWatching() {
    // Watch for changes in .yolo-agent directories
    const skillsPattern = '**/.yolo-agent/skills/*.md';
    const skillsWatcher = vscode.workspace.createFileSystemWatcher(skillsPattern);
    skillsWatcher.onDidCreate(uri => this.loadSkillFile(uri.fsPath));
    skillsWatcher.onDidChange(uri => this.loadSkillFile(uri.fsPath));
    skillsWatcher.onDidDelete(uri => {
      // Find and remove skill by path
      for (const [name, skill] of this.skills) {
        if (skill.sourcePath === uri.fsPath) {
          this.skills.delete(name);
          break;
        }
      }
    });
    this.watchers.push(skillsWatcher);

    // Watch for AGENTS.md changes
    const agentsPattern = '**/AGENTS.md';
    const agentsWatcher = vscode.workspace.createFileSystemWatcher(agentsPattern);
    agentsWatcher.onDidCreate(async uri => {
      const dirPath = path.dirname(uri.fsPath);
      await this.loadAgentsMdFile(uri.fsPath, dirPath);
    });
    agentsWatcher.onDidChange(async uri => {
      const dirPath = path.dirname(uri.fsPath);
      await this.loadAgentsMdFile(uri.fsPath, dirPath);
    });
    agentsWatcher.onDidDelete(uri => {
      this.agentsMdFiles.delete(uri.fsPath);
    });
    this.watchers.push(agentsWatcher);
  }

  dispose() {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getAgentsMdFiles(): AgentsMd[] {
    return Array.from(this.agentsMdFiles.values());
  }
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/context/scanner.ts
git commit -m "feat: add workspace scanner for skills and AGENTS.md"
```

### Task 4.3: Create ContextManager

**Files:**
- Create: `src/context/manager.ts`

**Step 1: Write ContextManager**

Create `src/context/manager.ts`:

```typescript
import * as vscode from 'vscode';
import { ContextScanner, Skill, AgentsMd } from './scanner';

export class ContextManager {
  private scanner: ContextScanner;
  private enabledSkills: Set<string> = new Set();
  private _onDidChangeContext = new vscode.EventEmitter<void>();

  readonly onDidChangeContext = this._onDidChangeContext.event;

  constructor() {
    this.scanner = new ContextScanner();
  }

  async initialize() {
    await this.scanWorkspace();
    this.scanner.startWatching();
  }

  private async scanWorkspace() {
    const result = await this.scanner.scanWorkspace();

    // Auto-enable all skills by default
    for (const skill of result.skills) {
      this.enabledSkills.add(skill.name);
    }

    this._onDidChangeContext.fire();
  }

  /**
   * Get the system prompt addition with skills and AGENTS.md content
   */
  getSystemPromptAddition(): string {
    const parts: string[] = [];

    // Add AGENTS.md content
    const agentsMd = this.scanner.getAgentsMdFiles();
    if (agentsMd.length > 0) {
      parts.push('=== Project Guidelines ===');
      for (const agents of agentsMd) {
        parts.push(`\n--- ${agents.projectName} ---\n${agents.content}\n`);
      }
    }

    // Add enabled skills
    const skills = this.getEnabledSkills();
    if (skills.length > 0) {
      parts.push('\n=== Available Skills ===');
      for (const skill of skills) {
        parts.push(`\n--- ${skill.name} ---\n${skill.description}\n${skill.content}\n`);
      }
    }

    return parts.join('\n');
  }

  getSkills(): Skill[] {
    return this.scanner.getSkills();
  }

  getAgentsMdFiles(): AgentsMd[] {
    return this.scanner.getAgentsMdFiles();
  }

  getEnabledSkills(): Skill[] {
    return this.scanner.getSkills().filter(s => this.enabledSkills.has(s.name));
  }

  setSkillEnabled(name: string, enabled: boolean) {
    if (enabled) {
      this.enabledSkills.add(name);
    } else {
      this.enabledSkills.delete(name);
    }
    this._onDidChangeContext.fire();
  }

  dispose() {
    this.scanner.dispose();
  }
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/context/manager.ts
git commit -m "feat: add ContextManager for system prompt injection"
```

### Task 4.4: Add Context UI Panel

**Files:**
- Modify: `src/webview/panel.ts`
- Modify: `src/webview/ui/main.js`
- Modify: `src/webview/ui/styles.css`
- Modify: `src/extension.ts`

**Step 1: Add new view for context panel**

Modify `src/webview/panel.ts` HTML template - add a fourth view `#context-view`:

```html
<!-- Add after editor-view -->
<div id="context-view" class="hidden">
  <div id="context-header">
    <button id="context-back-btn">←</button>
    <span class="header-title">Context (Skills & AGENTS.md)</span>
  </div>
  <div id="context-content">
    <div id="skills-section"></div>
    <div id="agents-section"></div>
  </div>
</div>
```

**Step 2: Add context button to chat header**

Add a "📋" or similar icon button next to settings button.

**Step 3: Add message handlers for context**

```typescript
case 'getContext':
  this.handleGetContext();
  break;

private handleGetContext() {
  const skills = this.contextManager.getSkills();
  const agentsMd = this.contextManager.getAgentsMdFiles();
  const enabledSkills = this.contextManager.getEnabledSkills();

  this.postMessage({
    type: 'context',
    skills,
    agentsMd,
    enabledSkillNames: enabledSkills.map(s => s.name),
  });
}

case 'setSkillEnabled':
  this.contextManager.setSkillEnabled(message.skillName, message.enabled);
  break;
```

**Step 4: Implement context UI in main.js**

Similar to settings view - render skills with toggle switches, show AGENTS.md content in collapsible sections.

**Step 5: Wire up ContextManager in extension.ts**

```typescript
const contextManager = new ContextManager();
await contextManager.initialize();

// Pass to ChatViewProvider
const chatProvider = new ChatViewProvider(
  registry,
  tools,
  profileManager,
  modeManager,
  contextManager  // NEW
);
```

**Step 6: Modify sendMessage to include context**

In `ChatViewProvider.handleSendMessage()`:

```typescript
const contextAddition = this.contextManager.getSystemPromptAddition();
const modePrompt = this.modeManager.getSystemPrompt();

const messages: ChatMessage[] = [
  {
    role: 'system',
    content: modePrompt + (contextAddition ? '\n\n' + contextAddition : '')
  },
  ...this.conversationHistory,
  userMessage,
];
```

**Step 7: Build and test**

Run: `npm run build`
Expected: No errors

**Step 8: Commit**

```bash
git add src/context/ src/webview/ src/extension.ts
git commit -m "feat: add context UI panel for skills and AGENTS.md"
```

---

## PHASE 5: MCP Server Support

### Task 5.1: Create MCP Types

**Files:**
- Create: `src/mcp/types.ts`

**Step 1: Write MCP configuration types**

Create `src/mcp/types.ts`:

```typescript
export type McpTransportType = 'stdio' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportType;
  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For SSE
  url?: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  serverId: string;
}

export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
}
```

**Step 2: Commit**

```bash
git add src/mcp/types.ts
git commit -m "feat: add MCP configuration types"
```

### Task 5.2: Create MCP Config Loader

**Files:**
- Create: `src/mcp/config.ts`

**Step 1: Write config loader**

Create `src/mcp/config.ts`:

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { McpServerConfig } from './types';

export class McpConfigManager {
  private configs: Map<string, McpServerConfig> = new Map();
  private watcher?: vscode.FileSystemWatcher;

  constructor(private context: vscode.ExtensionContext) {
    this.loadConfigs();
  }

  private async loadConfigs() {
    // Load from globalState (saved via settings UI)
    const savedConfigs = this.context.globalState.get<McpServerConfig[]>('mcpServers', []);
    for (const config of savedConfigs) {
      this.configs.set(config.id, config);
    }

    // Load from workspace config file
    await this.loadWorkspaceConfig();

    // Start watching workspace config
    this.startWatching();
  }

  private async loadWorkspaceConfig() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    for (const folder of workspaceFolders) {
      const configPath = path.join(folder.uri.fsPath, '.yolo-agent', 'mcp.json');

      try {
        const content = await fs.readFile(configPath, 'utf-8');
        const workspaceConfigs = JSON.parse(content) as McpServerConfig[];

        for (const config of workspaceConfigs) {
          // Workspace configs override saved configs
          this.configs.set(config.id, { ...config, enabled: config.enabled ?? true });
        }
      } catch {
        // File doesn't exist or invalid JSON, skip
      }
    }
  }

  private startWatching() {
    const pattern = '**/.yolo-agent/mcp.json';
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(async () => {
      await this.loadWorkspaceConfig();
      this._onDidChangeConfigs.fire();
    });

    this.watcher.onDidCreate(async () => {
      await this.loadWorkspaceConfig();
      this._onDidChangeConfigs.fire();
    });

    this.watcher.onDidDelete(async () => {
      await this.loadWorkspaceConfig();
      this._onDidChangeConfigs.fire();
    });
  }

  private _onDidChangeConfigs = new vscode.EventEmitter<void>();
  readonly onDidChangeConfigs = this._onDidChangeConfigs.event;

  getConfigs(): McpServerConfig[] {
    return Array.from(this.configs.values());
  }

  getEnabledConfigs(): McpServerConfig[] {
    return this.getConfigs().filter(c => c.enabled);
  }

  async saveConfig(config: McpServerConfig) {
    this.configs.set(config.id, config);
    const allConfigs = Array.from(this.configs.values());
    await this.context.globalState.update('mcpServers', allConfigs);
    this._onDidChangeConfigs.fire();
  }

  async deleteConfig(id: string) {
    this.configs.delete(id);
    const allConfigs = Array.from(this.configs.values());
    await this.context.globalState.update('mcpServers', allConfigs);
    this._onDidChangeConfigs.fire();
  }

  dispose() {
    this.watcher?.dispose();
  }
}
```

**Step 2: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/mcp/config.ts
git commit -m "feat: add MCP config loader with file and globalState support"
```

### Task 5.3: Create MCP Client

**Files:**
- Create: `src/mcp/client.ts`
- Create: `package.json` (modify - add MCP SDK dependency)

**Step 1: Add MCP SDK dependency**

Modify `package.json` dependencies:

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "openai": "^4.80.0",
    "@modelcontextprotocol/sdk": "^1.0.4"
  }
}
```

**Step 2: Install dependency**

Run: `npm install`

**Step 3: Write MCP client**

Create `src/mcp/client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServerConfig, McpToolDefinition, McpToolResult } from './types';

export class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | SSEClientTransport | null = null;
  private tools: Map<string, McpToolDefinition> = new Map();

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<boolean> {
    try {
      this.client = new Client(
        {
          name: 'yolo-agent',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      if (this.config.transport === 'stdio') {
        if (!this.config.command) {
          throw new Error('stdio transport requires command');
        }

        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args || [],
          env: this.config.env,
        });
      } else if (this.config.transport === 'sse') {
        if (!this.config.url) {
          throw new Error('sse transport requires url');
        }

        this.transport = new SSEClientTransport(new URL(this.config.url));
      } else {
        throw new Error(`Unknown transport type: ${this.config.transport}`);
      }

      await this.client.connect(this.transport);

      // Discover tools
      await this.discoverTools();

      return true;
    } catch (err) {
      console.error(`Failed to connect to MCP server ${this.config.name}:`, err);
      return false;
    }
  }

  private async discoverTools() {
    if (!this.client) {
      return;
    }

    const response = await this.client.listTools();

    for (const tool of response.tools) {
      this.tools.set(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        serverId: this.config.id,
      });
    }
  }

  getTools(): McpToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.client) {
      throw new Error('Client not connected');
    }

    const response = await this.client.callTool({
      name,
      arguments: args,
    });

    return response as McpToolResult;
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.tools.clear();
  }

  isConnected(): boolean {
    return this.client !== null;
  }
}
```

**Step 4: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors (may need to add module resolution for @modelcontextprotocol/sdk)

**Step 5: Commit**

```bash
git add src/mcp/client.ts package.json package-lock.json
git commit -m "feat: add MCP client with stdio and SSE transport support"
```

### Task 5.4: Create MCP Tool Bridge

**Files:**
- Create: `src/mcp/bridge.ts`

**Step 1: Write tool bridge**

Create `src/mcp/bridge.ts`:

```typescript
import { McpClient } from './client';
import { Tool } from '../tools/types';

export class McpToolBridge {
  private toolWrappers: Map<string, Tool> = new Map();

  constructor(private client: McpClient) {}

  /**
   * Create Tool wrappers for all MCP tools
   */
  createToolWrappers(): Map<string, Tool> {
    this.toolWrappers.clear();

    for (const mcpTool of this.client.getTools()) {
      const wrapper: Tool = {
        definition: {
          name: mcpTool.name,
          description: `[MCP:${this.client['config'].name}] ${mcpTool.description}`,
          parameters: mcpTool.inputSchema,
        },
        execute: async (params) => {
          try {
            const result = await this.client.callTool(mcpTool.name, params);

            // Format result content as string
            let output = '';
            if (Array.isArray(result.content)) {
              for (const item of result.content) {
                if (typeof item === 'object' && item !== null) {
                  if ('text' in item) {
                    output += item.text;
                  } else if ('data' in item) {
                    output += `<data: ${JSON.stringify(item.data)}>`;
                  }
                }
              }
            }

            return {
              content: output || 'Tool executed successfully',
              isError: result.isError ?? false,
            };
          } catch (err) {
            return {
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
      };

      this.toolWrappers.set(mcpTool.name, wrapper);
    }

    return this.toolWrappers;
  }
}
```

**Step 2: Commit**

```bash
git add src/mcp/bridge.ts
git commit -m "feat: add MCP tool bridge to wrap MCP tools as Tool interface"
```

### Task 5.5: Wire Up MCP in Extension

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/webview/panel.ts`
- Modify: `src/webview/ui/main.js`
- Modify: `src/webview/ui/styles.css`

**Step 1: Create MCP manager in extension.ts**

Add to `src/extension.ts`:

```typescript
import { McpConfigManager } from './mcp/config';
import { McpClient } from './mcp/client';
import { McpToolBridge } from './mcp/bridge';

// In activate():
const mcpConfigManager = new McpConfigManager(context);

// Create MCP clients for enabled configs
const mcpClients: McpClient[] = [];
const mcpTools = new Map<string, Tool>();

for (const config of mcpConfigManager.getEnabledConfigs()) {
  const client = new McpClient(config);
  const connected = await client.connect();
  if (connected) {
    mcpClients.push(client);
    const bridge = new McpToolBridge(client);
    const toolWrappers = bridge.createToolWrappers();
    for (const [name, tool] of toolWrappers) {
      mcpTools.set(name, tool);
    }
  }
}

// Merge MCP tools with built-in tools
for (const [name, tool] of mcpTools) {
  tools.set(name, tool);
}

// Pass to ChatViewProvider
const chatProvider = new ChatViewProvider(
  registry,
  tools,
  profileManager,
  modeManager,
  contextManager,
  mcpConfigManager  // NEW
);
```

**Step 2: Add MCP settings UI**

Similar to profiles UI - add MCP servers section in settings view with:
- List of configured MCP servers
- Add/Edit MCP server dialog
- Enable/disable toggle per server
- Transport type selector (stdio/sse)
- Command/args inputs for stdio
- URL input for SSE

**Step 3: Build and test**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/extension.ts src/mcp/ src/webview/
git commit -m "feat: integrate MCP server support with settings UI"
```

---

## SUMMARY

This implementation plan is organized into 5 phases:

1. **Phase 1: Fix Tool Call Bug** - Quick win, fixes existing broken functionality
2. **Phase 2: Mode System** - Agent/Ask/Plan modes + custom modes
3. **Phase 3: Thinking Display** - Show Claude thinking blocks and OpenAI reasoning
4. **Phase 4: Skills & AGENTS.md** - Workspace context injection with UI panel
5. **Phase 5: MCP Support** - Connect to external MCP servers, expose their tools

Each phase has multiple tasks with specific steps, file paths, and code snippets. Each step can be implemented and committed independently.

**Testing Strategy:**
- After each phase: Build (`npm run build`), type-check (`npx tsc --noEmit`), run E2E tests (`npm run test:e2e`)
- Manual testing in VS Code with actual providers
- Test MCP with a real server (e.g., `npx -y @modelcontextprotocol/server-everything`)

**New Dependencies:**
- `@modelcontextprotocol/sdk`: ^1.0.4 (for MCP client)

**Estimated Timeline:**
- Phase 1: 15 minutes
- Phase 2: 1 hour
- Phase 3: 45 minutes
- Phase 4: 1.5 hours
- Phase 5: 2 hours

Total: ~5 hours of focused work
