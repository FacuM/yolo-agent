# Context Compaction Controls — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add user-controlled context compaction with three modes (semi-automatic with countdown, automatic, manual) and a digest editor for manual context editing before compaction.

**Architecture:** Settings stored in `globalState` via helpers in `config/settings.ts`. The agent tool loop in `panel.ts` pauses via a `Promise` when compaction triggers in non-automatic modes. The webview shows a countdown banner and/or digest editor. A new "General" tab in Settings hosts the compaction preferences.

**Tech Stack:** TypeScript (VS Code extension), vanilla JS webview, CSS

---

### Task 1: Settings Infrastructure

**Files:**
- Modify: `src/config/settings.ts`

**Step 1: Implement settings helpers**

Replace the placeholder file with the compaction settings interface and read/write helpers:

```typescript
import * as vscode from 'vscode';

export type CompactionMethod = 'semi-automatic' | 'automatic' | 'manual';

export interface CompactionSettings {
  method: CompactionMethod;
  timeoutSeconds: number;
}

const DEFAULTS: CompactionSettings = {
  method: 'semi-automatic',
  timeoutSeconds: 60,
};

const SETTINGS_KEY = 'yoloAgent.compactionSettings';

export function getCompactionSettings(globalState: vscode.Memento): CompactionSettings {
  const stored = globalState.get<Partial<CompactionSettings>>(SETTINGS_KEY);
  return { ...DEFAULTS, ...stored };
}

export async function saveCompactionSettings(
  globalState: vscode.Memento,
  settings: Partial<CompactionSettings>
): Promise<void> {
  const current = getCompactionSettings(globalState);
  await globalState.update(SETTINGS_KEY, { ...current, ...settings });
}
```

**Step 2: Compile to verify**

Run: `npm run compile`
Expected: Clean build, no errors

**Step 3: Commit**

```bash
git add src/config/settings.ts
git commit -m "feat: add compaction settings infrastructure"
```

---

### Task 2: Pass globalState to ChatViewProvider

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/webview/panel.ts` (constructor + field)

**Step 1: Add globalState parameter to ChatViewProvider**

In `src/webview/panel.ts`, add a `globalState` field and constructor parameter:

- Add field: `private globalState: vscode.Memento;` after line 136 (after `private sandboxManager`)
- Add `globalState: vscode.Memento` as the first constructor parameter (before `extensionUri`)
- Add `this.globalState = globalState;` in the constructor body

**Step 2: Update extension.ts to pass globalState**

In `src/extension.ts` line 137, update the ChatViewProvider constructor call to pass `context.globalState` as the first argument:

```typescript
const chatViewProvider = new ChatViewProvider(
  context.globalState,
  context.extensionUri,
  // ... rest of args unchanged
);
```

**Step 3: Compile to verify**

Run: `npm run compile`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/extension.ts src/webview/panel.ts
git commit -m "feat: pass globalState to ChatViewProvider for settings access"
```

---

### Task 3: Backend — Compaction Pause Mechanism + Message Handlers

**Files:**
- Modify: `src/webview/panel.ts`

**Step 1: Add compaction resolver field and import**

At the top of `panel.ts`, add the import:
```typescript
import { getCompactionSettings, saveCompactionSettings, CompactionSettings } from '../config/settings';
```

Add a field to ChatViewProvider after `private sandboxManager`:
```typescript
private compactionResolver: ((action: 'compacted' | 'cancelled') => void) | null = null;
```

**Step 2: Replace the auto-compaction block in the tool loop**

In the `while (keepLooping)` loop (around line 674-691), replace the existing auto-compaction block with:

