import { randomUUID } from 'crypto';

export type SessionStatus = 'idle' | 'busy' | 'error';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Buffered webview message — queued when a session processes in the background
 * and flushed to the webview when the session becomes active.
 */
export interface BufferedMessage {
  type: string;
  [key: string]: unknown;
}

// ===== Smart To-Do types =====

export type TodoItemStatus = 'pending' | 'in-progress' | 'done' | 'failed';

export interface TodoItem {
  id: number;
  title: string;
  status: TodoItemStatus;
  detail?: string;
}

export interface SmartTodoPlan {
  /** The original user request */
  userRequest: string;
  /** Structured list of to-do items */
  todos: TodoItem[];
  /** Current phase: planning → executing → verifying (loops back to executing) */
  phase: 'planning' | 'executing' | 'verifying';
  /** Number of verify iterations completed */
  verifyIterations: number;
  /** Max verify iterations before force-stopping */
  maxIterations: number;
}

export interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  history: SessionMessage[];
  /** Messages buffered while session was in background */
  buffer: BufferedMessage[];
  /** Provider profile ID that was active when this session was created */
  providerId: string | null;
  /** Model ID override for this session */
  modelId: string | null;
  /** Smart To-Do plan state (null if not in smart-todo mode) */
  smartTodo: SmartTodoPlan | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Manages multiple agent sessions, each with independent conversation history,
 * status tracking, and message buffering for background execution.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  private activeSessionId: string | null = null;
  private _onDidChange: (() => void) | null = null;

  /** Register a callback for when sessions change */
  set onDidChange(cb: (() => void) | null) {
    this._onDidChange = cb;
  }

  private fireChange(): void {
    this._onDidChange?.();
  }

  /**
   * Create a new session and return it.
   * Does NOT automatically make it active.
   */
  createSession(providerId: string | null = null, modelId: string | null = null): Session {
    const session: Session = {
      id: randomUUID(),
      title: 'New Chat',
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [],
      buffer: [],
      providerId,
      modelId,
      smartTodo: null,
    };
    this.sessions.set(session.id, session);

    // If this is the first session, make it active
    if (!this.activeSessionId) {
      this.activeSessionId = session.id;
    }

    this.fireChange();
    return session;
  }

  /**
   * Get or create the active session. Ensures there's always one.
   */
  getOrCreateActiveSession(providerId: string | null = null, modelId: string | null = null): Session {
    if (this.activeSessionId) {
      const session = this.sessions.get(this.activeSessionId);
      if (session) { return session; }
    }
    const session = this.createSession(providerId, modelId);
    this.activeSessionId = session.id;
    return session;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getActiveSession(): Session | undefined {
    if (!this.activeSessionId) { return undefined; }
    return this.sessions.get(this.activeSessionId);
  }

  /**
   * Switch to a different session. Returns the new active session.
   */
  switchSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) { return undefined; }
    this.activeSessionId = id;
    this.fireChange();
    return session;
  }

  /**
   * Delete a session. If it's the active one, switch to another or create new.
   */
  deleteSession(id: string): void {
    this.sessions.delete(id);

    if (this.activeSessionId === id) {
      // Switch to the most recently updated remaining session
      const remaining = this.getAllSessions();
      if (remaining.length > 0) {
        remaining.sort((a, b) => b.updatedAt - a.updatedAt);
        this.activeSessionId = remaining[0].id;
      } else {
        this.activeSessionId = null;
      }
    }
    this.fireChange();
  }

  /**
   * Get lightweight summaries of all sessions, sorted by most recent first.
   */
  getSessionList(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.history.filter((m) => m.role !== 'system').length,
      }));
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update session title from the first user message.
   */
  updateTitleFromMessage(sessionId: string, userMessage: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    // Only auto-title if still default
    if (session.title === 'New Chat') {
      session.title = userMessage.length > 50
        ? userMessage.slice(0, 50) + '...'
        : userMessage;
      this.fireChange();
    }
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.status = status;
    session.updatedAt = Date.now();
    this.fireChange();
  }

  addMessage(sessionId: string, message: SessionMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.history.push(message);
    session.updatedAt = Date.now();
  }

  getHistory(sessionId: string): SessionMessage[] {
    return this.sessions.get(sessionId)?.history ?? [];
  }

  clearHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.history = [];
      session.title = 'New Chat';
      session.updatedAt = Date.now();
      this.fireChange();
    }
  }

  /**
   * Buffer a webview message for a background session.
   */
  bufferMessage(sessionId: string, message: BufferedMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.buffer.push(message);
  }

  /**
   * Drain and return all buffered messages, clearing the buffer.
   */
  drainBuffer(sessionId: string): BufferedMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) { return []; }
    const messages = session.buffer;
    session.buffer = [];
    return messages;
  }

  /**
   * Check whether a session is the currently active (visible) one.
   */
  isActiveSession(sessionId: string): boolean {
    return this.activeSessionId === sessionId;
  }

  // ===== Smart To-Do helpers =====

  initSmartTodo(sessionId: string, userRequest: string, maxIterations = 5): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.smartTodo = {
      userRequest,
      todos: [],
      phase: 'planning',
      verifyIterations: 0,
      maxIterations,
    };
    this.fireChange();
  }

  getSmartTodo(sessionId: string): SmartTodoPlan | null {
    return this.sessions.get(sessionId)?.smartTodo ?? null;
  }

  setSmartTodoPhase(sessionId: string, phase: SmartTodoPlan['phase']): void {
    const plan = this.sessions.get(sessionId)?.smartTodo;
    if (!plan) { return; }
    plan.phase = phase;
    this.fireChange();
  }

  setSmartTodoItems(sessionId: string, todos: TodoItem[]): void {
    const plan = this.sessions.get(sessionId)?.smartTodo;
    if (!plan) { return; }
    plan.todos = todos;
    this.fireChange();
  }

  updateSmartTodoItem(sessionId: string, todoId: number, status: TodoItemStatus): void {
    const plan = this.sessions.get(sessionId)?.smartTodo;
    if (!plan) { return; }
    const item = plan.todos.find(t => t.id === todoId);
    if (item) {
      item.status = status;
      this.fireChange();
    }
  }

  incrementVerifyIteration(sessionId: string): number {
    const plan = this.sessions.get(sessionId)?.smartTodo;
    if (!plan) { return 0; }
    plan.verifyIterations += 1;
    return plan.verifyIterations;
  }

  allTodosDone(sessionId: string): boolean {
    const plan = this.sessions.get(sessionId)?.smartTodo;
    if (!plan || plan.todos.length === 0) { return false; }
    return plan.todos.every(t => t.status === 'done');
  }

  hasReachedMaxIterations(sessionId: string): boolean {
    const plan = this.sessions.get(sessionId)?.smartTodo;
    if (!plan) { return true; }
    return plan.verifyIterations >= plan.maxIterations;
  }
}
