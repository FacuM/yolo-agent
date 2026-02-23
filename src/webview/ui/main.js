// @ts-check

(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // Constants
  const ICON_PLAY = '\u25B6';  // ▶ Play/expand icon
  const STATUS_RUNNING = 'running...';
  const STATUS_ERROR = 'error';
  const STATUS_DONE = 'done';
  const STATUS_OPACITY = '0.6';
  const HANDLER_PROPERTY = '_yoloAgent_toggleHandler';

  // ===== View Router =====
  const chatView = document.getElementById('chat-view');
  const settingsView = document.getElementById('settings-view');
  const editorView = document.getElementById('editor-view');
  const contextView = document.getElementById('context-view');
  const mcpView = document.getElementById('mcp-view');
  const mcpEditorView = document.getElementById('mcp-editor-view');
  const sessionsView = document.getElementById('sessions-view');

  let currentView = 'chat'; // 'chat' | 'settings' | 'editor' | 'context' | 'mcp' | 'mcp-editor' | 'sessions'

  function showView(view) {
    currentView = view;
    chatView.classList.toggle('hidden', view !== 'chat');
    settingsView.classList.toggle('hidden', view !== 'settings');
    editorView.classList.toggle('hidden', view !== 'editor');
    contextView.classList.toggle('hidden', view !== 'context');
    mcpView.classList.toggle('hidden', view !== 'mcp');
    mcpEditorView.classList.toggle('hidden', view !== 'mcp-editor');
    sessionsView.classList.toggle('hidden', view !== 'sessions');
  }

  // ===== Chat View Elements =====
  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('message-input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send-btn'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stop-btn'));
  const apiSpinner = document.getElementById('api-spinner');
  const modePickerBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mode-picker-btn'));
  const modeDropdown = /** @type {HTMLDivElement} */ (document.getElementById('mode-dropdown'));
  const providerSelect = /** @type {HTMLSelectElement} */ (document.getElementById('provider-select'));
  // Model picker autocomplete elements
  const modelInput = /** @type {HTMLInputElement} */ (document.getElementById('model-input'));
  const modelDropdown = /** @type {HTMLDivElement} */ (document.getElementById('model-dropdown'));
  let modelList = []; // All available models: { id, name }
  let activeModelId = ''; // Currently selected model id
  let modelDropdownActiveIndex = -1; // Keyboard navigation index
  const newChatBtn = document.getElementById('new-chat-btn');
  const sessionsBtn = document.getElementById('sessions-btn');
  const sessionsBackBtn = document.getElementById('sessions-back-btn');
  const sessionsList = document.getElementById('sessions-list');
  const contextBtn = document.getElementById('context-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const currentModeDisplay = document.getElementById('current-mode-display');
  const activeFileToggle = document.getElementById('active-file-toggle');
  const activeFileDisplay = document.getElementById('active-file-display');
  const queueSection = document.getElementById('queue-section');
  const queueList = document.getElementById('queue-list');
  const queueCount = document.getElementById('queue-count');
  const fileChips = document.getElementById('file-chips');
  const autocompleteDropdown = document.getElementById('autocomplete-dropdown');

  // ===== Sandbox Activity Elements =====
  const sandboxActivity = document.getElementById('sandbox-activity');
  const sandboxBranchName = document.getElementById('sandbox-branch-name');
  const sandboxFileList = document.getElementById('sandbox-file-list');

  // ===== Sandbox Result Elements =====
  const sandboxResult = document.getElementById('sandbox-result');
  const sandboxResultBranch = document.getElementById('sandbox-result-branch');
  const sandboxResultFiles = document.getElementById('sandbox-result-files');
  const sandboxResultSummary = document.getElementById('sandbox-result-summary');
  const sandboxApplyBtn = document.getElementById('sandbox-apply-btn');
  const sandboxDiscardBtn = document.getElementById('sandbox-discard-btn');
  const sandboxActionStatus = document.getElementById('sandbox-action-status');

  // ===== Settings View Elements =====
  const settingsBackBtn = document.getElementById('settings-back-btn');
  const profilesList = document.getElementById('profiles-list');
  const addProfileBtn = document.getElementById('add-profile-btn');

  // ===== Context View Elements =====
  const contextBackBtn = document.getElementById('context-back-btn');
  const contextSkillsList = document.getElementById('context-skills-list');
  const contextAgentsList = document.getElementById('context-agents-list');

  // ===== Editor View Elements =====
  const editorBackBtn = document.getElementById('editor-back-btn');
  const editorTitle = document.getElementById('editor-title');
  const profileNameInput = /** @type {HTMLInputElement} */ (document.getElementById('profile-name'));
  const profileApiKindSelect = /** @type {HTMLSelectElement} */ (document.getElementById('profile-api-kind'));
  const profileBaseUrlInput = /** @type {HTMLInputElement} */ (document.getElementById('profile-base-url'));
  const profileApiKeyInput = /** @type {HTMLInputElement} */ (document.getElementById('profile-api-key'));
  const toggleKeyBtn = document.getElementById('toggle-key-btn');
  const profileModelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('profile-model'));
  const refreshModelsBtn = document.getElementById('refresh-models-btn');
  const profileEnabledInput = /** @type {HTMLInputElement} */ (document.getElementById('profile-enabled'));
  const saveProfileBtn = document.getElementById('save-profile-btn');
  const cancelProfileBtn = document.getElementById('cancel-profile-btn');
  const deleteProfileArea = document.getElementById('delete-profile-area');
  const deleteProfileBtn = document.getElementById('delete-profile-btn');

  // ===== Settings Tabs =====
  const tabProviders = document.getElementById('tab-providers');
  const tabMcp = document.getElementById('tab-mcp');
  const providersPanel = document.getElementById('providers-panel');
  const mcpPanel = document.getElementById('mcp-panel');
  const mcpSettingsBtn = document.getElementById('mcp-settings-btn');
  const mcpServersInlineList = document.getElementById('mcp-servers-inline-list');

  // ===== MCP View Elements =====
  const mcpBackBtn = document.getElementById('mcp-back-btn');
  const mcpServersList = document.getElementById('mcp-servers-list');
  const addMcpServerBtn = document.getElementById('add-mcp-server-btn');

  // ===== MCP Editor Elements =====
  const mcpEditorBackBtn = document.getElementById('mcp-editor-back-btn');
  const mcpEditorTitle = document.getElementById('mcp-editor-title');
  const mcpNameInput = /** @type {HTMLInputElement} */ (document.getElementById('mcp-name'));
  const mcpTransportSelect = /** @type {HTMLSelectElement} */ (document.getElementById('mcp-transport'));
  const mcpStdioGroup = document.getElementById('mcp-stdio-group');
  const mcpSseGroup = document.getElementById('mcp-sse-group');
  const mcpCommandInput = /** @type {HTMLInputElement} */ (document.getElementById('mcp-command'));
  const mcpArgsInput = /** @type {HTMLInputElement} */ (document.getElementById('mcp-args'));
  const mcpUrlInput = /** @type {HTMLInputElement} */ (document.getElementById('mcp-url'));
  const mcpEnabledInput = /** @type {HTMLInputElement} */ (document.getElementById('mcp-enabled'));
  const testMcpBtn = document.getElementById('test-mcp-btn');
  const saveMcpBtn = document.getElementById('save-mcp-btn');
  const cancelMcpBtn = document.getElementById('cancel-mcp-btn');
  const deleteMcpArea = document.getElementById('delete-mcp-area');
  const deleteMcpBtn = document.getElementById('delete-mcp-btn');

  // ===== State =====
  let isStreaming = false;
  let currentAssistantEl = null;
  let currentAssistantText = '';
  let editingProfileId = null; // null = creating new, string = editing existing
  let profiles = [];
  let modes = [];
  let currentModeId = 'sandbox';
  let contextSkills = [];
  let contextAgentsMd = [];
  let mcpServers = [];
  let editingMcpServerId = null;
  let commandQueue = [];
  let activeFilePath = null;
  let activeFileEnabled = false;
  let abortController = null;
  let fileReferences = []; // Array of relative file paths attached via @
  let autocompleteActive = false;
  let autocompleteQuery = '';
  let autocompleteStartPos = -1;
  let autocompleteSelectedIndex = 0;
  let searchDebounceTimer = null;

  const DEFAULT_BASE_URLS = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    'openai-compatible': '',
  };

  // ===== Init =====
  showEmptyState();
  vscode.postMessage({ type: 'getProviders' });
  vscode.postMessage({ type: 'getModes' });
  vscode.postMessage({ type: 'getContext' });
  vscode.postMessage({ type: 'getMcpServers' });

  // ===== Chat Event Listeners =====
  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', (e) => {
    // Handle autocomplete navigation
    if (autocompleteActive) {
      const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, items.length - 1);
        updateAutocompleteSelection(items);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, 0);
        updateAutocompleteSelection(items);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = items[autocompleteSelectedIndex];
        if (selected) {
          selectAutocompleteItem(selected.dataset.path);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAutocomplete();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  providerSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'switchProvider', providerId: providerSelect.value });
  });

  // ── Model picker autocomplete logic ──

  function renderModelDropdown(filter) {
    modelDropdown.textContent = '';
    modelDropdownActiveIndex = -1;
    const query = (filter || '').toLowerCase();
    const filtered = query
      ? modelList.filter(m => (m.name || m.id).toLowerCase().includes(query) || m.id.toLowerCase().includes(query))
      : modelList;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-dropdown-empty';
      empty.textContent = query ? 'No matching models' : 'No models available';
      modelDropdown.appendChild(empty);
    } else {
      filtered.forEach((m, idx) => {
        const item = document.createElement('div');
        item.className = 'model-dropdown-item';
        if (m.id === activeModelId) { item.classList.add('selected'); }
        item.textContent = m.name || m.id;
        item.dataset.modelId = m.id;
        item.dataset.index = String(idx);
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // Prevent blur before selection
          selectModel(m.id, m.name || m.id);
        });
        modelDropdown.appendChild(item);
      });
    }
    modelDropdown.classList.remove('hidden');
  }

  function selectModel(id, displayName) {
    activeModelId = id;
    modelInput.value = displayName || id;
    modelDropdown.classList.add('hidden');
    vscode.postMessage({ type: 'switchModel', modelId: id });
  }

  function highlightDropdownItem(index) {
    const items = modelDropdown.querySelectorAll('.model-dropdown-item');
    items.forEach(el => el.classList.remove('active'));
    if (index >= 0 && index < items.length) {
      items[index].classList.add('active');
      items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  modelInput.addEventListener('focus', () => {
    renderModelDropdown(modelInput.value);
  });

  modelInput.addEventListener('input', () => {
    renderModelDropdown(modelInput.value);
  });

  modelInput.addEventListener('blur', () => {
    // Delay to let mousedown fire on dropdown items
    setTimeout(() => {
      modelDropdown.classList.add('hidden');
      // If input doesn't match current selection, restore the display name
      const current = modelList.find(m => m.id === activeModelId);
      if (current) {
        modelInput.value = current.name || current.id;
      } else if (activeModelId) {
        modelInput.value = activeModelId;
      }
    }, 150);
  });

  modelInput.addEventListener('keydown', (e) => {
    const items = modelDropdown.querySelectorAll('.model-dropdown-item');
    if (modelDropdown.classList.contains('hidden')) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        renderModelDropdown(modelInput.value);
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      modelDropdownActiveIndex = Math.min(modelDropdownActiveIndex + 1, items.length - 1);
      highlightDropdownItem(modelDropdownActiveIndex);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      modelDropdownActiveIndex = Math.max(modelDropdownActiveIndex - 1, 0);
      highlightDropdownItem(modelDropdownActiveIndex);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (modelDropdownActiveIndex >= 0 && modelDropdownActiveIndex < items.length) {
        const el = items[modelDropdownActiveIndex];
        selectModel(el.dataset.modelId, el.textContent);
      } else if (items.length === 1) {
        // Auto-select sole match
        selectModel(items[0].dataset.modelId, items[0].textContent);
      }
    } else if (e.key === 'Escape') {
      modelDropdown.classList.add('hidden');
      modelInput.blur();
    }
  });

  modePickerBtn.addEventListener('click', () => {
    modeDropdown.classList.toggle('hidden');
  });

  // Close mode dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!modePickerBtn.contains(/** @type {Node} */ (e.target)) && !modeDropdown.contains(/** @type {Node} */ (e.target))) {
      modeDropdown.classList.add('hidden');
    }
  });

  newChatBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newChat' });
  });

  sessionsBtn.addEventListener('click', () => {
    showView('sessions');
    vscode.postMessage({ type: 'getSessions' });
  });

  sessionsBackBtn.addEventListener('click', () => {
    showView('chat');
  });

  settingsBtn.addEventListener('click', () => {
    showView('settings');
    vscode.postMessage({ type: 'getProfiles' });
  });

  contextBtn.addEventListener('click', () => {
    showView('context');
    vscode.postMessage({ type: 'getContext' });
  });

  // Auto-resize textarea + autocomplete detection
  inputEl.addEventListener('input', () => {
    autoResizeTextarea();
    detectFileReference();
  });

  // Stop button
  stopBtn.addEventListener('click', stopGeneration);

  // Steering buttons
  document.querySelectorAll('.steering-btn').forEach(btn => {
    btn.addEventListener('click', () => handleSteering(btn.dataset.steer));
  });

  // Active file toggle
  activeFileToggle.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleActiveFile' });
  });

  // Request initial active file state
  vscode.postMessage({ type: 'getActiveFile' });

  // ===== Settings Event Listeners =====
  settingsBackBtn.addEventListener('click', () => {
    showView('chat');
  });

  // Settings tabs
  tabProviders.addEventListener('click', () => {
    tabProviders.classList.add('active');
    tabMcp.classList.remove('active');
    providersPanel.classList.remove('hidden');
    mcpPanel.classList.add('hidden');
  });

  tabMcp.addEventListener('click', () => {
    tabMcp.classList.add('active');
    tabProviders.classList.remove('active');
    mcpPanel.classList.remove('hidden');
    providersPanel.classList.add('hidden');
    vscode.postMessage({ type: 'getMcpServers' });
  });

  mcpSettingsBtn.addEventListener('click', () => {
    showView('mcp');
    vscode.postMessage({ type: 'getMcpServers' });
  });

  // ===== Context Event Listeners =====
  contextBackBtn.addEventListener('click', () => {
    showView('chat');
  });

  addProfileBtn.addEventListener('click', () => {
    openEditor(null);
  });

  // ===== Editor Event Listeners =====
  editorBackBtn.addEventListener('click', () => {
    showView('settings');
  });

  profileApiKindSelect.addEventListener('change', () => {
    const kind = profileApiKindSelect.value;
    profileBaseUrlInput.value = DEFAULT_BASE_URLS[kind] || '';
    profileBaseUrlInput.disabled = kind !== 'openai-compatible';
    // Clear model selection when kind changes
    profileModelSelect.textContent = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Enter API key first';
    profileModelSelect.appendChild(opt);
  });

  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = profileApiKeyInput.type === 'password';
    profileApiKeyInput.type = isPassword ? 'text' : 'password';
  });

  refreshModelsBtn.addEventListener('click', () => {
    const apiKey = profileApiKeyInput.value.trim();
    if (!apiKey) { return; }
    vscode.postMessage({
      type: 'getModelsForProfile',
      apiKind: profileApiKindSelect.value,
      baseUrl: profileBaseUrlInput.value.trim(),
      apiKey: apiKey,
      requestId: 'models-' + Date.now(),
    });
    // Show loading state
    profileModelSelect.textContent = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Loading models...';
    profileModelSelect.appendChild(opt);
  });

  saveProfileBtn.addEventListener('click', () => {
    const name = profileNameInput.value.trim();
    if (!name) {
      profileNameInput.focus();
      return;
    }

    const apiKey = profileApiKeyInput.value.trim();

    vscode.postMessage({
      type: 'saveProfile',
      profile: {
        id: editingProfileId || undefined,
        name: name,
        apiKind: profileApiKindSelect.value,
        baseUrl: profileBaseUrlInput.value.trim(),
        modelId: profileModelSelect.value,
        enabled: profileEnabledInput.checked,
      },
      apiKey: apiKey || undefined,
    });
  });

  cancelProfileBtn.addEventListener('click', () => {
    showView('settings');
  });

  deleteProfileBtn.addEventListener('click', () => {
    if (!editingProfileId) { return; }
    // Simple confirmation
    const profile = profiles.find(function (p) { return p.id === editingProfileId; });
    const profileName = profile ? profile.name : 'this provider';
    // Use a second click as confirmation (change button text)
    if (deleteProfileBtn.dataset.confirmed === 'true') {
      vscode.postMessage({ type: 'deleteProfile', profileId: editingProfileId });
      showView('settings');
    } else {
      deleteProfileBtn.textContent = 'Click again to confirm deletion of ' + profileName;
      deleteProfileBtn.dataset.confirmed = 'true';
      setTimeout(() => {
        deleteProfileBtn.textContent = 'Delete Provider';
        deleteProfileBtn.dataset.confirmed = 'false';
      }, 3000);
    }
  });

  // ===== MCP Event Listeners =====
  mcpBackBtn.addEventListener('click', () => {
    showView('settings');
  });

  addMcpServerBtn.addEventListener('click', () => {
    openMcpEditor(null);
  });

  mcpEditorBackBtn.addEventListener('click', () => {
    showView('mcp');
  });

  mcpTransportSelect.addEventListener('change', () => {
    const transport = mcpTransportSelect.value;
    if (transport === 'stdio') {
      mcpStdioGroup.classList.remove('hidden');
      mcpSseGroup.classList.add('hidden');
    } else {
      mcpStdioGroup.classList.add('hidden');
      mcpSseGroup.classList.remove('hidden');
    }
  });

  testMcpBtn.addEventListener('click', () => {
    const server = buildMcpServerFromForm();
    if (!server.name) {
      mcpNameInput.focus();
      return;
    }
    vscode.postMessage({
      type: 'testMcpConnection',
      server: server,
    });
  });

  saveMcpBtn.addEventListener('click', () => {
    const server = buildMcpServerFromForm();
    if (!server.name) {
      mcpNameInput.focus();
      return;
    }
    vscode.postMessage({
      type: 'saveMcpServer',
      server: server,
    });
  });

  cancelMcpBtn.addEventListener('click', () => {
    showView('mcp');
  });

  deleteMcpBtn.addEventListener('click', () => {
    if (!editingMcpServerId) { return; }
    if (deleteMcpBtn.dataset.confirmed === 'true') {
      vscode.postMessage({ type: 'deleteMcpServer', serverId: editingMcpServerId });
      showView('mcp');
    } else {
      deleteMcpBtn.textContent = 'Click again to confirm deletion';
      deleteMcpBtn.dataset.confirmed = 'true';
      setTimeout(() => {
        deleteMcpBtn.textContent = 'Delete Server';
        deleteMcpBtn.dataset.confirmed = 'false';
      }, 3000);
    }
  });

  // ===== Message handling from extension =====
  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      // Chat messages
      case 'providers':
        updateProviderList(message.providers, message.activeProviderId);
        // Request models for the active provider
        if (message.activeProviderId) {
          vscode.postMessage({ type: 'getModelsForActiveProvider' });
        }
        break;
      case 'models':
        updateModelList(message.models, message.activeModelId);
        break;
      case 'modes':
        modes = message.modes;
        currentModeId = message.currentModeId;
        updateModeSelector();
        break;
      case 'modeChanged':
        currentModeId = message.mode.id;
        updateModeSelector();
        break;
      case 'waitingForApi':
        apiSpinner.classList.remove('hidden');
        break;
      case 'apiResponseStarted':
        apiSpinner.classList.add('hidden');
        break;
      case 'streamChunk':
        handleStreamChunk(message.content);
        break;
      case 'thinking':
        handleThinking(message.content);
        break;
      case 'toolCallStarted':
        handleToolCallStarted(message.name, message.id, message.args);
        break;
      case 'terminalOutput':
        handleTerminalOutput(message.toolCallId, message.chunk);
        break;
      case 'toolCallResult':
        handleToolCallResult(message.id, message.name, message.content, message.isError);
        break;
      case 'askQuestion':
        handleAskQuestion(message.question, message.toolCallId);
        break;
      case 'questionAnswered':
        handleQuestionAnswered();
        break;
      case 'messageComplete':
        handleMessageComplete();
        break;
      case 'error':
        handleError(message.message);
        break;
      case 'chatCleared':
        messagesEl.textContent = '';
        showEmptyState();
        break;

      // Session messages
      case 'sessions':
        renderSessionList(message.sessions || [], message.activeSessionId);
        break;
      case 'replayMessage':
        removeEmptyState();
        appendMessage(message.role, message.content);
        break;
      case 'sessionResumed':
        // The switched-to session is still streaming — restore streaming UI state
        isStreaming = true;
        updateStreamingUI();
        stopBtn.disabled = false;
        currentAssistantEl = messagesEl.querySelector('.message.assistant:last-child');
        if (currentAssistantEl) {
          currentAssistantText = currentAssistantEl.textContent || '';
          addStreamingCursor(currentAssistantEl);
        } else {
          currentAssistantEl = appendMessage('assistant', '');
          currentAssistantText = '';
          addStreamingCursor(currentAssistantEl);
        }
        break;

      // Smart To-Do messages
      case 'smartTodoUpdate':
        renderSmartTodoTracker(message.phase, message.todos || [], message.iteration || 0);
        break;

      // Sandbox activity messages
      case 'sandboxState':
        handleSandboxState(message);
        break;
      case 'fileActivity':
        handleFileActivity(message);
        break;
      case 'sandboxResult':
        handleSandboxResult(message);
        break;
      case 'sandboxActionStarted':
        handleSandboxActionStarted(message);
        break;
      case 'sandboxActionResult':
        handleSandboxActionResult(message);
        break;

      // Settings messages
      case 'profiles':
        profiles = message.profiles;
        renderProfilesList(message.profiles);
        break;
      case 'profileSaved':
        showView('settings');
        vscode.postMessage({ type: 'getProfiles' });
        break;
      case 'profileDeleted':
        vscode.postMessage({ type: 'getProfiles' });
        break;
      case 'validationResult':
        // Future: show validation status in editor
        break;
      case 'modelsForProfile':
        renderModelOptions(message.models);
        break;

      // Context messages
      case 'context':
        contextSkills = message.skills || [];
        contextAgentsMd = message.agentsMd || [];
        renderContextPanel();
        break;

      // MCP messages
      case 'mcpServers':
        mcpServers = message.servers || [];
        renderMcpServersList(message.servers || []);
        renderMcpServersInlineList(message.servers || []);
        break;
      case 'mcpServerSaved':
        showView('mcp');
        vscode.postMessage({ type: 'getMcpServers' });
        break;
      case 'mcpServerDeleted':
        vscode.postMessage({ type: 'getMcpServers' });
        break;
      case 'mcpConnectionTest':
        if (message.success) {
          alert('Connection successful! Found ' + message.toolCount + ' tools.');
        } else {
          alert('Connection failed: ' + (message.error || 'Unknown error'));
        }
        break;

      // File reference search results
      case 'fileSearchResults':
        renderAutocompleteResults(message.files || []);
        break;

      // Active file context
      case 'activeFileState':
      case 'activeFileToggled':
        activeFilePath = message.file;
        activeFileEnabled = message.enabled;
        updateActiveFileDisplay();
        break;
    }
  });

  // ===== Settings Functions =====

  function openEditor(profile) {
    editingProfileId = profile ? profile.id : null;
    editorTitle.textContent = profile ? 'Edit Provider' : 'Add Provider';

    // Reset form
    profileNameInput.value = profile ? profile.name : '';
    profileApiKindSelect.value = profile ? profile.apiKind : 'anthropic';
    profileBaseUrlInput.value = profile ? profile.baseUrl : DEFAULT_BASE_URLS['anthropic'];
    profileBaseUrlInput.disabled = profile ? profile.apiKind !== 'openai-compatible' : true;
    profileApiKeyInput.value = '';
    profileApiKeyInput.type = 'password';
    profileEnabledInput.checked = profile ? profile.enabled : true;

    // Model select
    profileModelSelect.textContent = '';
    if (profile && profile.modelId) {
      const opt = document.createElement('option');
      opt.value = profile.modelId;
      opt.textContent = profile.modelId;
      opt.selected = true;
      profileModelSelect.appendChild(opt);
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Enter API key, then refresh';
      profileModelSelect.appendChild(opt);
    }

    // Show/hide delete
    if (profile) {
      deleteProfileArea.classList.remove('hidden');
      deleteProfileBtn.textContent = 'Delete Provider';
      deleteProfileBtn.dataset.confirmed = 'false';
    } else {
      deleteProfileArea.classList.add('hidden');
    }

    showView('editor');
    profileNameInput.focus();
  }

  function renderProfilesList(profilesData) {
    profilesList.textContent = '';

    if (profilesData.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';

      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = 'No providers configured';

      const sub = document.createElement('div');
      sub.textContent = 'Add one to get started';

      empty.appendChild(title);
      empty.appendChild(sub);
      profilesList.appendChild(empty);
      return;
    }

    for (const profile of profilesData) {
      const card = document.createElement('div');
      card.className = 'profile-card';

      // Status dot
      const status = document.createElement('div');
      status.className = 'profile-status ' + (profile.hasApiKey ? 'has-key' : 'no-key');
      status.title = profile.hasApiKey ? 'API key set' : 'No API key';

      // Info
      const info = document.createElement('div');
      info.className = 'profile-info';

      const name = document.createElement('div');
      name.className = 'profile-name';
      name.textContent = profile.name;

      const badge = document.createElement('span');
      badge.className = 'profile-badge';
      badge.textContent = formatApiKind(profile.apiKind);

      info.appendChild(name);
      info.appendChild(badge);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'profile-actions';

      const editBtn = document.createElement('button');
      editBtn.textContent = '\u270E';
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditor(profile);
      });

      actions.appendChild(editBtn);

      card.appendChild(status);
      card.appendChild(info);
      card.appendChild(actions);

      // Click card to edit
      card.addEventListener('click', () => {
        openEditor(profile);
      });

      profilesList.appendChild(card);
    }
  }

  function renderModelOptions(models) {
    const currentValue = profileModelSelect.value;
    profileModelSelect.textContent = '';

    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models found';
      profileModelSelect.appendChild(opt);
      return;
    }

    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name || model.id;
      if (model.id === currentValue) { opt.selected = true; }
      profileModelSelect.appendChild(opt);
    }
  }

  function formatApiKind(kind) {
    switch (kind) {
      case 'anthropic': return 'Anthropic';
      case 'openai': return 'OpenAI';
      case 'openai-compatible': return 'OpenAI Compatible';
      default: return kind;
    }
  }

  // ===== Sessions Functions =====

  function renderSmartTodoTracker(phase, todos, iteration) {
    // Find or create the tracker element
    let tracker = document.getElementById('smart-todo-tracker');
    if (!tracker) {
      tracker = document.createElement('div');
      tracker.id = 'smart-todo-tracker';
      // Insert before messages
      messagesEl.parentNode.insertBefore(tracker, messagesEl);
    }

    tracker.textContent = '';
    tracker.classList.remove('hidden');

    // Phase indicator
    const phaseEl = document.createElement('div');
    phaseEl.className = 'smart-todo-phase';
    const phaseIcons = { planning: '\u25B8', executing: '\u2699\uFE0E', verifying: '\u2713' };
    const phaseLabels = { planning: 'Planning', executing: 'Executing', verifying: 'Verifying' };
    phaseEl.textContent = (phaseIcons[phase] || '') + ' ' + (phaseLabels[phase] || phase);
    if (iteration > 0) {
      phaseEl.textContent += ' (iteration ' + iteration + ')';
    }
    tracker.appendChild(phaseEl);

    if (todos.length === 0) { return; }

    // Progress bar
    const doneCount = todos.filter(function(t) { return t.status === 'done'; }).length;
    const progressWrap = document.createElement('div');
    progressWrap.className = 'smart-todo-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'smart-todo-progress-bar';
    progressBar.style.width = Math.round((doneCount / todos.length) * 100) + '%';
    progressWrap.appendChild(progressBar);
    const progressLabel = document.createElement('span');
    progressLabel.className = 'smart-todo-progress-label';
    progressLabel.textContent = doneCount + '/' + todos.length + ' complete';
    progressWrap.appendChild(progressLabel);
    tracker.appendChild(progressWrap);

    // Todo list
    const list = document.createElement('div');
    list.className = 'smart-todo-list';
    for (const todo of todos) {
      const item = document.createElement('div');
      item.className = 'smart-todo-item ' + todo.status;

      const statusIcon = document.createElement('span');
      statusIcon.className = 'smart-todo-icon';
      if (todo.status === 'done') { statusIcon.textContent = '\u2713'; }
      else if (todo.status === 'failed') { statusIcon.textContent = '\u2717'; }
      else if (todo.status === 'in-progress') { statusIcon.textContent = '\u25CB'; }
      else { statusIcon.textContent = '\u25CB'; }

      const titleEl = document.createElement('span');
      titleEl.className = 'smart-todo-title';
      titleEl.textContent = 'TODO ' + todo.id + ': ' + todo.title;

      item.appendChild(statusIcon);
      item.appendChild(titleEl);
      list.appendChild(item);
    }
    tracker.appendChild(list);
  }

  // ===== Sandbox File Activity =====

  var sandboxActive = false;
  var fileActivityEntries = []; // { file, action, timestamp }
  var FILE_ACTIVITY_MAX = 8;
  var FILE_ACTIVITY_FADE_MS = 30000; // fade after 30s

  function handleSandboxState(message) {
    sandboxActive = message.active;
    if (sandboxActive) {
      sandboxActivity.classList.remove('hidden');
      var branchDisplay = message.branchName || 'sandbox';
      // Show just the last part of the branch name for brevity
      var parts = branchDisplay.split('/');
      sandboxBranchName.textContent = parts.length > 1 ? parts.slice(1).join('/') : branchDisplay;
      sandboxBranchName.title = branchDisplay;
    } else {
      sandboxActivity.classList.add('hidden');
      sandboxResult.classList.add('hidden');
      fileActivityEntries = [];
      sandboxFileList.textContent = '';
    }
  }

  function handleFileActivity(message) {
    if (!sandboxActive) { return; }

    var entry = {
      file: message.file,
      action: message.action,
      timestamp: message.timestamp || Date.now(),
    };

    // Avoid duplicate consecutive entries for the same file+action
    var last = fileActivityEntries[0];
    if (last && last.file === entry.file && last.action === entry.action) {
      last.timestamp = entry.timestamp;
      renderFileActivity();
      return;
    }

    // Add to front
    fileActivityEntries.unshift(entry);

    // Trim to max
    if (fileActivityEntries.length > FILE_ACTIVITY_MAX) {
      fileActivityEntries = fileActivityEntries.slice(0, FILE_ACTIVITY_MAX);
    }

    renderFileActivity();
  }

  function renderFileActivity() {
    sandboxFileList.textContent = '';
    var now = Date.now();

    var actionIcons = {
      read: '\u{1F4D6}',     // open book
      write: '\u270F\uFE0F', // pencil
      list: '\u{1F4C2}',     // open folder
      command: '\u25B8',      // play/terminal
      sandbox: '\u{1F6E1}',  // shield
    };

    for (var i = 0; i < fileActivityEntries.length; i++) {
      var entry = fileActivityEntries[i];
      var age = now - entry.timestamp;
      var opacity = age > FILE_ACTIVITY_FADE_MS ? 0.3 : (1 - (age / FILE_ACTIVITY_FADE_MS) * 0.5);

      var row = document.createElement('div');
      row.className = 'sandbox-file-entry';
      if (i === 0) { row.classList.add('active'); }
      row.style.opacity = Math.max(0.3, opacity).toFixed(2);

      var icon = document.createElement('span');
      icon.className = 'sandbox-file-icon';
      icon.textContent = actionIcons[entry.action] || '\u2022';

      var name = document.createElement('span');
      name.className = 'sandbox-file-name';
      // Shorten long paths: show just filename or last 2 segments
      var displayName = entry.file;
      if (entry.action !== 'command') {
        var segs = displayName.split('/');
        if (segs.length > 2) {
          displayName = '\u2026/' + segs.slice(-2).join('/');
        }
      } else {
        // For commands, truncate long strings
        if (displayName.length > 40) {
          displayName = displayName.slice(0, 37) + '\u2026';
        }
      }
      name.textContent = displayName;
      name.title = entry.file;

      row.appendChild(icon);
      row.appendChild(name);
      sandboxFileList.appendChild(row);
    }

    // Show the activity dot animation on the most recent entry
    var dot = sandboxActivity.querySelector('.sandbox-activity-dot');
    if (dot && fileActivityEntries.length > 0) {
      dot.classList.add('pulsing');
      clearTimeout(dot._pulseTimer);
      dot._pulseTimer = setTimeout(function() { dot.classList.remove('pulsing'); }, 2000);
    }
  }

  // ===== Sandbox Result Card =====

  function handleSandboxResult(message) {
    // Show the result card, hide the activity tracker
    sandboxActivity.classList.add('hidden');
    sandboxResult.classList.remove('hidden');

    // Branch name
    sandboxResultBranch.textContent = message.branchName || 'sandbox';

    // Changed files list
    sandboxResultFiles.textContent = '';
    var statusLabels = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C' };
    var statusClasses = { A: 'added', M: 'modified', D: 'deleted', R: 'modified', C: 'added' };

    if (message.files && message.files.length > 0) {
      message.files.forEach(function(f) {
        var row = document.createElement('div');
        row.className = 'sandbox-result-file';

        var statusEl = document.createElement('span');
        var statusChar = f.status.charAt(0).toUpperCase();
        statusEl.className = 'sandbox-result-file-status ' + (statusClasses[statusChar] || 'modified');
        statusEl.textContent = statusLabels[statusChar] || statusChar;
        statusEl.title = f.status;

        var pathEl = document.createElement('span');
        pathEl.className = 'sandbox-result-file-path';
        pathEl.textContent = f.path;
        pathEl.title = f.path;

        row.appendChild(statusEl);
        row.appendChild(pathEl);
        sandboxResultFiles.appendChild(row);
      });
    } else {
      var emptyEl = document.createElement('div');
      emptyEl.style.fontSize = '11px';
      emptyEl.style.color = 'var(--vscode-descriptionForeground)';
      emptyEl.textContent = 'No file changes detected';
      sandboxResultFiles.appendChild(emptyEl);
    }

    // Summary
    sandboxResultSummary.textContent = message.summary || '';

    // Reset buttons
    sandboxApplyBtn.disabled = false;
    sandboxDiscardBtn.disabled = false;
    sandboxActionStatus.classList.add('hidden');
    sandboxActionStatus.className = 'sandbox-action-status hidden';
  }

  function handleSandboxActionStarted(message) {
    sandboxApplyBtn.disabled = true;
    sandboxDiscardBtn.disabled = true;
    sandboxActionStatus.textContent = message.action === 'apply' ? 'Applying changes\u2026' : 'Discarding sandbox\u2026';
    sandboxActionStatus.className = 'sandbox-action-status loading';
  }

  function handleSandboxActionResult(message) {
    sandboxApplyBtn.disabled = true;
    sandboxDiscardBtn.disabled = true;

    if (message.success) {
      sandboxActionStatus.className = 'sandbox-action-status success';
      sandboxActionStatus.textContent = message.message;
      // Hide the result card after a delay
      setTimeout(function() {
        sandboxResult.classList.add('hidden');
      }, 5000);
    } else {
      sandboxActionStatus.className = 'sandbox-action-status error';
      sandboxActionStatus.textContent = message.message;
      // Re-enable buttons so user can retry
      sandboxApplyBtn.disabled = false;
      sandboxDiscardBtn.disabled = false;
    }
  }

  sandboxApplyBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'applySandbox' });
  });

  sandboxDiscardBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'discardSandbox' });
  });

  function renderSessionList(sessions, activeSessionId) {
    sessionsList.textContent = '';

    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sessions-empty';
      empty.textContent = 'No sessions yet';
      sessionsList.appendChild(empty);
      return;
    }

    for (const session of sessions) {
      const card = document.createElement('div');
      card.className = 'session-card' + (session.id === activeSessionId ? ' active' : '');

      // Status dot
      const status = document.createElement('div');
      status.className = 'session-status ' + session.status;
      status.title = session.status === 'busy' ? 'Running' : session.status === 'error' ? 'Error' : 'Idle';

      // Info section
      const info = document.createElement('div');
      info.className = 'session-info';

      const title = document.createElement('div');
      title.className = 'session-title';
      title.textContent = session.title;

      const meta = document.createElement('div');
      meta.className = 'session-meta';
      meta.textContent = session.messageCount + ' message' + (session.messageCount !== 1 ? 's' : '') + ' \u00B7 ' + timeAgo(session.updatedAt);

      info.appendChild(title);
      info.appendChild(meta);

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete';
      deleteBtn.textContent = '\u2715';
      deleteBtn.title = 'Delete session';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
      });

      card.appendChild(status);
      card.appendChild(info);
      card.appendChild(deleteBtn);

      // Click to switch
      card.addEventListener('click', () => {
        vscode.postMessage({ type: 'switchSession', sessionId: session.id });
        showView('chat');
      });

      sessionsList.appendChild(card);
    }
  }

  function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return minutes + 'm ago'; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return hours + 'h ago'; }
    const days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  // ===== Chat Functions =====

  // Auto-resize textarea
  function autoResizeTextarea() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }

  // Update send button and input area based on streaming state
  function updateStreamingUI() {
    if (isStreaming) {
      sendBtn.disabled = false; // Always enabled — sends to queue when streaming
      sendBtn.classList.add('queue-mode');
      sendBtn.title = 'Add to queue';
      inputEl.placeholder = 'Type to queue a message\u2026';
      document.querySelectorAll('.steering-btn').forEach(btn => {
        btn.classList.add('interrupt');
        btn.title = 'Stop & ' + (btn.dataset.steer || 'steer');
      });
    } else {
      sendBtn.classList.remove('queue-mode');
      sendBtn.title = 'Send';
      sendBtn.disabled = false;
      inputEl.placeholder = 'Ask YOLO Agent... (@ to reference files)';
      document.querySelectorAll('.steering-btn').forEach(btn => {
        btn.classList.remove('interrupt');
        btn.title = '';
      });
    }
  }

  // Stop generation
  function stopGeneration() {
    vscode.postMessage({ type: 'cancelRequest' });
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isStreaming = false;
    updateStreamingUI();
    stopBtn.disabled = true;
    apiSpinner.classList.add('hidden');
    removeStreamingCursor();
  }

  // Handle steering commands
  function handleSteering(type) {
    const steeringPrompts = {
      continue: 'Please continue from where you left off.',
      retry: 'Please try again with a different approach.',
      summarize: 'Please summarize what we\'ve covered so far.',
      expand: 'Please expand on your last response with more detail.',
    };

    if (isStreaming) {
      // Interrupt: stop current generation, queue the steering command.
      // The messageComplete handler will fire processQueue() once the backend is idle.
      stopGeneration();
      addToQueue(type);
      // Fallback: if messageComplete doesn't fire within 600ms (edge case), try processing
      setTimeout(() => processQueue(), 600);
      return;
    }

    const prompt = steeringPrompts[type] || type;
    sendMessageWithPrompt(prompt);
  }

  // Send message with custom prompt
  function sendMessageWithPrompt(prompt) {
    if (isStreaming) { return; }

    removeEmptyState();
    appendMessage('user', prompt);

    vscode.postMessage({ type: 'sendMessage', text: prompt });

    inputEl.value = '';
    isStreaming = true;
    updateStreamingUI();
    stopBtn.disabled = false;

    currentAssistantEl = appendMessage('assistant', '');
    currentAssistantText = '';
    addStreamingCursor(currentAssistantEl);
  }

  // Queue management
  function addToQueue(typeOrItem) {
    const steeringNames = {
      continue: 'Continue',
      retry: 'Retry',
      summarize: 'Summarize',
      expand: 'Expand',
    };

    let item;
    if (typeof typeOrItem === 'object' && typeOrItem.type === 'custom') {
      // Custom text message from the user
      item = {
        type: 'custom',
        name: typeOrItem.text.length > 40 ? typeOrItem.text.substring(0, 40) + '\u2026' : typeOrItem.text,
        text: typeOrItem.text,
        timestamp: Date.now(),
      };
    } else {
      // Steering type (string)
      const type = typeof typeOrItem === 'string' ? typeOrItem : typeOrItem.type;
      item = {
        type,
        name: steeringNames[type] || type,
        timestamp: Date.now(),
      };
    }

    commandQueue.push(item);
    renderQueue();
  }

  function removeFromQueue(index) {
    commandQueue.splice(index, 1);
    renderQueue();
  }

  function renderQueue() {
    if (commandQueue.length === 0) {
      queueSection.classList.add('hidden');
      return;
    }

    queueSection.classList.remove('hidden');
    queueCount.textContent = commandQueue.length;

    queueList.textContent = '';
    for (let i = 0; i < commandQueue.length; i++) {
      const item = commandQueue[i];
      const el = document.createElement('div');
      el.className = 'queue-item' + (item.type === 'custom' ? ' custom' : '');

      const icon = document.createElement('span');
      icon.className = 'queue-item-icon';
      icon.textContent = item.type === 'custom' ? '\u{1F4AC}' : '\u2192';
      el.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'queue-item-name';
      name.textContent = item.name;
      if (item.type === 'custom' && item.text) {
        name.title = item.text; // Full text on hover
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'queue-item-remove';
      removeBtn.textContent = '\u2715';
      removeBtn.title = 'Remove from queue';
      removeBtn.addEventListener('click', () => removeFromQueue(i));

      el.appendChild(name);
      el.appendChild(removeBtn);
      queueList.appendChild(el);
    }
  }

  function processQueue() {
    if (commandQueue.length === 0 || isStreaming) { return; }

    const next = commandQueue.shift();
    renderQueue();

    if (next.type === 'custom') {
      // Custom text — send as a normal user message
      sendMessageWithPrompt(next.text);
    } else {
      // Steering command — resolve to prompt and send directly
      const steeringPrompts = {
        continue: 'Please continue from where you left off.',
        retry: 'Please try again with a different approach.',
        summarize: 'Please summarize what we\'ve covered so far.',
        expand: 'Please expand on your last response with more detail.',
      };
      sendMessageWithPrompt(steeringPrompts[next.type] || next.type);
    }
  }

  // ===== File Reference Autocomplete =====

  function detectFileReference() {
    const text = inputEl.value;
    const cursorPos = inputEl.selectionStart;

    // Look backwards from cursor for @ or # trigger
    let triggerPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@' || ch === '#') {
        // Check it's at start or preceded by whitespace
        if (i === 0 || /\s/.test(text[i - 1])) {
          triggerPos = i;
          break;
        }
      }
      // Stop searching if we hit whitespace (no trigger found in this word)
      if (/\s/.test(ch)) { break; }
    }

    if (triggerPos === -1) {
      closeAutocomplete();
      return;
    }

    const query = text.slice(triggerPos + 1, cursorPos);
    if (query.length < 1) {
      closeAutocomplete();
      return;
    }

    autocompleteActive = true;
    autocompleteQuery = query;
    autocompleteStartPos = triggerPos;
    autocompleteSelectedIndex = 0;

    // Debounce the search
    if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); }
    searchDebounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'searchFiles', query: query });
    }, 150);
  }

  function closeAutocomplete() {
    autocompleteActive = false;
    autocompleteQuery = '';
    autocompleteStartPos = -1;
    autocompleteDropdown.classList.add('hidden');
    autocompleteDropdown.textContent = '';
  }

  function renderAutocompleteResults(files) {
    autocompleteDropdown.textContent = '';

    if (!autocompleteActive || files.length === 0) {
      autocompleteDropdown.classList.add('hidden');
      return;
    }

    autocompleteDropdown.classList.remove('hidden');
    autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex, files.length - 1);

    for (let i = 0; i < files.length; i++) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item' + (i === autocompleteSelectedIndex ? ' selected' : '');
      item.dataset.path = files[i];

      const fileName = files[i].split('/').pop();
      const dirPath = files[i].includes('/') ? files[i].slice(0, files[i].lastIndexOf('/')) : '';

      const nameEl = document.createElement('span');
      nameEl.className = 'autocomplete-name';
      nameEl.textContent = fileName;

      item.appendChild(nameEl);

      if (dirPath) {
        const pathEl = document.createElement('span');
        pathEl.className = 'autocomplete-path';
        pathEl.textContent = dirPath;
        item.appendChild(pathEl);
      }

      item.addEventListener('click', () => selectAutocompleteItem(files[i]));
      item.addEventListener('mouseenter', () => {
        autocompleteSelectedIndex = i;
        updateAutocompleteSelection(autocompleteDropdown.querySelectorAll('.autocomplete-item'));
      });

      autocompleteDropdown.appendChild(item);
    }
  }

  function updateAutocompleteSelection(items) {
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === autocompleteSelectedIndex);
    });
  }

  function selectAutocompleteItem(filePath) {
    // Replace the @query text with just @filename (keep it readable)
    const text = inputEl.value;
    const before = text.slice(0, autocompleteStartPos);
    const after = text.slice(inputEl.selectionStart);
    const fileName = filePath.split('/').pop();
    inputEl.value = before + '@' + fileName + ' ' + after;

    // Add file reference if not already added
    if (!fileReferences.includes(filePath)) {
      fileReferences.push(filePath);
      renderFileChips();
    }

    closeAutocomplete();
    inputEl.focus();
    autoResizeTextarea();
  }

  function renderFileChips() {
    fileChips.textContent = '';

    if (fileReferences.length === 0) {
      fileChips.classList.add('hidden');
      return;
    }

    fileChips.classList.remove('hidden');

    for (let i = 0; i < fileReferences.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';

      const name = document.createElement('span');
      name.className = 'file-chip-name';
      name.textContent = fileReferences[i].split('/').pop();
      name.title = fileReferences[i];

      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-chip-remove';
      removeBtn.textContent = '\u2715';
      removeBtn.title = 'Remove';
      const idx = i;
      removeBtn.addEventListener('click', () => {
        fileReferences.splice(idx, 1);
        renderFileChips();
      });

      chip.appendChild(name);
      chip.appendChild(removeBtn);
      fileChips.appendChild(chip);
    }
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) { return; }

    // If streaming, queue the message instead of blocking
    if (isStreaming) {
      addToQueue({ type: 'custom', text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
      return;
    }

    removeEmptyState();
    appendMessage('user', text);

    // Create new abort controller for this request
    abortController = new AbortController();

    vscode.postMessage({
      type: 'sendMessage',
      text,
      fileReferences: fileReferences.length > 0 ? [...fileReferences] : undefined,
    });

    // Clear file references after sending
    fileReferences = [];
    renderFileChips();

    // Reset textarea height
    inputEl.style.height = 'auto';

    inputEl.value = '';
    isStreaming = true;
    updateStreamingUI();
    stopBtn.disabled = false;

    // If answering a pending question, don't create a new assistant bubble —
    // the existing tool execution loop will continue producing output.
    if (isAwaitingAnswer) {
      return;
    }

    currentAssistantEl = appendMessage('assistant', '');
    currentAssistantText = '';
    addStreamingCursor(currentAssistantEl);
  }

  function handleStreamChunk(content) {
    if (!currentAssistantEl) {
      currentAssistantEl = appendMessage('assistant', '');
      currentAssistantText = '';
      addStreamingCursor(currentAssistantEl);
    }
    currentAssistantText += content;
    renderMessageContent(currentAssistantEl, currentAssistantText);
    addStreamingCursor(currentAssistantEl);
    scrollToBottom();
  }

  var isAwaitingAnswer = false;
  var savedPlaceholder = '';

  function handleAskQuestion(question, toolCallId) {
    // Show a question card in the chat
    const card = document.createElement('div');
    card.className = 'question-card';
    if (toolCallId) { card.dataset.toolId = toolCallId; }

    const header = document.createElement('div');
    header.className = 'question-card-header';

    const icon = document.createElement('span');
    icon.className = 'question-card-icon';
    icon.textContent = '\u2753';

    const label = document.createElement('span');
    label.className = 'question-card-label';
    label.textContent = 'Question from assistant';

    header.appendChild(icon);
    header.appendChild(label);

    const body = document.createElement('div');
    body.className = 'question-card-body';
    body.textContent = question;

    card.appendChild(header);
    card.appendChild(body);
    messagesEl.appendChild(card);

    // Re-enable input so the user can answer
    isAwaitingAnswer = true;
    isStreaming = false;
    savedPlaceholder = inputEl.placeholder;
    inputEl.placeholder = 'Type your answer...';
    updateStreamingUI();
    stopBtn.disabled = false;
    apiSpinner.classList.add('hidden');
    removeStreamingCursor();
    inputEl.focus();
    scrollToBottom();
  }

  function handleQuestionAnswered() {
    // Restore streaming state — the tool loop continues
    isAwaitingAnswer = false;
    isStreaming = true;
    inputEl.placeholder = savedPlaceholder || 'Ask YOLO Agent... (@ to reference files)';
    updateStreamingUI();
    stopBtn.disabled = false;
  }

  function formatToolArgs(args) {
    if (!args || typeof args !== 'object') { return ''; }
    const entries = Object.entries(args);
    if (entries.length === 0) { return ''; }
    return entries.map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      return k + ': ' + val;
    }).join('\n');
  }

  function handleToolCallStarted(name, id, args) {
    const card = document.createElement('div');
    card.className = 'tool-call';
    card.dataset.toolId = id;

    const header = document.createElement('div');
    header.className = 'tool-call-header';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = ICON_PLAY;

    const nameEl = document.createElement('strong');
    nameEl.textContent = name;

    const status = document.createElement('span');
    status.style.opacity = STATUS_OPACITY;
    status.textContent = STATUS_RUNNING;

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
    header[HANDLER_PROPERTY] = toggleHandler;
    header.addEventListener('click', toggleHandler);

    const contentEl = document.createElement('div');
    contentEl.className = 'tool-call-content';

    // Input section — show tool arguments
    const inputSection = document.createElement('div');
    inputSection.className = 'tool-call-section tool-call-input';
    const inputLabel = document.createElement('div');
    inputLabel.className = 'tool-call-section-label';
    inputLabel.textContent = 'Input';
    const inputBody = document.createElement('pre');
    inputBody.className = 'tool-call-section-body';
    inputBody.textContent = formatToolArgs(args) || '(no arguments)';
    inputSection.appendChild(inputLabel);
    inputSection.appendChild(inputBody);
    contentEl.appendChild(inputSection);

    // Output section — placeholder until result arrives
    const outputSection = document.createElement('div');
    outputSection.className = 'tool-call-section tool-call-output';
    const outputLabel = document.createElement('div');
    outputLabel.className = 'tool-call-section-label';
    outputLabel.textContent = 'Output';
    const outputBody = document.createElement('pre');
    outputBody.className = 'tool-call-section-body';
    outputBody.textContent = 'Executing\u2026';
    outputSection.appendChild(outputLabel);
    outputSection.appendChild(outputBody);
    contentEl.appendChild(outputSection);

    card.appendChild(header);
    card.appendChild(contentEl);
    messagesEl.appendChild(card);
    scrollToBottom();
  }

  /**
   * Handle streaming terminal output — update the tool card's output section
   * in real-time as chunks arrive from the running command.
   */
  function handleTerminalOutput(toolCallId, chunk) {
    const card = messagesEl.querySelector('.tool-call[data-tool-id="' + CSS.escape(toolCallId) + '"]');
    if (!card) { return; }

    const outputBody = card.querySelector('.tool-call-output .tool-call-section-body');
    if (!outputBody) { return; }

    // Replace the "Executing…" placeholder with actual output
    if (outputBody.textContent === 'Executing\u2026') {
      outputBody.textContent = '';
    }
    outputBody.textContent += chunk;

    // Auto-expand the card content so user can see streaming output
    const header = card.querySelector('.tool-call-header');
    const contentEl = card.querySelector('.tool-call-content');
    if (header && contentEl && !header.classList.contains('expanded')) {
      header.classList.add('expanded');
      contentEl.classList.add('visible');
    }

    // Keep only the last 200 lines visible to avoid DOM bloat
    const lines = outputBody.textContent.split('\n');
    if (lines.length > 200) {
      outputBody.textContent = '... (earlier output truncated) ...\n' + lines.slice(-200).join('\n');
    }

    scrollToBottom();
  }

  function handleToolCallResult(id, name, content, isError) {
    const card = messagesEl.querySelector('.tool-call[data-tool-id="' + CSS.escape(id) + '"]');
    if (card) {
      const header = card.querySelector('.tool-call-header');
      if (header) {
        // Remove old listener if it exists
        if (header[HANDLER_PROPERTY]) {
          header.removeEventListener('click', header[HANDLER_PROPERTY]);
        }

        header.textContent = '';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = ICON_PLAY;

        const nameEl = document.createElement('strong');
        nameEl.textContent = name;

        const statusEl = document.createElement('span');
        statusEl.style.opacity = STATUS_OPACITY;
        statusEl.textContent = isError ? STATUS_ERROR : STATUS_DONE;

        header.appendChild(icon);
        header.appendChild(document.createTextNode(' '));
        header.appendChild(nameEl);
        header.appendChild(document.createTextNode(' '));
        header.appendChild(statusEl);

        // Add new listener
        const toggleHandler = () => {
          header.classList.toggle('expanded');
          const contentEl = card.querySelector('.tool-call-content');
          if (contentEl) { contentEl.classList.toggle('visible'); }
        };
        header[HANDLER_PROPERTY] = toggleHandler;
        header.addEventListener('click', toggleHandler);
      }
      // Update the output section body
      const outputBody = card.querySelector('.tool-call-output .tool-call-section-body');
      if (outputBody) {
        outputBody.textContent = content;
        if (isError) { outputBody.classList.add('error'); }
      }
    }
    scrollToBottom();
  }

  function handleThinking(content) {
    if (!currentAssistantEl) {
      currentAssistantEl = appendMessage('assistant', '');
    }

    let thinkingEl = currentAssistantEl.querySelector('.thinking-block');
    if (!thinkingEl) {
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking-block';

      const header = document.createElement('div');
      header.className = 'thinking-header';

      const icon = document.createElement('span');
      icon.className = 'thinking-icon';
      icon.textContent = '\u1F4A1';

      const title = document.createElement('span');
      title.textContent = 'Thinking';

      const toggle = document.createElement('span');
      toggle.className = 'thinking-toggle';
      toggle.textContent = '\u25B6';

      header.appendChild(icon);
      header.appendChild(document.createTextNode(' '));
      header.appendChild(title);
      header.appendChild(toggle);

      const contentEl = document.createElement('div');
      contentEl.className = 'thinking-content';
      contentEl.textContent = content;

      thinkingEl.appendChild(header);
      thinkingEl.appendChild(contentEl);

      currentAssistantEl.insertBefore(thinkingEl, currentAssistantEl.firstChild);

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

  function handleMessageComplete() {
    isStreaming = false;
    updateStreamingUI();
    stopBtn.disabled = true;
    apiSpinner.classList.add('hidden');
    removeStreamingCursor();
    currentAssistantEl = null;
    currentAssistantText = '';
    inputEl.focus();
    abortController = null;

    // Process queue if there are pending commands
    processQueue();
  }

  function handleError(msg) {
    isStreaming = false;
    updateStreamingUI();
    stopBtn.disabled = true;
    apiSpinner.classList.add('hidden');
    removeStreamingCursor();
    currentAssistantEl = null;
    currentAssistantText = '';
    abortController = null;

    const el = document.createElement('div');
    el.className = 'message error';
    el.textContent = msg;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'message ' + role;
    if (text) { renderMessageContent(el, text); }
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function renderMessageContent(el, text) {
    while (el.firstChild) { el.removeChild(el.firstChild); }
    const segments = parseTextSegments(text);
    for (const seg of segments) {
      if (seg.type === 'codeblock') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = seg.text;
        pre.appendChild(code);
        el.appendChild(pre);
      } else if (seg.type === 'code') {
        const code = document.createElement('code');
        code.textContent = seg.text;
        el.appendChild(code);
      } else if (seg.type === 'bold') {
        const strong = document.createElement('strong');
        strong.textContent = seg.text;
        el.appendChild(strong);
      } else {
        el.appendChild(document.createTextNode(seg.text));
      }
    }
  }

  function parseTextSegments(text) {
    const segments = [];
    let remaining = text;

    while (remaining.length > 0) {
      const codeBlockMatch = remaining.match(/^```(?:\w*)\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        segments.push({ type: 'codeblock', text: codeBlockMatch[1] });
        remaining = remaining.slice(codeBlockMatch[0].length);
        continue;
      }

      const inlineMatch = remaining.match(/^`([^`]+)`/);
      if (inlineMatch) {
        segments.push({ type: 'code', text: inlineMatch[1] });
        remaining = remaining.slice(inlineMatch[0].length);
        continue;
      }

      const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
      if (boldMatch) {
        segments.push({ type: 'bold', text: boldMatch[1] });
        remaining = remaining.slice(boldMatch[0].length);
        continue;
      }

      const nextSpecial = remaining.search(/[`*]/);
      if (nextSpecial === -1) {
        segments.push({ type: 'text', text: remaining });
        remaining = '';
      } else if (nextSpecial === 0) {
        segments.push({ type: 'text', text: remaining[0] });
        remaining = remaining.slice(1);
      } else {
        segments.push({ type: 'text', text: remaining.slice(0, nextSpecial) });
        remaining = remaining.slice(nextSpecial);
      }
    }

    return segments;
  }

  function addStreamingCursor(el) {
    removeStreamingCursor();
    const cursor = document.createElement('span');
    cursor.className = 'streaming-indicator';
    el.appendChild(cursor);
  }

  function removeStreamingCursor() {
    const cursors = document.querySelectorAll('.streaming-indicator');
    cursors.forEach((c) => c.remove());
  }

  function updateProviderList(providers, activeId) {
    providerSelect.textContent = '';
    if (providers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No providers - click \u2699 to add';
      providerSelect.appendChild(opt);
      // Clear model picker too
      modelList = [];
      activeModelId = '';
      modelInput.value = '';
      modelInput.placeholder = 'No models';
      modelDropdown.classList.add('hidden');
      return;
    }
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === activeId) { opt.selected = true; }
      providerSelect.appendChild(opt);
    }
  }

  function updateModelList(models, newActiveModelId) {
    modelList = models || [];
    activeModelId = newActiveModelId || '';

    // If active model not in list, add it so the input displays something
    if (activeModelId && !modelList.some(m => m.id === activeModelId)) {
      modelList = [{ id: activeModelId, name: activeModelId }, ...modelList];
    }

    // Update the input display value
    const current = modelList.find(m => m.id === activeModelId);
    modelInput.value = current ? (current.name || current.id) : (activeModelId || '');
    modelInput.placeholder = modelList.length === 0 ? 'No models' : 'Search models\u2026';

    // If dropdown is visible, re-render with current filter
    if (!modelDropdown.classList.contains('hidden')) {
      renderModelDropdown(modelInput.value);
    }
  }

  function updateModeSelector() {
    // Update picker button text
    const currentMode = modes.find(m => m.id === currentModeId);
    modePickerBtn.textContent = currentMode ? currentMode.name : 'Select mode';

    // Rebuild dropdown items
    modeDropdown.textContent = '';
    for (const m of modes) {
      const item = document.createElement('div');
      item.className = 'mode-dropdown-item' + (m.id === currentModeId ? ' selected' : '');
      item.dataset.modeId = m.id;

      const nameEl = document.createElement('div');
      nameEl.className = 'mode-dropdown-item-name';
      nameEl.textContent = m.name;
      item.appendChild(nameEl);

      if (m.description) {
        const descEl = document.createElement('div');
        descEl.className = 'mode-dropdown-item-desc';
        descEl.textContent = m.description;
        item.appendChild(descEl);
      }

      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'setMode', modeId: m.id });
        modeDropdown.classList.add('hidden');
      });

      modeDropdown.appendChild(item);
    }

    // Update mode display in controls section
    if (currentMode && currentModeDisplay) {
      currentModeDisplay.textContent = currentMode.name;
    }
  }

  function updateActiveFileDisplay() {
    if (!activeFilePath) {
      activeFileDisplay.textContent = 'No file';
      activeFileToggle.classList.remove('enabled');
      activeFileToggle.title = 'No file open';
      return;
    }

    const fileName = activeFilePath.split('/').pop();
    activeFileDisplay.textContent = (activeFileEnabled ? '\u2713 ' : '') + fileName;

    if (activeFileEnabled) {
      activeFileToggle.classList.add('enabled');
      activeFileToggle.title = 'Click to remove "' + fileName + '" from context';
    } else {
      activeFileToggle.classList.remove('enabled');
      activeFileToggle.title = 'Click to add "' + fileName + '" as context';
    }
  }

  function showEmptyState() {
    if (messagesEl.querySelector('.empty-state')) { return; }
    const el = document.createElement('div');
    el.className = 'empty-state';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'YOLO Agent';

    const subtitle = document.createElement('div');
    subtitle.textContent = 'Ask me to help with your code';

    el.appendChild(title);
    el.appendChild(subtitle);
    messagesEl.appendChild(el);
  }

  function removeEmptyState() {
    const el = messagesEl.querySelector('.empty-state');
    if (el) { el.remove(); }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ===== Context Functions =====

  function renderContextPanel() {
    renderSkillsList();
    renderAgentsList();
  }

  function renderSkillsList() {
    contextSkillsList.textContent = '';

    if (contextSkills.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = 'No skills found in .yolo-agent/skills/';
      contextSkillsList.appendChild(empty);
      return;
    }

    for (const skill of contextSkills) {
      const card = document.createElement('div');
      card.className = 'context-card' + (skill.enabled ? ' enabled' : ' disabled');

      const header = document.createElement('div');
      header.className = 'context-card-header';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = skill.enabled;
      toggle.addEventListener('change', () => {
        vscode.postMessage({
          type: 'setSkillEnabled',
          sourcePath: skill.sourcePath,
          enabled: toggle.checked,
        });
      });

      const name = document.createElement('strong');
      name.className = 'context-name';
      name.textContent = skill.name;

      const path = document.createElement('div');
      path.className = 'context-path';
      path.textContent = skill.sourcePath;

      const desc = document.createElement('div');
      desc.className = 'context-description';
      desc.textContent = skill.description || 'No description';

      header.appendChild(toggle);
      header.appendChild(name);

      card.appendChild(header);
      card.appendChild(path);
      card.appendChild(desc);

      if (skill.tags && skill.tags.length > 0) {
        const tagsEl = document.createElement('div');
        tagsEl.className = 'context-tags';
        for (const tag of skill.tags) {
          const tagEl = document.createElement('span');
          tagEl.className = 'context-tag';
          tagEl.textContent = tag;
          tagsEl.appendChild(tagEl);
        }
        card.appendChild(tagsEl);
      }

      contextSkillsList.appendChild(card);
    }
  }

  function renderAgentsList() {
    contextAgentsList.textContent = '';

    if (contextAgentsMd.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = 'No AGENTS.md files found';
      contextAgentsList.appendChild(empty);
      return;
    }

    for (const agentsMd of contextAgentsMd) {
      const card = document.createElement('div');
      card.className = 'context-card';

      const header = document.createElement('div');
      header.className = 'context-card-header';

      const name = document.createElement('strong');
      name.className = 'context-name';
      name.textContent = agentsMd.projectName;

      const path = document.createElement('div');
      path.className = 'context-path';
      path.textContent = agentsMd.path;

      header.appendChild(name);

      card.appendChild(header);
      card.appendChild(path);

      // Show a preview of the content
      const preview = document.createElement('div');
      preview.className = 'context-preview';
      const lines = agentsMd.content.split('\n').slice(0, 5).join('\n');
      preview.textContent = lines + (agentsMd.content.split('\n').length > 5 ? '\n...' : '');
      card.appendChild(preview);

      contextAgentsList.appendChild(card);
    }
  }

  // ===== MCP Functions =====

  function renderMcpServersList(servers) {
    mcpServersList.textContent = '';

    if (servers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = 'No MCP servers configured';
      mcpServersList.appendChild(empty);
      return;
    }

    for (const server of servers) {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';

      const status = document.createElement('div');
      status.className = 'mcp-status ' + (server.connected ? 'connected' : 'disconnected');
      status.title = server.connected ? 'Connected' : 'Disconnected';

      const info = document.createElement('div');
      info.className = 'mcp-info';

      const name = document.createElement('div');
      name.className = 'mcp-name';
      name.textContent = server.name;

      const transport = document.createElement('span');
      transport.className = 'mcp-badge';
      transport.textContent = server.transport.toUpperCase();

      info.appendChild(name);
      info.appendChild(transport);

      const actions = document.createElement('div');
      actions.className = 'mcp-actions';

      const editBtn = document.createElement('button');
      editBtn.textContent = '\u270E';
      editBtn.title = 'Edit';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMcpEditor(server);
      });

      actions.appendChild(editBtn);

      card.appendChild(status);
      card.appendChild(info);
      card.appendChild(actions);

      card.addEventListener('click', () => {
        openMcpEditor(server);
      });

      mcpServersList.appendChild(card);
    }
  }

  function renderMcpServersInlineList(servers) {
    mcpServersInlineList.textContent = '';

    if (servers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-empty';
      empty.textContent = 'No MCP servers configured';
      mcpServersInlineList.appendChild(empty);
      return;
    }

    for (const server of servers) {
      const card = document.createElement('div');
      card.className = 'mcp-server-card';

      const status = document.createElement('div');
      status.className = 'mcp-status ' + (server.connected ? 'connected' : 'disconnected');
      status.title = server.connected ? 'Connected' : 'Disconnected';

      const info = document.createElement('div');
      info.className = 'mcp-info';

      const name = document.createElement('div');
      name.className = 'mcp-name';
      name.textContent = server.name;

      const transport = document.createElement('span');
      transport.className = 'mcp-badge';
      transport.textContent = server.transport.toUpperCase();

      info.appendChild(name);
      info.appendChild(transport);

      card.appendChild(status);
      card.appendChild(info);

      mcpServersInlineList.appendChild(card);
    }
  }

  function openMcpEditor(server) {
    editingMcpServerId = server ? server.id : null;
    mcpEditorTitle.textContent = server ? 'Edit MCP Server' : 'Add MCP Server';

    // Reset form
    mcpNameInput.value = server ? server.name : '';
    mcpTransportSelect.value = server ? server.transport : 'stdio';
    mcpCommandInput.value = server ? (server.command || '') : 'npx';
    mcpArgsInput.value = server ? (server.args ? server.args.join(' ') : '') : '';
    mcpUrlInput.value = server ? (server.url || '') : '';
    mcpEnabledInput.checked = server ? server.enabled : true;

    // Show correct transport fields
    const transport = server ? server.transport : 'stdio';
    if (transport === 'stdio') {
      mcpStdioGroup.classList.remove('hidden');
      mcpSseGroup.classList.add('hidden');
    } else {
      mcpStdioGroup.classList.add('hidden');
      mcpSseGroup.classList.remove('hidden');
    }

    // Show/hide delete
    if (server) {
      deleteMcpArea.classList.remove('hidden');
      deleteMcpBtn.textContent = 'Delete Server';
      deleteMcpBtn.dataset.confirmed = 'false';
    } else {
      deleteMcpArea.classList.add('hidden');
    }

    showView('mcp-editor');
    mcpNameInput.focus();
  }

  function buildMcpServerFromForm() {
    const transport = mcpTransportSelect.value;
    const server = {
      id: editingMcpServerId || 'mcp-' + Date.now(),
      name: mcpNameInput.value.trim(),
      transport: transport,
      enabled: mcpEnabledInput.checked,
    };

    if (transport === 'stdio') {
      server.command = mcpCommandInput.value.trim();
      const argsStr = mcpArgsInput.value.trim();
      server.args = argsStr ? argsStr.split(/\s+/) : [];
    } else {
      server.url = mcpUrlInput.value.trim();
    }

    return server;
  }
})();