```typescript
// ── Pre-overflow check: context compaction based on settings ──
const preCheckUsage = this.sessionManager.getTokenUsage(sessionId);
const contextLimit = await this.getActiveContextWindow();
const totalUsed = preCheckUsage.inputTokens + preCheckUsage.outputTokens;
if (contextLimit > 0 && totalUsed > contextLimit * ChatViewProvider.CONTEXT_COMPACTION_THRESHOLD && toolIteration > 0) {
  const settings = getCompactionSettings(this.globalState);
  const percentage = Math.round((totalUsed / contextLimit) * 100);

  if (settings.method === 'automatic') {
    // Current behavior: compact immediately
    this.postSessionMessage(sessionId, {
      type: 'streamChunk',
      content: '\n\n⚠️ *Context usage at ' + percentage + '% — auto-compacting to avoid overflow...*\n',
    });
    await this.performCompaction(sessionId);
  } else {
    // Semi-automatic or manual: pause and wait for user action
    const digest = this.buildConversationDigest(sessionId);

    if (settings.method === 'semi-automatic') {
      this.postSessionMessage(sessionId, {
        type: 'compactionCountdown',
        timeout: settings.timeoutSeconds,
        digest,
        percentage,
      });
    } else {
      // manual
      this.postSessionMessage(sessionId, {
        type: 'compactionPending',
        digest,
        percentage,
      });
    }

    // Pause: wait for user action
    const action = await new Promise<'compacted' | 'cancelled'>((resolve) => {
      this.compactionResolver = resolve;
    });
    this.compactionResolver = null;

    if (action === 'cancelled') {
      // User cancelled — continue without compaction (risky but their choice)
      this.postSessionMessage(sessionId, {
        type: 'compactionComplete',
      });
      // Skip the rest of the compaction block, continue tool loop
      const compactedHistory = this.sessionManager.getHistory(sessionId);
      messages.length = 0;
      messages.push({ role: 'system', content: modePrompt });
      messages.push(...compactedHistory);
      messages.push({ role: 'user', content: 'Continue from where you left off. Here is what was happening: you were in tool iteration ' + toolIteration + ' of an ongoing task.' });
      this.sendContextUsage(sessionId);
      continue;
    }
  }

  // Rebuild messages from compacted history
  const compactedHistory = this.sessionManager.getHistory(sessionId);
  messages.length = 0;
  messages.push({ role: 'system', content: modePrompt });
  messages.push(...compactedHistory);
  messages.push({ role: 'user', content: 'Continue from where you left off. Here is what was happening: you were in tool iteration ' + toolIteration + ' of an ongoing task.' });
  this.sendContextUsage(sessionId);
}
```

**Step 3: Add buildConversationDigest helper method**

Extract the digest-building logic from `performCompaction` into a reusable method. Add this method near `performCompaction`:

```typescript
private buildConversationDigest(sessionId: string): string {
  const history = this.sessionManager.getHistory(sessionId);
  return history
    .filter(m => !m.internal || m.content.includes('[Compacted conversation context]'))
    .map(m => {
      let prefix = m.role.toUpperCase();
      if (m.toolCalls?.length) { prefix += ' (with tool calls: ' + m.toolCalls.map(tc => tc.name).join(', ') + ')'; }
      if (m.toolResults?.length) { prefix += ' (tool results)'; }
      return `[${prefix}]: ${m.content.slice(0, 2000)}`;
    })
    .join('\n\n');
}
```

Update `performCompaction` to use `buildConversationDigest` instead of inline logic.

**Step 4: Add a new `performCompactionWithDigest` method**

This handles compaction with a user-edited digest:

```typescript
private async performCompactionWithDigest(sessionId: string, editedDigest: string): Promise<void> {
  const provider = this.registry.getActiveProvider();
  if (!provider) { return; }

  try {
    const model = this.registry.getActiveModelId();
    const summaryResponse = await provider.sendMessage(
      [
        { role: 'system', content: ChatViewProvider.COMPACTION_PROMPT },
        { role: 'user', content: `Here is the conversation to summarize:\n\n${editedDigest}` },
      ],
      { model, maxTokens: 2048 },
      () => {}
    );

    const summary = summaryResponse.content || 'No summary generated.';
    this.sessionManager.compactHistory(sessionId, summary);

    this.postSessionMessage(sessionId, {
      type: 'streamChunk',
      content: '\n\n✅ *Context compacted successfully.*\n',
    });
  } catch (err) {
    this.postSessionMessage(sessionId, {
      type: 'streamChunk',
      content: '\n\n⚠️ *Context compaction failed: ' + (err instanceof Error ? err.message : String(err)) + '*\n',
    });
  }
}
```

**Step 5: Add message handlers in the webview message switch**

Add these cases in the `webviewView.webview.onDidReceiveMessage` handler (near the existing `compactContext` case):

