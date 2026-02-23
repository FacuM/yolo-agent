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

  let currentView = 'chat'; // 'chat' | 'settings' | 'editor'

  function showView(view) {
    currentView = view;
    chatView.classList.toggle('hidden', view !== 'chat');
    settingsView.classList.toggle('hidden', view !== 'settings');
    editorView.classList.toggle('hidden', view !== 'editor');
  }

  // ===== Chat View Elements =====
  const messagesEl = document.getElementById('messages');
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('message-input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send-btn'));
  const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('mode-select'));
  const providerSelect = /** @type {HTMLSelectElement} */ (document.getElementById('provider-select'));
  const newChatBtn = document.getElementById('new-chat-btn');
  const settingsBtn = document.getElementById('settings-btn');

  // ===== Settings View Elements =====
  const settingsBackBtn = document.getElementById('settings-back-btn');
  const profilesList = document.getElementById('profiles-list');
  const addProfileBtn = document.getElementById('add-profile-btn');

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

  // ===== State =====
  let isStreaming = false;
  let currentAssistantEl = null;
  let currentAssistantText = '';
  let editingProfileId = null; // null = creating new, string = editing existing
  let profiles = [];
  let modes = [];
  let currentModeId = 'agent';

  const DEFAULT_BASE_URLS = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    'openai-compatible': '',
  };

  // ===== Init =====
  showEmptyState();
  vscode.postMessage({ type: 'getProviders' });
  vscode.postMessage({ type: 'getModes' });

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

  // ===== Settings Event Listeners =====
  settingsBackBtn.addEventListener('click', () => {
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
})();
