# Terminal Focused View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the focused view's chat transcript + composer with a live terminal (xterm.js) wired directly to the session's existing persistent PTY, so interaction has real-time visibility instead of inferring state from a side-channel transcript file.

**Architecture:** Server keeps owning one persistent PTY per session (unchanged), but each PTY entry gains a bounded ring buffer (for reconnect replay) and a serialized write lock (structural single-writer guarantee, not a best-effort check). Four new WS message types (`attachTerm`/`detachTerm`/`termInput`/`termResize`) replace `send`/`cancel`. The web side gets a new `TerminalView` (renders the live stream via xterm.js) and `TermComposer` (plain input box, submits via `termInput`) replacing `ChatTranscript`/`Composer`/`WorkingIndicator`/`QueuedMessage`/in-chat `QuestionCard`. Card/canvas overview is untouched.

**Tech Stack:** `@xterm/xterm` + `@xterm/addon-fit` (web), existing `node-pty`/`ws` (server), Vitest, React 18.

**Spec:** `docs/superpowers/specs/2026-07-16-terminal-focused-view-design.md`

---

## Task 1: Ring buffer + write lock on the PTY entry

**Files:**
- Modify: `server/src/sender.ts:105-110` (the `PersistentPty` interface), and the spawn sites at `server/src/sender.ts:144-166` and `server/src/sender.ts:568-675`
- Test: `server/test/sender.test.ts`

- [ ] **Step 1: Write the failing tests for the ring buffer**

Add to `server/test/sender.test.ts` (check current imports at the top of that file first — it currently imports `countLines`/`didMessageLand`; those imports and their tests will be removed in Task 3, but for now just add the new tests alongside):

```ts
import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../src/sender.js';

describe('RingBuffer', () => {
  it('replays everything written so far, in order, under the cap', () => {
    const buf = new RingBuffer(1024);
    buf.push(Buffer.from('hello '));
    buf.push(Buffer.from('world'));
    expect(buf.replay().toString('utf8')).toBe('hello world');
  });

  it('drops the oldest bytes once the cap is exceeded, keeping the tail', () => {
    const buf = new RingBuffer(10);
    buf.push(Buffer.from('0123456789')); // exactly the cap
    buf.push(Buffer.from('AB')); // pushes it 2 over
    expect(buf.replay().toString('utf8')).toBe('23456789AB');
  });

  it('a single push larger than the cap keeps only its own tail', () => {
    const buf = new RingBuffer(5);
    buf.push(Buffer.from('abcdefghij'));
    expect(buf.replay().toString('utf8')).toBe('fghij');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/sender.test.ts`