```typescript
case 'compactNow': {
  const activeId = this.sessionManager.getActiveSessionId();
  if (activeId) {
    await this.performCompaction(activeId);
    this.sendContextUsage(activeId);
    this.postSessionMessage(activeId, { type: 'compactionComplete' });
  }
  if (this.compactionResolver) {
    this.compactionResolver('compacted');
  }
  break;
}
case 'compactWithDigest': {
  const activeId = this.sessionManager.getActiveSessionId();
  if (activeId && message.editedDigest) {
    await this.performCompactionWithDigest(activeId, message.editedDigest);
    this.sendContextUsage(activeId);
    this.postSessionMessage(activeId, { type: 'compactionComplete' });
  }
  if (this.compactionResolver) {
    this.compactionResolver('compacted');
  }
  break;
}
case 'compactCancel':
  if (this.compactionResolver) {
    this.compactionResolver('cancelled');
  }
  break;
case 'getCompactionSettings':
  this.postMessage({
    type: 'compactionSettings',
    ...getCompactionSettings(this.globalState),
  });
  break;
case 'saveCompactionSettings':
  await saveCompactionSettings(this.globalState, {
    method: message.method,
    timeoutSeconds: message.timeoutSeconds,
  });
  this.postMessage({
    type: 'compactionSettings',
    ...getCompactionSettings(this.globalState),
  });
  break;
```

**Step 6: Compile to verify**

Run: `npm run compile`
Expected: Clean build

**Step 7: Commit**

```bash
git add src/webview/panel.ts
git commit -m "feat: add compaction pause mechanism and message handlers"
```

---

### Task 4: HTML — Digest Editor View + General Settings Tab

**Files:**
- Modify: `src/webview/panel.ts` (the `getHtmlContent` method)

**Step 1: Add the digest editor view HTML**

Add this block after the `<!-- Sessions Drawer -->` section (before `<!-- Settings: Provider List -->`):

```html
<!-- Digest Editor (compaction) -->
<div id="digest-view" class="hidden">
  <div id="digest-header">
    <button id="digest-back-btn" title="Cancel compaction">&#x2190;</button>
    <span class="header-title">Edit Context Before Compaction</span>
  </div>
  <div id="digest-content">
    <p class="digest-hint">Edit the conversation digest below. The AI will summarize this into a compact context.</p>
    <textarea id="digest-textarea" spellcheck="false"></textarea>
    <div class="digest-actions">
      <button id="digest-compact-btn" class="primary-btn">Compact This</button>
      <button id="digest-cancel-btn" class="secondary-btn">Cancel</button>
    </div>
  </div>
</div>
```

**Step 2: Add the compaction countdown banner HTML**

Add this inside the chat view area, just before the `<div id="input-area">` element:

```html
<div id="compaction-banner" class="compaction-banner hidden">
  <span id="compaction-banner-text"></span>
  <div class="compaction-banner-actions">
    <button id="compaction-edit-btn" class="secondary-btn btn-sm">Edit Context</button>
    <button id="compaction-now-btn" class="primary-btn btn-sm">Compact Now</button>
  </div>
</div>
```

Note: The banner text content is set via `textContent` in `main.js`, not via HTML template. This avoids XSS. The `main.js` functions `startCompactionCountdown` and `showCompactionPending` will build the text using safe DOM methods (see Task 5).

**Step 3: Add the General tab to Settings**

In the `<!-- Settings: Provider List -->` section, add a third tab button:

Change the settings tabs div to:
```html
<div id="settings-tabs">
  <button id="tab-providers" class="tab-btn active">Providers</button>
  <button id="tab-mcp" class="tab-btn">MCP Servers</button>
  <button id="tab-general" class="tab-btn">General</button>
</div>
```

Add a General panel inside `<div id="settings-content">`, after the `mcp-panel`:

```html
<div id="general-panel" class="hidden">
  <div class="settings-section">
    <h3>Context Compaction</h3>
    <div class="form-group">
      <label>Compaction Method</label>
      <div class="radio-group" id="compaction-method-group">
        <label class="radio-label">
          <input type="radio" name="compaction-method" value="semi-automatic" checked>
          <span>Semi-automatic with timeout</span>
          <span class="radio-description">Waits for you to manually edit context; auto-compacts if no response</span>
        </label>
        <label class="radio-label">
          <input type="radio" name="compaction-method" value="automatic">
          <span>Automatic (immediate)</span>
          <span class="radio-description">Immediately summarizes context automatically</span>
        </label>
        <label class="radio-label">
          <input type="radio" name="compaction-method" value="manual">
          <span>Manual</span>
          <span class="radio-description">Only manual edits will resume the agent</span>
        </label>
      </div>
    </div>
    <div class="form-group" id="timeout-group">
      <label for="compaction-timeout">Automatic compaction timeout (seconds)</label>
      <input type="number" id="compaction-timeout" min="10" max="300" value="60" step="5">
    </div>
  </div>
</div>
```

**Step 4: Compile to verify**

Run: `npm run compile`
Expected: Clean build

**Step 5: Commit**

```bash
git add src/webview/panel.ts
git commit -m "feat: add HTML for digest editor, countdown banner, and General settings tab"
```

