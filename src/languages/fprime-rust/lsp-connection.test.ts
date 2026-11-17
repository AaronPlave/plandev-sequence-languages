import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseCode, getLspConnection, lspConnectionCount } from './lsp-connection.js';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  closed: number | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  close(code = 1000) {
    this.closed = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  send(message: string) {
    this.sent.push(message);
    const request = JSON.parse(message);
    if (request.method === 'initialize') {
      this.onmessage?.({ data: JSON.stringify({ id: request.id, jsonrpc: '2.0', result: { capabilities: {} } }) });
    }
  }
}

const options = { graceMs: 1000, parkedRetryMs: 5000, webSocket: FakeSocket as unknown as typeof WebSocket };
let n = 0;
const connect = () => getLspConnection(`k${++n}`, 'ws://toolchain/lsp', options);

describe('Rust language server connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it('shares one socket per project and closes it after the last editor goes away', () => {
    const c = connect();
    c.acquire();
    expect(getLspConnection(`k${n}`, 'ignored', options)).toBe(c);
    c.acquire();
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].sent.some(m => m.includes('"initialize"'))).toBe(true);

    c.release();
    c.release();
    // A remount within the grace period keeps the session.
    vi.advanceTimersByTime(500);
    c.acquire();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all[0].closed).toBeNull();

    const before = lspConnectionCount();
    c.release();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all[0].closed).toBe(1000);
    expect(c.isDisposed).toBe(true);
    expect(lspConnectionCount()).toBe(before - 1);
    // Closing after disposal never reconnects.
    FakeSocket.all[0].drop(1006);
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all).toHaveLength(1);
    // The next editor gets a fresh connection.
    expect(getLspConnection(`k${n}`, 'ws://toolchain/lsp', options)).not.toBe(c);
  });

  it('reconnects after a dropped connection with backoff and one timer at a time', () => {
    const c = connect();
    c.acquire();
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop(1012, 'service restart');
    expect(c.status.state).toBe('retrying');
    c.poke(); // edits during backoff don't add attempts
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].drop(1006); // service still down: next wait is 2 s
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    // Still down after several attempts: the editor says so (and keeps trying).
    FakeSocket.all[2].drop(1006);
    vi.advanceTimersByTime(4000);
    FakeSocket.all[3].drop(1006);
    expect(c.status.state).toBe('unreachable');
    vi.advanceTimersByTime(8000);
    FakeSocket.all[4].open();
    expect(c.status.state).toBe('connected');
    // Re-initialized on the new socket; the LSP client then re-sends open documents.
    expect(FakeSocket.all[4].sent.some(m => m.includes('"initialize"'))).toBe(true);
  });

  it('parks after idle/capacity/auth closes and resumes on an edit, rate limited', () => {
    const c = connect();
    c.acquire();
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop(CloseCode.Capacity, 'session limit reached');
    expect(c.status).toEqual({ message: 'session limit reached. Retrying when you edit.', state: 'parked' });
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all).toHaveLength(1); // no automatic retry loop
    c.poke();
    vi.advanceTimersByTime(0);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].drop(CloseCode.Unauthorized, 'token expired');
    c.poke(); // too soon: deferred, not dropped, and not stacked
    c.poke();
    vi.advanceTimersByTime(4999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('gives up on refusals that cannot fix themselves', () => {
    const c = connect();
    c.acquire();
    FakeSocket.all[0].open();
    FakeSocket.all[0].drop(4404, 'src/x.rs is not inside a Cargo project');
    expect(c.status).toEqual({ message: 'src/x.rs is not inside a Cargo project', state: 'failed' });
    c.poke();
    vi.advanceTimersByTime(120000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
