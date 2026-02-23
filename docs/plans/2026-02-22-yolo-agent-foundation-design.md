# YOLO Agent — VS Code Extension Foundation Design

## Overview

A standalone VS Code extension that provides a coding agent powered by multiple AI providers. Features a custom sidebar chat UI, per-provider SDK integration, and working coding tools.

## Architecture

### Provider Layer

Common interface all providers implement:

```typescript
interface LLMProvider {
  id: string;
  name: string;
  sendMessage(messages: ChatMessage[], options: RequestOptions, onChunk: (chunk: string) => void): Promise<LLMResponse>;
  listModels(): Promise<ModelInfo[]>;
  validateApiKey(key: string): Promise<boolean>;
}
```

Three concrete providers:
- **AnthropicProvider** — `@anthropic-ai/sdk`, native Claude support
- **OpenAIProvider** — `openai` SDK, native GPT support
- **OpenAICompatibleProvider** — `openai` SDK with custom `baseURL` for Kilo Code Gateway, Z.ai, and any compatible endpoint

**ProviderRegistry** manages registration, switching, and API key storage via VS Code SecretStorage.

### Coding Tools

Each tool has a `definition` (JSON schema for the LLM) and an `execute` method:

1. **readFile** — `vscode.workspace.fs.readFile`, optional line range
2. **writeFile** — `vscode.workspace.fs.writeFile`, with diff preview
3. **runTerminal** — Shell command execution via VS Code terminal + shell integration
4. **listFiles** — `vscode.workspace.findFiles` with glob patterns

### Webview Sidebar UI

- Provider/model selector dropdown
- Message list with markdown + syntax-highlighted code blocks
- Streaming via `postMessage` chunks
- Collapsible tool call cards
- VS Code theme-aware styling via CSS variables

### Communication Protocol

Webview -> Extension: `sendMessage`, `switchProvider`, `cancelRequest`, `getProviders`
Extension -> Webview: `streamChunk`, `toolCallStarted`, `toolCallResult`, `messageComplete`, `error`

## Project Structure

```
yolo-agent/
├── package.json
├── tsconfig.json
├── .vscodeignore
├── esbuild.js
├── src/
│   ├── extension.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── openai-compatible.ts
│   │   └── registry.ts
│   ├── tools/
│   │   ├── types.ts
│   │   ├── file-ops.ts
│   │   ├── terminal.ts
│   │   └── diagnostics.ts
│   ├── webview/
│   │   ├── panel.ts
│   │   └── ui/
│   │       ├── index.html
│   │       ├── main.js
│   │       └── styles.css
│   └── config/
│       └── settings.ts
├── test/
│   └── e2e/
│       └── extension.test.ts
└── media/
    └── icon.png
```

## E2E Tests

Using `@vscode/test-electron`:
1. Extension activates successfully
2. Provider registry loads all built-in providers
3. API keys stored/retrieved via SecretStorage
4. Tools execute against real temp workspace files
5. Webview sidebar loads without errors
6. Message round-trip with mocked LLM responses

## Settings Schema

```json
{
  "yoloAgent.providers": {
    "anthropic": { "enabled": true },
    "openai": { "enabled": true },
    "custom": [
      { "name": "Kilo Code Gateway", "baseUrl": "https://...", "enabled": true }
    ]
  }
}
```

API keys stored in VS Code SecretStorage (encrypted, per-machine).