---

### Task 5: Frontend Logic — Countdown, Digest Editor, General Tab

**Files:**
- Modify: `src/webview/ui/main.js`

**Step 1: Add the digest view to the view router**

At the top with the other view elements, add:
```javascript
const digestView = document.getElementById('digest-view');
```

Update `currentView` type comment to include `'digest'`.

In `showView()`, add:
```javascript
digestView.classList.toggle('hidden', view !== 'digest');
```

**Step 2: Add element references for new UI**

```javascript
// ===== Compaction Banner Elements =====
const compactionBanner = document.getElementById('compaction-banner');
const compactionBannerText = document.getElementById('compaction-banner-text');
const compactionEditBtn = document.getElementById('compaction-edit-btn');
const compactionNowBtn = document.getElementById('compaction-now-btn');

// ===== Digest Editor Elements =====
const digestBackBtn = document.getElementById('digest-back-btn');
const digestTextarea = document.getElementById('digest-textarea');
const digestCompactBtn = document.getElementById('digest-compact-btn');
const digestCancelBtn = document.getElementById('digest-cancel-btn');

// ===== General Settings Elements =====
const tabGeneral = document.getElementById('tab-general');
const generalPanel = document.getElementById('general-panel');
const compactionMethodGroup = document.getElementById('compaction-method-group');
const compactionTimeoutInput = document.getElementById('compaction-timeout');
const timeoutGroup = document.getElementById('timeout-group');
```

**Step 3: Add countdown timer state and logic**

Uses safe DOM methods (textContent) instead of innerHTML to prevent XSS:

```javascript
// ===== Compaction Countdown State =====
let compactionTimer = null;
let compactionDigest = '';

function startCompactionCountdown(timeout, digest, percentage) {
  compactionDigest = digest;
  compactionBannerText.textContent = 'Context at ' + percentage + '% \u2014 auto-compacting in ' + timeout + 's...';
  compactionBanner.classList.remove('hidden');

  let remaining = timeout;
  compactionTimer = setInterval(() => {
    remaining--;
    compactionBannerText.textContent = 'Context at ' + percentage + '% \u2014 auto-compacting in ' + remaining + 's...';
    if (remaining <= 0) {
      clearCompactionCountdown();
      vscode.postMessage({ type: 'compactNow' });
    }
  }, 1000);
}

function clearCompactionCountdown() {
  if (compactionTimer) {
    clearInterval(compactionTimer);
    compactionTimer = null;
  }
  compactionBanner.classList.add('hidden');
}

function showCompactionPending(digest, percentage) {
  compactionDigest = digest;
  compactionBannerText.textContent = 'Context at ' + percentage + '% \u2014 waiting for manual compaction...';
  compactionBanner.classList.remove('hidden');
}
```

**Step 4: Add event listeners for compaction banner**

```javascript
compactionEditBtn.addEventListener('click', () => {
  clearCompactionCountdown();
  digestTextarea.value = compactionDigest;
  showView('digest');
});

compactionNowBtn.addEventListener('click', () => {
  clearCompactionCountdown();
  vscode.postMessage({ type: 'compactNow' });
});
```

**Step 5: Add event listeners for digest editor**

```javascript
digestBackBtn.addEventListener('click', () => {
  showView('chat');
  vscode.postMessage({ type: 'compactCancel' });
});

digestCancelBtn.addEventListener('click', () => {
  showView('chat');
  vscode.postMessage({ type: 'compactCancel' });
});

digestCompactBtn.addEventListener('click', () => {
  const editedDigest = digestTextarea.value;
  showView('chat');
  vscode.postMessage({ type: 'compactWithDigest', editedDigest });
});
```

**Step 6: Add General settings tab wiring**

```javascript
tabGeneral.addEventListener('click', () => {
  tabGeneral.classList.add('active');
  tabProviders.classList.remove('active');
  tabMcp.classList.remove('active');
  generalPanel.classList.remove('hidden');
  providersPanel.classList.add('hidden');
  mcpPanel.classList.add('hidden');
  vscode.postMessage({ type: 'getCompactionSettings' });
});
```

Update existing tab click handlers to also hide generalPanel and deactivate the General tab:
- In `tabProviders` click handler, add: `tabGeneral.classList.remove('active'); generalPanel.classList.add('hidden');`
- In `tabMcp` click handler, add: `tabGeneral.classList.remove('active'); generalPanel.classList.add('hidden');`

