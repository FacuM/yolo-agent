import * as vscode from 'vscode';
import { LLMProvider, ModelInfo } from './types';
import { ProfileManager, ProviderProfile } from './profile-manager';
import { AnthropicProvider } from './anthropic';
import { ClaudeCodeProvider } from './claude-code';
import { OpenAIProvider } from './openai';
import { OpenAICompatibleProvider } from './openai-compatible';
import { KiloGatewayProvider } from './kilo-gateway';

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private profileManager: ProfileManager;
  private globalState: vscode.Memento;
  private activeProviderId: string | null = null;
  private activeModelOverride: string | null = null;

  private static readonly STATE_PROVIDER_KEY = 'activeProviderId';
  private static readonly STATE_MODEL_KEY = 'activeModelId';

  private readonly _onDidChangeProviders = new vscode.EventEmitter<void>();
  readonly onDidChangeProviders = this._onDidChangeProviders.event;

  constructor(profileManager: ProfileManager, globalState: vscode.Memento) {
    this.profileManager = profileManager;
    this.globalState = globalState;

    // Re-initialize when profiles change
    profileManager.onDidChangeProfiles(() => {
      this.initialize();
    });
  }

  async initialize(): Promise<void> {
    this.providers.clear();

    const profiles = this.profileManager.getProfiles();

    for (const profile of profiles) {
      if (!profile.enabled) { continue; }

      const provider = this.createProvider(profile);
      if (!provider) { continue; }

      const apiKey = await this.profileManager.getApiKey(profile.id);
      if (apiKey && 'setApiKey' in provider) {
        (provider as { setApiKey(key: string): void }).setApiKey(apiKey);
      }

      this.providers.set(profile.id, provider);
    }

    // Restore persisted provider, fall back to first available
    const savedProviderId = this.globalState.get<string>(ProviderRegistry.STATE_PROVIDER_KEY);
    if (savedProviderId && this.providers.has(savedProviderId)) {
      this.activeProviderId = savedProviderId;
    } else if (this.activeProviderId && !this.providers.has(this.activeProviderId)) {
      this.activeProviderId = null;
    }
    if (!this.activeProviderId) {
      const firstId = this.providers.keys().next().value;
      this.activeProviderId = firstId ?? null;
    }

    // Restore persisted model override
    const savedModelId = this.globalState.get<string>(ProviderRegistry.STATE_MODEL_KEY);
    if (savedModelId && !this.activeModelOverride) {
      this.activeModelOverride = savedModelId;
    }

    this._onDidChangeProviders.fire();
  }

  private createProvider(profile: ProviderProfile): LLMProvider | null {
    switch (profile.apiKind) {
      case 'anthropic': {
        const p = new AnthropicProvider();
        return p;
      }
      case 'openai': {
        const p = new OpenAIProvider();
        return p;
      }
      case 'openai-compatible': {
        if (!profile.baseUrl) { return null; }
        return new OpenAICompatibleProvider(
          profile.id,
          profile.name,
          profile.baseUrl
        );
      }
      case 'claude-code': {
        return new ClaudeCodeProvider();
      }
      case 'kilo-gateway': {
        return new KiloGatewayProvider();
      }
      default:
        return null;
    }
  }

  getProvider(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  getActiveProvider(): LLMProvider | undefined {
    if (!this.activeProviderId) { return undefined; }
    return this.providers.get(this.activeProviderId);
  }

  getActiveProviderId(): string | null {
    return this.activeProviderId;
  }

  getActiveModelId(): string {
    if (this.activeModelOverride) { return this.activeModelOverride; }
    if (!this.activeProviderId) { return ''; }
    const profile = this.profileManager.getProfile(this.activeProviderId);
    return profile?.modelId ?? '';
  }

  setActiveModelId(modelId: string): void {
    this.activeModelOverride = modelId;
    this.globalState.update(ProviderRegistry.STATE_MODEL_KEY, modelId);
    this._onDidChangeProviders.fire();
  }

  setActiveProvider(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Provider "${id}" not found`);
    }
    this.activeProviderId = id;
    this.activeModelOverride = null;
    this.globalState.update(ProviderRegistry.STATE_PROVIDER_KEY, id);
    this.globalState.update(ProviderRegistry.STATE_MODEL_KEY, undefined);
    this._onDidChangeProviders.fire();
  }

  getAllProviders(): { id: string; name: string }[] {
    return Array.from(this.providers.entries()).map(([id, p]) => ({
      id,
      name: p.name,
    }));
  }

  async getModelsForProvider(providerId: string): Promise<ModelInfo[]> {
    const provider = this.providers.get(providerId);
    if (!provider) { return []; }
    return provider.listModels();
  }

  /**
   * Temporarily creates a provider with the given API key to validate it.
   */
  async validateApiKey(
    apiKind: string,
    baseUrl: string,
    apiKey: string
  ): Promise<boolean> {
    const tempProfile: ProviderProfile = {
      id: 'temp-validation',
      name: 'Validation',
      apiKind: apiKind as ProviderProfile['apiKind'],
      baseUrl,
      modelId: '',
      enabled: true,
    };

    const provider = this.createProvider(tempProfile);
    if (!provider) { return false; }

    return provider.validateApiKey(apiKey);
  }

  /**
   * Temporarily creates a provider with the given API key to list models.
   */
  async listModelsWithKey(
    apiKind: string,
    baseUrl: string,
    apiKey: string
  ): Promise<ModelInfo[]> {
    const tempProfile: ProviderProfile = {
      id: 'temp-models',
      name: 'Models',
      apiKind: apiKind as ProviderProfile['apiKind'],
      baseUrl,
      modelId: '',
      enabled: true,
    };

    const provider = this.createProvider(tempProfile);
    if (!provider) { return []; }

    if ('setApiKey' in provider) {
      (provider as { setApiKey(key: string): void }).setApiKey(apiKey);
    }

    return provider.listModels();
  }

  dispose(): void {
    this._onDidChangeProviders.dispose();
  }
}