Expected: FAIL with "RingBuffer is not exported" or similar (it doesn't exist yet).

- [ ] **Step 3: Implement `RingBuffer` in `sender.ts`**

Add near the top of `server/src/sender.ts`, after the existing constants block (after line 103, before the `interface PersistentPty` block):

```ts
/** Caps how much raw PTY output a session's ring buffer retains for replay
 *  on attach/reconnect — big enough to redraw a full screen plus some
 *  scrollback, small enough that many idle sessions don't add up. */
const RING_BUFFER_CAP_BYTES = 256 * 1024;

/** Bounded byte buffer of the most recent raw PTY output for one session —
 *  what a client attaching (or reconnecting) replays before it starts
 *  receiving live output, so the terminal redraws the current screen instead
 *  of starting blank. Oldest bytes are dropped first once the cap is hit. */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    // Trim from the front until back under the cap — a chunk entirely
    // outside the cap window is dropped whole; one straddling the boundary
    // is sliced down to just its tail, not dropped wholesale (dropping it
    // would lose bytes that are still within the cap).
    while (this.total > this.cap) {
      const first = this.chunks[0];
      const excess = this.total - this.cap;
      if (first.length <= excess) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.total -= excess;
      }
    }
  }

  replay(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/sender.test.ts`
Expected: PASS (the three new `RingBuffer` tests).

- [ ] **Step 5: Write the failing test for the write lock's serialization guarantee**

Add to `server/test/sender.test.ts`, updating the import line to also pull in `AsyncLock`:

```ts
import { AsyncLock, RingBuffer } from '../src/sender.js';

describe('AsyncLock', () => {
  it('runs queued work strictly one at a time, in call order, even if an earlier call is still pending', async () => {
    const lock = new AsyncLock();
    const order: number[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const a = lock.run(async () => {
      order.push(1);
      await delay(20); // slow first call
      order.push(2);
    });
    const b = lock.run(async () => {
      order.push(3); // must not run until `a`'s work above has fully finished
    });

    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a rejected call does not break the chain for the next one', async () => {
    const lock = new AsyncLock();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push('a');
      throw new Error('boom');
    });
    const b = lock.run(async () => {
      order.push('b');
    });

    await expect(a).rejects.toThrow('boom');
    await b;
    expect(order).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd server && npx vitest run test/sender.test.ts`
Expected: FAIL with "AsyncLock is not exported" (it exists from Step 5 below but isn't exported yet — write this test first, then export it in the next step, confirming the test genuinely exercises the real class).

- [ ] **Step 7: Add the write lock helper (exported)**

Add directly below the `RingBuffer` class in `server/src/sender.ts`:

```ts
/** Serializes async work per key — the structural fix for the concurrent-
 *  write corruption found in #13: two independent callers writing to the
 *  same session's PTY at once (e.g. a WS reconnect racing an in-flight send)
 *  would clear-and-retype over each other. A per-WS-handler check can be
 *  bypassed by a future code path that forgets it; a lock owned by the PTY
 *  entry itself cannot be — every write, from wherever it originates, queues
 *  on the same promise chain and runs strictly one at a time. */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd server && npx vitest run test/sender.test.ts`
Expected: PASS (all five tests: three `RingBuffer`, two `AsyncLock`).

- [ ] **Step 9: Extend `PersistentPty` with the buffer, lock, and subscriber set**

Replace the `PersistentPty` interface at `server/src/sender.ts:105-110`:

```ts
interface PersistentPty {
  pty: IPty;
  pid: number;
  cwd: string;
  lastActivity: number;
  /** Recent raw output, replayed to a client that attaches or reconnects. */
  buffer: RingBuffer;
  /** Structural single-writer guarantee — see AsyncLock. */
  writeLock: AsyncLock;
  /** WS connections currently attached to this session's live output. */
  subscribers: Set<FocusWsLike>;
}

/** The minimal shape sender.ts needs from a WS connection — avoids importing
 *  the `ws` package's own WebSocket type here just for a `send`/`readyState`
 *  call; index.ts's FocusWs already satisfies this structurally. */
interface FocusWsLike {
  readyState: number;
  send(data: string): void;
}
```

- [ ] **Step 10: Wire the buffer/lock/subscribers into both spawn sites**

In `spawnPersistent` (`server/src/sender.ts:144-166`), the `p.onData` callback currently only exists inside `drainAndTrack`. Replace the whole function body:

```ts
async function spawnPersistent(sessionId: string, cwd: string): Promise<PersistentPty> {
  // pty.spawn can throw synchronously (seen under heavy concurrent load —
  // several `claude` processes competing for resources at once). This
  // function's own async-ness turns that into a rejected promise instead of
  // an uncaught throw, which is what the caller (and its caller) needs to
  // hand back a clean onError rather than taking the daemon down with it.
  const p = pty.spawn(resolveClaudeExecutable(), ['--dangerously-skip-permissions', '--resume', sessionId], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd,
    env: cleanEnv(),
  });
  const buffer = new RingBuffer(RING_BUFFER_CAP_BYTES);
  const subscribers = new Set<FocusWsLike>();
  const idleFor = drainAndTrack(p);
  p.onData((chunk: string) => {
    const bytes = Buffer.from(chunk, 'utf8');
    buffer.push(bytes);
    for (const sub of subscribers) {
      if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'termOutput', sessionId, chunk }));
    }
  });
  p.onExit(() => {
    // Only remove if this exit is for the entry we think is current — a
    // stale onExit firing after eviction-and-respawn must not delete the
    // NEW live entry out from under it.
    if (readyPtys.get(sessionId)?.pid === p.pid) readyPtys.delete(sessionId);
  });
  await waitForPtyQuiet(idleFor);
  return { pty: p, pid: p.pid ?? -1, cwd, lastActivity: Date.now(), buffer, writeLock: new AsyncLock(), subscribers };
}
```

Do the equivalent in `spawnSession` (`server/src/sender.ts:568-675`) — replace the `p.onExit(...)`/`readyPtys.set(...)` block near the end (lines 656-659) with:

```ts
    const buffer = new RingBuffer(RING_BUFFER_CAP_BYTES);
    const subscribers = new Set<FocusWsLike>();
    p.onData((chunk: string) => {
      const bytes = Buffer.from(chunk, 'utf8');
      buffer.push(bytes);
      for (const sub of subscribers) {
        if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'termOutput', sessionId: found.sessionId, chunk }));
      }
    });
    p.onExit(() => {
      if (readyPtys.get(found.sessionId)?.pid === p.pid) readyPtys.delete(found.sessionId);
    });
    readyPtys.set(found.sessionId, {
      pty: p,
      pid: p.pid ?? -1,
      cwd,
      lastActivity: Date.now(),
      buffer,
      writeLock: new AsyncLock(),
      subscribers,
    });
```

Note this registers the `onData` listener (and starts buffering) immediately after spawn — before the session id is even known — so the whole boot sequence (MCP connections, etc.) is captured. A client that attaches before the session id is discovered still sees it live once Task 2 wires attach-by-pending-spawn; for this first cut, a client simply attaches once the card for the new session appears, same timing as today.

- [ ] **Step 11: Typecheck and run the full server test suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: both PASS, 0 errors.

- [ ] **Step 12: Commit**

```bash
git add server/src/sender.ts server/test/sender.test.ts
git commit -m "feat: add ring buffer and write lock to persistent PTY entries"
```

---

## Task 2: Terminal WS protocol in `sender.ts` + `index.ts`

**Files:**
- Modify: `server/src/sender.ts` (add `attachTerminal`/`detachTerminal`/`writeTermInput`/`resizeTerm`)
- Modify: `server/src/index.ts:181-312` (the `wss.on('connection', ...)` handler)

- [ ] **Step 1: Add the attach/detach/write/resize functions to `sender.ts`**

Add these exported functions after `getOrSpawnPty` (after line 189 in the current file):

```ts
/** Attach a WS connection to a session's live terminal output — ensures the
 *  PTY is live (spawning if needed), replays its ring buffer to `ws`
 *  immediately, then subscribes `ws` to future output. Returns 'error' with
 *  a message if the PTY couldn't be reached at all. */
export async function attachTerminal(
  sessionId: string,
  cwd: string,
  ws: FocusWsLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let entry: PersistentPty;
  try {
    entry = await getOrSpawnPty(sessionId, cwd);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  entry.subscribers.add(ws);
  entry.lastActivity = Date.now();
  const replay = entry.buffer.replay();
  if (replay.length && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'termOutput', sessionId, chunk: replay.toString('utf8') }));
  }
  return { ok: true };
}

/** Stop streaming this session's output to `ws` — the PTY itself is
 *  untouched, exactly like closing one terminal window onto a tmux session
 *  that keeps running. */
export function detachTerminal(sessionId: string, ws: FocusWsLike): void {
  readyPtys.get(sessionId)?.subscribers.delete(ws);
}

/** Write text (plus any pasted images, saved to temp files and noted the
 *  same way today's send path already does) to a session's PTY, serialized
 *  through its write lock so a second concurrent call can never interleave
 *  with this one. Defensively clears whatever's on the input line first —
 *  see the matching comment history on this exact sequence for why it isn't
 *  always empty (the CLI restores Escape-interrupted text into the input
 *  line for editing). */
export async function writeTermInput(
  sessionId: string,
  cwd: string,
  text: string,
  images: string[] | undefined,
): Promise<void> {
  const entry = await getOrSpawnPty(sessionId, cwd);
  entry.lastActivity = Date.now();
  const fullText = withImageNotes(text, sessionId, images);
  await entry.writeLock.run(async () => {
    entry.pty.write('\x01\x0b');
    entry.pty.write(`${fullText}\r`);
  });
}

/** Resize a session's PTY to match its terminal panel's actual size. */
export function resizeTerm(sessionId: string, cols: number, rows: number): void {
  const entry = readyPtys.get(sessionId);
  entry?.pty.resize(cols, rows);
}
```

- [ ] **Step 2: Replace the `send`/`cancel` WS handlers in `index.ts`**

In `server/src/index.ts`, replace the import on line 6:

```ts
import { attachTerminal, detachTerminal, writeTermInput, resizeTerm, spawnSession, startIdleEvictionSweep, shutdownAllSessions } from './sender.js';
```

Replace the `FocusWs` interface (`server/src/index.ts:31-36`) to track the attached session:

```ts
interface FocusWs extends WebSocket {
  focusFile?: string;
  focusSession?: string;
  focusSubagentFile?: string;
  focusSubagentId?: string;
  /** The session this connection is currently streaming live terminal output for. */
  termSession?: string;
}
```

Add a disconnect cleanup — insert right after the `wss.on('connection', (ws: FocusWs) => {` line (`server/src/index.ts:181`), before the existing `ws.send(JSON.stringify(current));`:

```ts
    ws.on('close', () => {
      if (ws.termSession) detachTerminal(ws.termSession, ws);
    });
```

Replace the entire `send`/`cancel` block (`server/src/index.ts:207-277`, from `} else if (m.type === 'send' ...` through the `} else if (m.type === 'cancel' ...` block) with:

```ts
      } else if (m.type === 'attachTerm' && m.sessionId && m.cwd) {
        ws.termSession = m.sessionId;
        void attachTerminal(m.sessionId, m.cwd, ws).then((result) => {
          if (!result.ok && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'termError', sessionId: m.sessionId, error: result.error }));
          }
        });
      } else if (m.type === 'detachTerm' && m.sessionId) {
        detachTerminal(m.sessionId, ws);
        if (ws.termSession === m.sessionId) ws.termSession = undefined;
      } else if (m.type === 'termInput' && m.sessionId && m.cwd && typeof m.text === 'string') {
        void writeTermInput(m.sessionId, m.cwd, m.text, Array.isArray(m.images) ? m.images : undefined).catch((e) => {
          if (ws.readyState === 1)
            ws.send(
              JSON.stringify({
                type: 'termError',
                sessionId: m.sessionId,
                error: e instanceof Error ? e.message : String(e),
              }),
            );
        });
      } else if (m.type === 'termResize' && m.sessionId && typeof m.cols === 'number' && typeof m.rows === 'number') {
        resizeTerm(m.sessionId, m.cols, m.rows);
```

Note the `inFlight` map (`server/src/index.ts:88`) and its use in the deleted `send`/`cancel`/`spawn`-tracking code: `spawn` (the "+ new session" flow) still uses `inFlight` for its own cancel handle — leave that part of the `spawn` handler (`server/src/index.ts:278-309`) untouched; only the `send`/`cancel` block is replaced.

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: PASS, 0 errors. (`FocusWsLike`'s `readyState: number` and `send(data: string): void` should already structurally match `ws`'s real `WebSocket` type — if not, adjust `FocusWsLike` in `sender.ts` to match exactly what's passed.)

- [ ] **Step 4: Commit**

```bash
git add server/src/sender.ts server/src/index.ts
git commit -m "feat: add attachTerm/detachTerm/termInput/termResize WS protocol"
```

---

## Task 3: Delete the now-dead send/queue machinery

**Files:**
- Modify: `server/src/sender.ts` (delete `sendToSession`, `waitForTurnToFinish`, `didMessageLand`, `countLines`)
- Modify: `server/test/sender.test.ts` (delete their tests)

- [ ] **Step 1: Delete the dead functions from `sender.ts`**

Delete these four blocks entirely (verify current line numbers with `grep -n "^async function waitForTurnToFinish\|^export async function countLines\|^export async function didMessageLand\|^export function sendToSession" server/src/sender.ts` before deleting, since Task 1/2's edits shift line numbers):
- `waitForTurnToFinish` (the whole function, including its long comment block)
- `countLines`
- `didMessageLand`
- `sendToSession` (the whole function, including its `SendHandle` usage — but keep the `SendHandle` interface itself, since `spawnSession` still uses it)

- [ ] **Step 2: Remove their tests from `server/test/sender.test.ts`**

Delete the `describe`/`it` blocks that test `countLines` and `didMessageLand`, and remove those two names from the import line at the top of the file (keep `RingBuffer` from Task 1).

- [ ] **Step 3: Typecheck and run tests**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: both PASS. If `tsc` flags an unused import or a now-dangling reference, fix it inline.

- [ ] **Step 4: Commit**

```bash
git add server/src/sender.ts server/test/sender.test.ts
git commit -m "refactor: delete sendToSession and its polling/verification machinery"
```

---

## Task 4: `TerminalView` and `TermComposer` web components

**Files:**
- Modify: `web/package.json` (add `@xterm/xterm`, `@xterm/addon-fit`)
- Create: `web/src/components/TerminalView.tsx`
- Create: `web/src/components/TermComposer.tsx`

- [ ] **Step 1: Install xterm.js**

Run: `cd web && pnpm add @xterm/xterm @xterm/addon-fit`
Expected: both added to `web/package.json` dependencies.

- [ ] **Step 2: Build `TerminalView.tsx`**

Create `web/src/components/TerminalView.tsx`. `onResize` is captured in a ref (kept fresh every render) rather than listed as an effect dependency, since it's a fresh function identity on every parent render and would otherwise force the terminal to tear down and rebuild constantly instead of only on a genuine session switch (`resetKey` change):

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** Renders a session's live raw PTY output. `chunk` is the latest raw text
 *  to append; `resetKey` changing forces a fresh Terminal instance (used
 *  when switching sessions, since xterm.js doesn't support re-pointing one
 *  instance at a different backing stream cleanly). Font size mirrors the
 *  app's existing A-/A+ control directly via xterm's own `fontSize` option,
 *  not the old `--chat-font` CSS variable (which only ever styled the chat
 *  reconstruction this replaces). */
export function TerminalView({
  resetKey,
  chunk,
  fontSize,
  onResize,
}: {
  resetKey: string;
  chunk: string | null;
  fontSize: number;
  onResize: (cols: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontSize: fontSizeRef.current,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
      },
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    onResizeRef.current(term.cols, term.rows);
    termRef.current = term;

    const ro = new ResizeObserver(() => {
      fit.fit();
      onResizeRef.current(term.cols, term.rows);
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [resetKey]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
  }, [fontSize]);

  useEffect(() => {
    if (termRef.current && chunk) termRef.current.write(chunk);
  }, [chunk]);

  return <div className="terminal-view" ref={containerRef} />;
}
```

Note: the spec's inline-image-thumbnail decoration (detecting `[Pasted image N — read this file to view it: <path>]` and pinning a `registerDecoration` thumbnail) is deliberately deferred past this first cut — this task only wires faithful raw-text rendering, matching "let's see how usable it is and go from there." Image notes stay visible as plain text for now.

- [ ] **Step 3: Build `TermComposer.tsx`**

Create `web/src/components/TermComposer.tsx`:

```tsx
import { useRef, useState } from 'react';

let pasteIdSeq = 0;

/** Plain input box for a session's terminal — no sending/queued state at
 *  all, since the terminal view right above it is what shows whether
 *  anything happened. Enter submits (writes text + Enter to the pty via
 *  onSend); Shift+Enter inserts a newline. Paste-image keeps the existing
 *  save-to-temp-file + inject-a-note trick, since a real terminal has no
 *  native image paste. */
export function TermComposer({
  onSend,
  inputRef,
}: {
  onSend: (text: string, images?: string[]) => void;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<{ id: string; dataUrl: string }[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const rows = Math.min(3, Math.max(1, value.split('\n').length));

  const submit = () => {
    const t = value.trim();
    if (!t && !images.length) return;
    onSend(t, images.map((i) => i.dataUrl));
    setValue('');
    setImages([]);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items]
      .filter((it) => it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      const id = String(pasteIdSeq++);
      reader.onload = () => {
        if (typeof reader.result === 'string') setImages((imgs) => [...imgs, { id, dataUrl: reader.result as string }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = (id: string) => setImages((imgs) => imgs.filter((i) => i.id !== id));

  return (
    <div className="term-composer">
      {images.length > 0 && (
        <div className="term-composer__images">
          {images.map((img) => (
            <div className="term-composer__thumb" key={img.id}>
              <img src={img.dataUrl} alt="pasted" />
              <button className="term-composer__thumb-remove" onClick={() => removeImage(img.id)} title="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="term-composer__row">
        <textarea
          ref={(el) => {
            ref.current = el;
            if (inputRef) inputRef.current = el;
          }}
          className="term-composer__input"
          placeholder="Type into this session's terminal…   (Enter to send · Shift+Enter for newline · paste an image to attach)"
          value={value}
          rows={rows}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={onPaste}
        />
        <button className="term-composer__send" onClick={submit} disabled={!value.trim() && !images.length}>
          Send
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/src/components/TerminalView.tsx web/src/components/TermComposer.tsx
git commit -m "feat: add TerminalView and TermComposer components"
```

**Note on `TermComposer` unit testing**: the spec mentions unit-testing its submit behavior "with existing patterns," but this repo has no web unit-test infrastructure at all today (`web/package.json` has no `vitest`/testing-library, and no existing component has a test) — every other component is verified live instead. Setting up a new test framework for one component would be scope creep beyond this MVP. `TermComposer`'s submit/paste behavior is covered by the live verification in Task 8 instead, consistent with the rest of this codebase; revisit if web unit tests get adopted more broadly later.

---

## Task 5: `api.ts` — terminal attach/send surface

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add terminal state and WS message handling**

In `web/src/api.ts`, add to the `Shepherd` interface (after the `messages`/`hasMore` fields, replacing the `send`/`cancel`/`sendingIds`/`queue*`/`liveElsewhere*` fields listed at lines 44-59 and 70-75):

```ts
  /** Latest raw output chunk for the attached terminal session, or null if
   *  nothing has streamed yet this attach. Cleared to null on session switch
   *  so a stale chunk never gets replayed into the wrong TerminalView. */
  termChunk: string | null;
  /** Bumped every time the attached session changes — TerminalView keys off
   *  this to force a fresh xterm.js instance rather than reusing one across
   *  sessions. */
  termResetKey: string;
  attachTerminal: (sessionId: string, cwd: string) => void;
  detachTerminal: (sessionId: string) => void;
  sendTermInput: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  resizeTerm: (sessionId: string, cols: number, rows: number) => void;
  termError: string | null;
```

Remove the now-dead fields from that interface: `send`, `cancel`, `sendingIds`, `queueSend`, `dequeueSend`, `queuedMsgs`, `forceSendQueued`, `liveElsewhereWarnings`, `dismissLiveElsewhereWarning`, and (from the earlier uncommitted work) `sendingSince`, `QueuedDraft` usage.

Add state near the other `useState` calls in `useShepherd` (replacing the `sendingIds`/`pending`/`queuedMsgs`/`liveElsewhereWarnings` block — keep `spawning`, that's for the `+` card and unrelated to this change):

```ts
  const [termChunk, setTermChunk] = useState<string | null>(null);
  const [termResetKey, setTermResetKey] = useState('');
  const [termError, setTermError] = useState<string | null>(null);
```

In the `ws.onmessage` handler, replace the `send-done`/`send-error`/`send-cancelled` branch (`web/src/api.ts:257-301`) with:

```ts
        } else if (d.type === 'termOutput') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          setTermChunk(d.chunk);
        } else if (d.type === 'termError') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          setTermError(d.error);
        }
```

Delete the `PendingEcho`/`pending`/`mergeTail`'s pending-echo-drop logic tied to `send` (the `setPending` block inside the `d.type === 'transcript'` branch, `web/src/api.ts:230-245`) — the transcript-tail merging itself (`mergeTail`, the rest of that branch) stays, since the card overview still needs it.

- [ ] **Step 2: Add the attach/detach/send/resize functions**

Replace `send`/`queueSend`/`dequeueSend`/the auto-flush effect/`cancel`/`forceSendQueued`/`dismissLiveElsewhereWarning` (`web/src/api.ts:362-491`) with:

```ts
  const attachTerminal = useCallback((sessionId: string, cwd: string) => {
    setTermChunk(null);
    setTermError(null);
    setTermResetKey(sessionId);
    wsSend(wsRef.current, { type: 'attachTerm', sessionId, cwd });
  }, []);

  const detachTerminal = useCallback((sessionId: string) => {
    wsSend(wsRef.current, { type: 'detachTerm', sessionId });
  }, []);

  const sendTermInput = useCallback((sessionId: string, cwd: string, text: string, images?: string[]) => {
    setTermError(null);
    wsSend(wsRef.current, { type: 'termInput', sessionId, cwd, text, images });
  }, []);

  const resizeTerm = useCallback((sessionId: string, cols: number, rows: number) => {
    wsSend(wsRef.current, { type: 'termResize', sessionId, cols, rows });
  }, []);
```

Note: the actual image-file-saving still happens server-side (`writeTermInput` in Task 2 already calls the existing `withImageNotes` helper) — the client just forwards the raw base64 data URLs it already collected, same shape as today's `send`.

- [ ] **Step 3: Update the hook's return value**

`focus`/`unfocus`/`loadMore`/`messages`/`hasMore` (`web/src/api.ts:325-360`) stay as-is — they're harmless if the focused view no longer renders a chat transcript from them, and removing them is out of scope for this pass (YAGNI cuts both ways; don't expand this task into a transcript-protocol cleanup).

Update the hook's return object (`web/src/api.ts:519-544`) to match the new field set from Step 1 — remove the deleted fields, add `termChunk`, `termResetKey`, `attachTerminal`, `detachTerminal`, `sendTermInput`, `resizeTerm`, `termError`.

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: FAILS at this point — `App.tsx` and `FocusView.tsx` still reference the deleted fields. That's expected; Tasks 6 fixes it. Confirm the errors are ONLY in `App.tsx`/`FocusView.tsx`/`Composer.tsx`/`ChatTranscript.tsx`/`QuestionCard.tsx`/`WorkingIndicator.tsx`/`QueuedMessage.tsx`, not in `api.ts` itself.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts
git commit -m "refactor: replace send/queue surface in api.ts with terminal attach/send"
```

---

## Task 6: Wire `FocusView` and `App` to the terminal, delete dead components

**Files:**
- Modify: `web/src/components/FocusView.tsx` (full rewrite)
- Modify: `web/src/App.tsx:23-50, 176-207`
- Delete: `web/src/components/ChatTranscript.tsx`, `web/src/components/Composer.tsx`, `web/src/components/WorkingIndicator.tsx`, `web/src/components/QueuedMessage.tsx`, `web/src/components/QuestionCard.tsx`

- [ ] **Step 1: Rewrite `FocusView.tsx`**

Replace the entire contents of `web/src/components/FocusView.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { AgentModel, ChatMsg, SubagentInfo } from '../types';
import { CardStrip } from './CardStrip';
import { TerminalView } from './TerminalView';
import { TermComposer } from './TermComposer';
import { SubagentModal } from './SubagentModal';

export function FocusView({
  agents,
  focused,
  now,
  colorOf,
  nameOf,
  onSelect,
  onExit,
  onRename,
  fontSize,
  onFontSize,
  onHide,
  onSpawn,
  spawningProducts,
  activeSubagents,
  onSelectSubagent,
  onCloseSubagent,
  subagentModal,
  termChunk,
  termResetKey,
  termError,
  onAttachTerminal,
  onDetachTerminal,
  onSendTermInput,
  onResizeTerm,
}: {
  agents: AgentModel[];
  focused: AgentModel;
  now: number;
  colorOf: (product: string) => string;
  nameOf: (a: AgentModel) => string;
  onSelect: (a: AgentModel) => void;
  onExit: () => void;
  onRename: (sessionId: string, name: string) => void;
  fontSize: number;
  onFontSize: (delta: number) => void;
  onHide: (sessionId: string) => void;
  onSpawn: (product: string) => void;
  spawningProducts: Set<string>;
  activeSubagents: SubagentInfo[];
  onSelectSubagent: (s: SubagentInfo) => void;
  onCloseSubagent: () => void;
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
  termChunk: string | null;
  termResetKey: string;
  termError: string | null;
  onAttachTerminal: (sessionId: string, cwd: string) => void;
  onDetachTerminal: (sessionId: string) => void;
  onSendTermInput: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  onResizeTerm: (sessionId: string, cols: number, rows: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = nameOf(focused);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Attach on mount / whenever the focused session changes; detach on
  // unmount / session switch. The PTY itself keeps running either way (see
  // sender.ts's idle-eviction) — this only stops/starts streaming to us.
  // The attach/detach callbacks are captured in a ref so this effect's only
  // real dependency is which session is focused, not the callbacks' own
  // (recreated-every-render) identity.
  const attachRef = useRef({ onAttachTerminal, onDetachTerminal });
  attachRef.current = { onAttachTerminal, onDetachTerminal };
  useEffect(() => {
    attachRef.current.onAttachTerminal(focused.sessionId, focused.cwd);
    return () => attachRef.current.onDetachTerminal(focused.sessionId);
  }, [focused.sessionId, focused.cwd]);

  // Same "stay focused unless you're doing something else" behavior as
  // before, minus the mouseup-reclaim edge cases that no longer apply
  // (there's no chat transcript text to select here) — but still release on
  // window blur so keystrokes after an OS-level tab switch don't land here
  // unintentionally (see FocusView history / design spec for why).
  useEffect(() => {
    if (subagentModal) return;
    const releaseOnBlur = () => {
      if (document.activeElement === composerInputRef.current) composerInputRef.current?.blur();
    };
    window.addEventListener('blur', releaseOnBlur);
    return () => window.removeEventListener('blur', releaseOnBlur);
  }, [subagentModal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing || !subagentModal) return;
      e.preventDefault();
      onCloseSubagent();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, subagentModal, onCloseSubagent]);

  const startEdit = () => {
    setDraft(name);
    setEditing(true);
  };
  const commit = () => {
    onRename(focused.sessionId, draft.trim());
    setEditing(false);
  };

  return (
    <div className="focus">
      <CardStrip
        agents={agents}
        focusedId={focused.sessionId}
        now={now}
        colorOf={colorOf}
        onSelect={onSelect}
        nameOf={nameOf}
        onHide={onHide}
        onSpawn={onSpawn}
        spawningProducts={spawningProducts}
      />

      <div className="focus__main">
        <div className="focus__bar">
          <button className="focus__back" onClick={onExit} title="Back to canvas (Esc)">
            ⌂ canvas
          </button>
          <span className="focus__crumb">
            <span style={{ color: colorOf(focused.product) }}>{focused.product}</span>
            <span className="focus__sep">/</span>
            {editing ? (
              <input
                className="focus__rename"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
            ) : (
              <>
                <b title={name} onDoubleClick={startEdit}>
                  {name}
                </b>
                <button className="focus__edit" onClick={startEdit} title="Rename session">
                  ✎
                </button>
              </>
            )}
          </span>
          <span className="focus__tools">
            <span className="fontctl" title="Terminal font size">
              <button onClick={() => onFontSize(-1)}>A−</button>
              <button onClick={() => onFontSize(1)}>A+</button>
            </span>
          </span>
        </div>

        {termError && <div className="term-error">⚠ {termError}</div>}

        <TerminalView
          resetKey={termResetKey}
          chunk={termChunk}
          fontSize={fontSize}
          onResize={(cols, rows) => onResizeTerm(focused.sessionId, cols, rows)}
        />

        <TermComposer
          onSend={(text, images) => onSendTermInput(focused.sessionId, focused.cwd, text, images)}
          inputRef={composerInputRef}
        />
      </div>

      {subagentModal && (
        <SubagentModal description={subagentModal.description} messages={subagentModal.messages} onClose={onCloseSubagent} />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update `App.tsx`**

In `web/src/App.tsx`, replace the destructured fields from `useShepherd()` (lines 24-50):

```ts
  const {
    snap,
    limits,
    connected,
    focusedId,
    focus,
    unfocus,
    spawn,
    spawningProducts,
    activeSubagents,
    openSubagent,
    closeSubagent,
    subagentModal,
    termChunk,
    termResetKey,
    termError,
    attachTerminal,
    detachTerminal,
    sendTermInput,
    resizeTerm,
  } = useShepherd();
```

Replace the `<FocusView ... />` call (lines 176-207):

```tsx
        <FocusView
          agents={shownVisible}
          focused={focused}
          now={now}
          colorOf={colorOf}
          nameOf={nameOf}
          onSelect={(a) => focus(a.file, a.sessionId)}
          onExit={unfocus}
          onRename={rename}
          fontSize={fontSize}
          onFontSize={changeFont}
          onHide={hide}
          onSpawn={spawn}
          spawningProducts={spawningProducts}
          activeSubagents={activeSubagents}
          onSelectSubagent={(s) => openSubagent(focused.file, focused.sessionId, s.agentId, s.description)}
          onCloseSubagent={closeSubagent}
          subagentModal={subagentModal}
          termChunk={termChunk}
          termResetKey={termResetKey}
          termError={termError}
          onAttachTerminal={attachTerminal}
          onDetachTerminal={detachTerminal}
          onSendTermInput={sendTermInput}
          onResizeTerm={resizeTerm}
        />
```

`messages`/`hasMore`/`loadMore`/`send`/`cancel`/`sendingIds`/`sendingSince`/`queueSend`/`dequeueSend`/`queuedMsgs`/`forceSendQueued`/`liveElsewhereWarnings`/`dismissLiveElsewhereWarning` are no longer destructured or passed — remove every reference to them in this file.

- [ ] **Step 3: Delete the dead components**

```bash
git rm web/src/components/ChatTranscript.tsx web/src/components/Composer.tsx web/src/components/WorkingIndicator.tsx web/src/components/QueuedMessage.tsx web/src/components/QuestionCard.tsx
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: PASS, 0 errors. If `tsc` flags `ToolRow.tsx` or `Mermaid.tsx` as now-orphaned (only ever imported by the deleted `ChatTranscript.tsx`), check `SubagentModal.tsx`'s imports first — it may still render markdown through `Mermaid.tsx` for the read-only subagent view, in which case keep it; delete `ToolRow.tsx` only if nothing still imports it.

- [ ] **Step 5: Commit**

```bash
git add -A web/src
git commit -m "feat: wire FocusView to the live terminal, delete the chat-reconstruction components"
```

---

## Task 7: CSS for the terminal view

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add terminal-specific styles, remove dead chat-view styles**

Add to `web/src/styles.css` (append near the existing `.focus__main` rules):

```css
.terminal-view {
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
  overflow: hidden;
}
.term-composer {
  border-top: 1px solid #21262d;
  padding: 8px 12px;
}
.term-composer__row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.term-composer__input {
  flex: 1;
  resize: none;
  background: #0d1117;
  color: var(--text);
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
}
.term-composer__send {
  background: #238636;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
.term-composer__send:disabled {
  background: #21262d;
  color: #6e7681;
  cursor: default;
}
.term-composer__images {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.term-composer__thumb {
  position: relative;
}
.term-composer__thumb img {
  height: 48px;
  border-radius: 4px;
}
.term-composer__thumb-remove {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #21262d;
  color: #fff;
  border: none;
  border-radius: 50%;
  width: 16px;
  height: 16px;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.term-error {
  background: #2d1214;
  color: #f85149;
  padding: 6px 12px;
  font-size: 12px;
  border-bottom: 1px solid #f85149;
}
```

Search `web/src/styles.css` for selectors that only ever applied to the deleted components — `.chat`, `.chat__more`, `.turn`, `.turn__role`, `.msg__pending-tag`, `.msg__img`, `.toolgroup`, `.qcard*`, `.working-indicator*`, `.subagent-chip` (check `SubagentModal.tsx` doesn't also use it before deleting), `.composer*` (superseded by `.term-composer__*` above), `.queued-msg*`, `.live-elsewhere-warning`, `.stall-warning*` — remove them. Only remove the `--chat-font` variable's declaration if `grep -n -- "--chat-font" web/src/styles.css` shows zero remaining references after the above deletions.

- [ ] **Step 2: Typecheck (confirms nothing else broke)**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/styles.css
git commit -m "style: add terminal view/composer CSS, remove dead chat-view rules"
```

---

## Task 8: Live verification

**Files:** none (verification only)

- [ ] **Step 1: Start the stack**

Run: `pnpm serve:web` (from the repo root of this worktree)
Expected: daemon on `:4177`, web on `:5173`, control on `:4178`, all listening.

- [ ] **Step 2: Manually/via Playwright verify against the dedicated `agent-shepherd` test session** (never the real work sessions — see standing rule)

Checklist to walk through and confirm live:
- Open a session card → terminal renders and shows recent scrollback (ring buffer replay).
- Type a message in `TermComposer`, press Enter → it appears in the terminal, the agent's reply streams in live.
- `AskUserQuestion` renders as the native interactive arrow-key prompt (not a reconstructed card) — answer it with arrow keys + Enter directly in the terminal.
- Paste an image into the composer → note appears, agent can read the file.
- Resize the browser window → terminal reflows (cols/rows change, `pty.resize` fires — confirm via `claude agents --json` or just visually).
- Switch away to another session and back → terminal redraws from the ring buffer instead of starting blank.
- Fire two rapid sends in a row (or reuse the WS-probe technique from earlier today) → second one either queues naturally in the CLI's own input handling or is visibly fine — no garbled/interleaved text.
- Escape / Ctrl-C typed directly into the terminal interrupts generation, same as a real terminal.

- [ ] **Step 3: Report findings back to the user**

Given this is an explicit "let's see how usable it is and go from there" first cut, summarize what worked, what felt rough, and any follow-up worth a fast-follow (the deferred image-decoration thumbnail is the known one).