```javascript
// Compaction method radio change
compactionMethodGroup.addEventListener('change', (e) => {
  const method = e.target.value;
  timeoutGroup.style.display = method === 'semi-automatic' ? '' : 'none';
  vscode.postMessage({
    type: 'saveCompactionSettings',
    method,
    timeoutSeconds: parseInt(compactionTimeoutInput.value, 10) || 60,
  });
});

// Timeout input change
compactionTimeoutInput.addEventListener('change', () => {
  const selectedMethod = compactionMethodGroup.querySelector('input[name="compaction-method"]:checked');
  vscode.postMessage({
    type: 'saveCompactionSettings',
    method: selectedMethod ? selectedMethod.value : 'semi-automatic',
    timeoutSeconds: parseInt(compactionTimeoutInput.value, 10) || 60,
  });
});
```

**Step 7: Add message handlers in the message listener switch**

```javascript
case 'compactionCountdown':
  startCompactionCountdown(message.timeout, message.digest, message.percentage);
  break;
case 'compactionPending':
  showCompactionPending(message.digest, message.percentage);
  break;
case 'compactionComplete':
  clearCompactionCountdown();
  compactionBanner.classList.add('hidden');
  if (currentView === 'digest') {
    showView('chat');
  }
  break;
case 'compactionSettings': {
  const methodRadio = compactionMethodGroup.querySelector(
    'input[value="' + message.method + '"]'
  );
  if (methodRadio) { methodRadio.checked = true; }
  compactionTimeoutInput.value = message.timeoutSeconds || 60;
  timeoutGroup.style.display = message.method === 'semi-automatic' ? '' : 'none';
  break;
}
```

**Step 8: Compile to verify**

Run: `npm run compile`
Expected: Clean build

**Step 9: Commit**

```bash
git add src/webview/ui/main.js
git commit -m "feat: add countdown timer, digest editor, and General tab frontend logic"
```

---

### Task 6: Styles

**Files:**
- Modify: `src/webview/ui/styles.css`

**Step 1: Add compaction banner styles**

```css
/* ===== Compaction Banner ===== */
.compaction-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--vscode-editorWarning-foreground, #cca700)20;
  border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
  border-radius: 4px;
  margin: 0 8px 8px;
  font-size: 12px;
  gap: 8px;
}

.compaction-banner-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn-sm {
  padding: 2px 8px;
  font-size: 11px;
}
```

**Step 2: Add digest editor styles**

```css
/* ===== Digest Editor ===== */
#digest-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

#digest-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border, #333);
}

#digest-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 12px;
  overflow: hidden;
}

.digest-hint {
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #888);
  margin: 0;
}

#digest-textarea {
  flex: 1;
  resize: none;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  padding: 8px;
  background: var(--vscode-input-background, #1e1e1e);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #333);
  border-radius: 4px;
}

.digest-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
```

**Step 3: Add General settings panel styles**

```css
/* ===== General Settings ===== */
.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.radio-label {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
}

.radio-label input[type="radio"] {
  margin: 0;
}

.radio-description {
  display: block;
  width: 100%;
  padding-left: 22px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #888);
}

.settings-section h3 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}
```

**Step 4: Compile to verify**

Run: `npm run compile`
Expected: Clean build

**Step 5: Commit**

```bash
git add src/webview/ui/styles.css
git commit -m "feat: add styles for compaction banner, digest editor, and General settings"
```

---

### Task 7: Integration Verification

**Step 1: Build the extension**

Run: `npm run compile`
Expected: Clean build, no errors

**Step 2: Manual testing checklist**

Launch the extension in VS Code Extension Development Host (`F5`) and verify:

1. **General settings tab**: Open Settings -> click "General" tab -> see compaction method radios and timeout input. Change method to "automatic" -> timeout field hides. Change back to "semi-automatic" -> timeout field shows. Close and reopen -> values persist.

2. **Automatic mode**: Set to "Automatic". Use the agent until context hits 80%. Should auto-compact immediately (original behavior).

3. **Semi-automatic mode**: Set to "Semi-automatic" with 15s timeout. Use the agent until context hits 80%. Should see countdown banner. Wait for countdown -> auto-compacts. Try again but click "Edit Context" -> digest editor opens with conversation text. Edit some text -> click "Compact This" -> returns to chat with compacted context.

4. **Manual mode**: Set to "Manual". Use the agent until context hits 80%. Should see persistent banner (no countdown). Click "Edit Context" -> edit -> "Compact This" -> resumes.

5. **Cancel behavior**: In digest editor, click "Cancel" -> returns to chat, agent resumes without compaction.

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for compaction controls"
```
