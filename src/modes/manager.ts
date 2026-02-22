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
    // State loading deferred to initialize()
  }

  /**
   * Initialize the manager by loading persisted state.
   * Call this after construction to ensure state is loaded.
   */
  async initialize(): Promise<void> {
    try {
      // Load current mode
      const savedMode = this.context.globalState.get<ModeId>('currentMode', DEFAULT_MODE);
      this.currentModeId = savedMode;

      // Load custom modes
      const savedCustomModes = this.context.globalState.get<CustomMode[]>('customModes', []);
      for (const modeData of savedCustomModes) {
        this.customModes.set(modeData.id, modeData);
      }
    } catch (err) {
      console.error('ModeManager: Failed to load state', err);
    }
  }

  getCurrentMode(): Mode {
    if (this.currentModeId === 'custom' && this.customModes.has('custom')) {
      return this.customModes.get('custom')!;
    }
    return BUILT_IN_MODES[this.currentModeId as keyof typeof BUILT_IN_MODES] || BUILT_IN_MODES.agent;
  }

  async setCurrentMode(modeId: ModeId) {
    if (modeId !== this.currentModeId) {
      this.currentModeId = modeId;
      try {
        await this.context.globalState.update('currentMode', modeId);
      } catch (err) {
        console.error('ModeManager: Failed to save current mode', err);
      }
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
    try {
      await this.context.globalState.update('customModes', allCustomModes);
    } catch (err) {
      console.error('ModeManager: Failed to save custom mode', err);
    }
    this._onDidChangeCustomModes.fire();
  }

  async deleteCustomMode(modeId: 'custom') {
    if (this.customModes.has(modeId)) {
      this.customModes.delete(modeId);
      const allCustomModes = Array.from(this.customModes.values());
      try {
        await this.context.globalState.update('customModes', allCustomModes);
      } catch (err) {
        console.error('ModeManager: Failed to delete custom mode', err);
      }

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
      if (mode.isBuiltIn) {
        const permission = mode.toolPermissions[name] || 'deny';
        return permission !== 'deny';
      } else {
        // Custom mode uses allow/deny lists
        if (mode.toolDenyList.includes(name)) {
          return false;
        }
        if (mode.toolAllowList.length === 0) {
          return true; // Empty allow list means all tools allowed
        }
        return mode.toolAllowList.includes(name);
      }
    });
  }

  /**
   * Get the system prompt for the current mode
   */
  getSystemPrompt(): string {
    return this.getCurrentMode().systemPrompt;
  }

  dispose() {
    this._onDidChangeMode.dispose();
    this._onDidChangeCustomModes.dispose();
  }
}
