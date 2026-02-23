# Settings & API Manager Design

## Overview

Built-in settings panel and API manager within the webview sidebar. Users manage provider profiles visually — adding custom names, selecting API kinds, setting base URLs and API keys, for as many providers as they want.

## Data Model

```typescript
interface ProviderProfile {
  id: string;           // UUID
  name: string;         // User-chosen display name
  apiKind: 'anthropic' | 'openai' | 'openai-compatible';
  baseUrl: string;      // Pre-filled per kind, editable for openai-compatible
  modelId: string;      // Selected modelkz
  enabled: boolean;
}
```

- Profile metadata: `context.globalState` under key `yoloAgent.profiles`
- API keys: `context.secrets` under key `yoloAgent.apiKey.<profile.id>`
- No built-in templates — all profiles are user-created and equal

## UI

### Navigation
- Gear icon in chat header opens settings (replaces chat view)
- Back arrow returns to chat

### Settings Screen 1: Provider List
- Provider cards: name, API kind badge, has-key status dot, edit/delete buttons
- "+ Add Provider" button
- Empty state when no providers

### Settings Screen 2: Provider Editor
- Fields: Name, API Kind dropdown, Base URL (locked for anthropic/openai), API Key (password), Model dropdown
- Save/Cancel buttons, Delete with confirmation (edit mode only)

## Message Protocol

Webview -> Extension: getProfiles, saveProfile, deleteProfile, validateApiKey, getModelsForProfile
Extension -> Webview: profiles, profileSaved, profileDeleted, validationResult, modelsForProfile

## Architecture Changes

- New `ProfileManager` class handles CRUD on globalState + SecretStorage
- `ProviderRegistry.initialize()` reads from ProfileManager instead of settings.json
- Old `yoloAgent.providers.*` config properties removed from package.json
- Webview gets view router: chat | settings | editor
