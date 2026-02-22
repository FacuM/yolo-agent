import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

export type ApiKind = 'anthropic' | 'openai' | 'openai-compatible' | 'claude-code' | 'kilo-gateway';

export interface ProviderProfile {
  id: string;
  name: string;
  apiKind: ApiKind;
  baseUrl: string;
  modelId: string;
  enabled: boolean;
}

export interface ProviderProfileWithStatus extends ProviderProfile {
  hasApiKey: boolean;
}

const PROFILES_KEY = 'yoloAgent.profiles';
const API_KEY_PREFIX = 'yoloAgent.apiKey.';

const DEFAULT_BASE_URLS: Record<ApiKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  'openai-compatible': '',
  'claude-code': 'https://api.anthropic.com',
  'kilo-gateway': 'https://api.kilo.ai/api/gateway',
};

export class ProfileManager {
  private globalState: vscode.Memento;
  private secretStorage: vscode.SecretStorage;

  private readonly _onDidChangeProfiles = new vscode.EventEmitter<void>();
  readonly onDidChangeProfiles = this._onDidChangeProfiles.event;

  constructor(globalState: vscode.Memento, secretStorage: vscode.SecretStorage) {
    this.globalState = globalState;
    this.secretStorage = secretStorage;
  }

  getProfiles(): ProviderProfile[] {
    return this.globalState.get<ProviderProfile[]>(PROFILES_KEY, []);
  }

  async getProfilesWithStatus(): Promise<ProviderProfileWithStatus[]> {
    const profiles = this.getProfiles();
    const result: ProviderProfileWithStatus[] = [];
    for (const profile of profiles) {
      const key = await this.secretStorage.get(API_KEY_PREFIX + profile.id);
      result.push({ ...profile, hasApiKey: !!key });
    }
    return result;
  }

  getProfile(id: string): ProviderProfile | undefined {
    return this.getProfiles().find((p) => p.id === id);
  }

  async saveProfile(
    data: Omit<ProviderProfile, 'id'> & { id?: string },
    apiKey?: string
  ): Promise<ProviderProfile> {
    const profiles = this.getProfiles();
    let profile: ProviderProfile;

    if (data.id) {
      // Update existing
      const index = profiles.findIndex((p) => p.id === data.id);
      if (index === -1) {
        throw new Error(`Profile "${data.id}" not found`);
      }
      profile = { ...data, id: data.id };
      profiles[index] = profile;
    } else {
      // Create new
      profile = { ...data, id: randomUUID() };
      profiles.push(profile);
    }

    await this.globalState.update(PROFILES_KEY, profiles);

    if (apiKey !== undefined) {
      await this.secretStorage.store(API_KEY_PREFIX + profile.id, apiKey);
    }

    this._onDidChangeProfiles.fire();
    return profile;
  }

  async deleteProfile(id: string): Promise<void> {
    const profiles = this.getProfiles().filter((p) => p.id !== id);
    await this.globalState.update(PROFILES_KEY, profiles);
    await this.secretStorage.delete(API_KEY_PREFIX + id);
    this._onDidChangeProfiles.fire();
  }

  async getApiKey(profileId: string): Promise<string | undefined> {
    return this.secretStorage.get(API_KEY_PREFIX + profileId);
  }

  async setApiKey(profileId: string, apiKey: string): Promise<void> {
    await this.secretStorage.store(API_KEY_PREFIX + profileId, apiKey);
    this._onDidChangeProfiles.fire();
  }

  getDefaultBaseUrl(apiKind: ApiKind): string {
    return DEFAULT_BASE_URLS[apiKind];
  }

  isBaseUrlEditable(apiKind: ApiKind): boolean {
    return apiKind === 'openai-compatible';
  }

  dispose(): void {
    this._onDidChangeProfiles.dispose();
  }
}
