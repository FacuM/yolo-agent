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

  let currentView = 'chat'; // 'chat' | 'settings' | 'editor' | 'context' | 'mcp' | 'mcp-editor'

  function showView(view) {
    currentView = view;
    chatView.classList.toggle('hidden', view !== 'chat');
    settingsView.classList.toggle('hidden', view !== 'settings');
    editorView.classList.toggle('hidden', view !== 'editor');
    contextView.classList.toggle('hidden', view !== 'context');
    mcpView.classList.toggle('hidden', view !== 'mcp');
    mcpEditorView.classList.toggle('hidden', view !== 'mcp-editor');
  }

  // ===== Chat View Elements =====
  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('message-input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send-btn'));
  const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('mode-select'));
  const providerSelect = /** @type {HTMLSelectElement} */ (document.getElementById('provider-select'));
  const newChatBtn = document.getElementById('new-chat-btn');
  const contextBtn = document.getElementById('context-btn');
  const settingsBtn = document.getElementById('settings-btn');

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
  let currentModeId = 'agent';
  let contextSkills = [];
  let contextAgentsMd = [];
  let mcpServers = [];
  let editingMcpServerId = null;

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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  providerSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'switchProvider', providerId: providerSelect.value });
  });

  modeSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setMode', modeId: modeSelect.value });
  });

  newChatBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newChat' });
  });

  settingsBtn.addEventListener('click', () => {
    showView('settings');
    vscode.postMessage({ type: 'getProfiles' });
  });

  contextBtn.addEventListener('click', () => {
    showView('context');
    vscode.postMessage({ type: 'getContext' });
  });

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
      case 'streamChunk':
        handleStreamChunk(message.content);
        break;
      case 'thinking':
        handleThinking(message.content);
        break;
      case 'toolCallStarted':
        handleToolCallStarted(message.name, message.id);
        break;
      case 'toolCallResult':
        handleToolCallResult(message.id, message.name, message.content, message.isError);
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

  // ===== Chat Functions =====

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) { return; }

    removeEmptyState();
    appendMessage('user', text);

    vscode.postMessage({ type: 'sendMessage', text });

    inputEl.value = '';
    isStreaming = true;
    sendBtn.disabled = true;

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

  function handleToolCallStarted(name, id) {
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
    contentEl.textContent = 'Executing...';

    card.appendChild(header);
    card.appendChild(contentEl);
    messagesEl.appendChild(card);
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
      const contentEl = card.querySelector('.tool-call-content');
      if (contentEl) {
        contentEl.textContent = content;
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
    sendBtn.disabled = false;
    removeStreamingCursor();
    currentAssistantEl = null;
    currentAssistantText = '';
    inputEl.focus();
  }

  function handleError(msg) {
    isStreaming = false;
    sendBtn.disabled = false;
    removeStreamingCursor();
    currentAssistantEl = null;
    currentAssistantText = '';

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
