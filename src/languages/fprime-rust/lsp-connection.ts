import { LSPClient, languageServerExtensions, type LSPClientExtension, type Transport } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Close codes the F Prime toolchain service uses (see deployment/fprime/toolchain/server.py in plandev).
 * Anything else below 4000 is a dropped connection (service restart, network), retried with backoff.
 */
export const CloseCode = {
  /** Session closed after no editor activity. Reconnect on the next edit. */
  Idle: 4408,
  /** Session/user limit reached. Retry on the next edit, at most every `parkedRetryMs`. */
  Capacity: 4429,
  /** Credentials rejected (often an expired token). Retry on the next edit, at most every `parkedRetryMs`. */
  Unauthorized: 4401,
} as const;

/**
 * `connected`: the socket is open and the server is starting (indexing, building proc macros).
 * `ready`: the server reported it has finished (rust-analyzer's `experimental/serverStatus`
 * with `quiescent`), so completion, navigation and formatting give real answers.
 */
export type ConnectionStatus =
  | { state: 'connecting' | 'connected' | 'ready' }
  | { state: 'parked' | 'failed' | 'retrying' | 'unreachable'; message: string };

export type ConnectionOptions = {
  /** How long a session outlives its last editor (survives remounts and reconfiguration). */
  graceMs?: number;
  /** Minimum time between reconnects triggered by edits after an idle/capacity/auth close (default 15 s). */
  parkedRetryMs?: number;
  webSocket?: typeof WebSocket;
  /** Client extensions; default `languageServerExtensions()`. */
  extensions?: readonly (Extension | LSPClientExtension)[];
};

/**
 * One rust-analyzer session, shared by every open editor in the same Cargo project. Refcounted by
 * editors: the last one to close starts a grace timer, after which the socket is closed (the
 * service then kills rust-analyzer) and the entry is forgotten. Unsaved text is never lost on a
 * reconnect: the LSP client re-sends every open document when it connects.
 */
export class LspConnection {
  readonly client: LSPClient;
  /**
   * Shows a file the server points at (Go to Definition into another file). lsp-client's default
   * workspace can only show files that already have an editor; SeqDev has one editor at a time.
   */
  displayFile: ((uri: string) => Promise<EditorView | null>) | null = null;
  status: ConnectionStatus = { state: 'connecting' };
  private attempt = 0;
  private disposed = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAttempt = 0;
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private socket: WebSocket | null = null;
  private users = 0;

  constructor(
    readonly url: string,
    private readonly onDispose: () => void,
    private readonly options: ConnectionOptions = {},
  ) {
    const readiness: LSPClientExtension = {
      clientCapabilities: { experimental: { serverStatusNotification: true } },
      notificationHandlers: {
        'experimental/serverStatus': (_client, params: { quiescent?: boolean }) => {
          if (params.quiescent && this.status.state === 'connected') this.setStatus({ state: 'ready' });
          return true;
        },
      },
    };
    this.client = new LSPClient({
      // ponytail: readiness comes from rust-analyzer's serverStatus; another server would stay "connected".
      extensions: [...(options.extensions ?? languageServerExtensions()), readiness],
      rootUri: 'file:///seqdev/',
      // rust-analyzer can take several seconds on a cold project; don't fail requests at 3 s.
      timeout: 20000,
    });
    this.client.workspace.displayFile = uri => this.displayFile?.(uri) ?? Promise.resolve(null);
  }

  get isDisposed() {
    return this.disposed;
  }

  get openSockets() {
    return this.socket ? 1 : 0;
  }

  acquire(listener?: (status: ConnectionStatus) => void) {
    if (listener) this.listeners.add(listener);
    this.users++;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (this.status.state === 'connecting' && !this.socket && !this.retryTimer) this.open();
    else this.poke();
  }

  release(listener?: (status: ConnectionStatus) => void) {
    if (listener) this.listeners.delete(listener);
    if (--this.users > 0 || this.disposed) return;
    this.graceTimer = setTimeout(() => this.dispose(), this.options.graceMs ?? 15000);
  }

  /** An editor changed: wake a session that was closed for idleness, capacity or credentials. */
  poke() {
    if (this.status.state !== 'parked' || this.socket || this.retryTimer) return;
    // Too soon after the last attempt: retry once the interval is up, rather than dropping the edit.
    const wait = this.lastAttempt + (this.options.parkedRetryMs ?? 15000) - Date.now();
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.open();
      },
      Math.max(0, wait),
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'editor closed');
    this.client.disconnect();
    this.onDispose();
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.listeners.forEach(l => l(status));
  }

  private open() {
    if (this.disposed) return;
    this.lastAttempt = Date.now();
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(this.url);
    this.socket = socket;
    const handlers: ((message: string) => void)[] = [];
    socket.onmessage = event => handlers.forEach(h => h(String(event.data)));
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      const transport: Transport = {
        send: message => socket.readyState === Socket.OPEN && socket.send(message),
        subscribe: handler => handlers.push(handler),
        unsubscribe: handler => handlers.splice(handlers.indexOf(handler) >>> 0, 1),
      };
      this.client.connect(transport);
      this.setStatus({ state: 'connected' });
    };
    socket.onclose = event => {
      if (this.socket !== socket) return; // superseded or disposed
      this.socket = null;
      this.client.disconnect();
      if (this.disposed) return;
      const reason = event.reason || `connection closed (${event.code})`;
      if (event.code === CloseCode.Idle) {
        this.setStatus({ state: 'parked', message: 'paused while idle; it resumes when you edit' });
      } else if (event.code === CloseCode.Capacity || event.code === CloseCode.Unauthorized) {
        this.setStatus({ state: 'parked', message: `${reason}. Retrying when you edit.` });
      } else if (event.code >= 4000 && event.code < 5000) {
        // The service refused this file for good (no access, not in a Cargo project, ...).
        this.setStatus({ state: 'failed', message: reason });
      } else {
        // Service restart or network drop: keep trying, without stacking timers.
        const delay = Math.min(30000, 1000 * 2 ** this.attempt++);
        // Brief drops (a restart) are routine; say so once it is clearly not coming back by itself.
        this.setStatus(
          this.attempt > 3
            ? {
                message: 'unreachable; editing continues without it and it reconnects when the service is back',
                state: 'unreachable',
              }
            : { message: 'disconnected; reconnecting…', state: 'retrying' },
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.open();
        }, delay);
      }
    };
  }
}

const connections = new Map<string, LspConnection>();

/** The shared connection for a key, created on first use. */
export function getLspConnection(key: string, url: string, options?: ConnectionOptions): LspConnection {
  let connection = connections.get(key);
  if (!connection || connection.isDisposed) {
    const created = new LspConnection(url, () => connections.get(key) === created && connections.delete(key), options);
    connection = created;
    connections.set(key, connection);
  }
  return connection;
}

/** Live connections; for diagnostics and tests. */
export function lspConnectionCount(): number {
  return connections.size;
}
