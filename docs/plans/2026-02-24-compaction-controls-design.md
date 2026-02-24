# Context Compaction Controls — Design

## Summary

Add user-controlled context compaction with three modes: semi-automatic (countdown + optional manual edit), automatic (immediate, current behavior), and manual (user must act). Settings live in a new "General" tab in the Settings view.

## Settings

- **compactionMethod**: `'semi-automatic' | 'automatic' | 'manual'` (default: `'semi-automatic'`)
- **compactionTimeout**: `number` in seconds (default: `60`), only relevant for semi-automatic
- Stored in `globalState` via new helpers in `config/settings.ts`

## Compaction Flow

When the 80% context threshold is hit mid-tool-loop:

1. **Automatic**: Compact immediately (current behavior unchanged).
2. **Semi-automatic**: Pause agent loop. Show countdown banner in chat. If countdown expires, compact automatically and resume. If user clicks "Edit Context", stop countdown and show digest editor.
3. **Manual**: Pause agent loop. Show persistent banner with "Edit & Compact" button. Agent stays paused until user acts.

Pause mechanism: a `Promise` that the `while (keepLooping)` loop awaits. Resolves when compaction finishes (by any path).

## Webview UI

### Countdown Banner
- Horizontal bar above the input area
- Shows: "Context is at X% — auto-compacting in **Ns**..."
- Buttons: "Edit Context" (opens editor), "Compact Now" (immediate)
- Timer via `setInterval` in `main.js`

### Digest Editor
- New view (like settings/sessions) replacing chat area temporarily
- `<textarea>` pre-filled with conversation digest (role-labeled message excerpts)
- Header: "Edit Context Before Compaction" + back arrow
- Buttons: "Compact This" (sends edited digest for LLM summarization), "Cancel" (abort, resume agent)

### Settings — General Tab
- Third tab in Settings alongside Providers and MCP Servers
- Radio buttons for compaction method
- Number input for timeout (shown only for semi-automatic)

## Message Protocol

| Direction | Type | Payload |
|-----------|------|---------|
| Backend → Webview | `compactionCountdown` | `{ timeout, digest, percentage }` |
| Backend → Webview | `compactionPending` | `{ digest, percentage }` (manual mode) |
| Backend → Webview | `compactionComplete` | `{}` |
| Webview → Backend | `compactWithDigest` | `{ editedDigest }` |
| Webview → Backend | `compactNow` | `{}` |
| Webview → Backend | `compactCancel` | `{}` |
| Backend ↔ Webview | `compactionSettings` | `{ method, timeout }` |

## File Changes

| File | Change |
|------|--------|
| `src/config/settings.ts` | `CompactionSettings` interface + read/write helpers |
| `src/webview/panel.ts` | Pause mechanism, new message handlers, HTML for digest editor + General tab |
| `src/webview/ui/main.js` | Countdown timer, digest editor view, General tab wiring |
| `src/webview/ui/styles.css` | Countdown banner, digest editor, General tab styles |

## Build Order

1. `config/settings.ts` — settings infrastructure
2. `panel.ts` — backend logic (pause + message handlers)
3. `panel.ts` — HTML additions (digest editor view, General tab)
4. `main.js` — frontend logic
5. `styles.css` — styling
