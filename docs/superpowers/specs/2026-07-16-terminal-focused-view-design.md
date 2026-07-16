# Terminal focused view

## Why

Every reliability bug found today (resume-race, silent-drop, concurrent-write corruption, focus-steal) traced back to one root cause: Shepherd's chat interface reconstructs session state by parsing a transcript file *after the fact*, and sends messages by writing into a PTY *blind* — with no visibility into whether it was safe to write, and no coordination guaranteeing only one writer at a time. A real terminal never has these problems, not because it renders more nicely, but because it has two structural properties ours lacked:

1. **Zero gatekeeping between "typed" and "delivered."** A terminal driver is a dumb pipe — no application-level policy layer that can silently decide not to deliver a keystroke.
2. **Exactly one writer, and immediate, real confirmation.** One keyboard, one human; what you type echoes back instantly, so "did it work" is never a question you have to infer from a side channel later.

This design gives the *focused* (single-session) view those same two properties, while leaving the card/canvas overview — which is read-only, parsed, and was never the source of a bug — untouched.

## Scope

**In scope**: replacing the focused view's chat transcript + composer with a live terminal (xterm.js) wired to the session's persistent PTY, plus the server-side changes needed to support it (ring buffer for reconnect replay, hard single-writer enforcement, raw-stream WS protocol).

**Explicitly out of scope** (decided during brainstorming):
- Actively detecting/blocking session collisions with a second real terminal — unchanged from today's warn-only banner.
- Sending a message without opening the focused view ("quick send from canvas") — removed entirely; all interaction now requires opening the terminal.
- Full inline terminal graphics protocols (Sixel/iTerm2 image protocol) — not needed since Claude Code doesn't emit them; our own pasted-image notes get a bespoke decoration instead (see below).

This is explicitly a first cut ("let's see how usable it is and go from there") — the design favors deleting complexity over preserving every current affordance.

## Architecture

The focused view becomes: a live terminal (xterm.js) rendering the session's raw PTY output, plus a plain input box beneath it. Server-side, this builds directly on the existing persistent-PTY model in `sender.ts` (`readyPtys`, `spawnPersistent`, `getOrSpawnPty`) rather than replacing it — each session still has exactly one long-lived PTY, kept alive across the session's lifetime, idle-evicted the same as today.

Two things get added to that existing PTY ownership:

- **A bounded ring buffer** of recent raw output bytes (cap: 256KB per session, oldest bytes dropped first), so a client attaching or reconnecting can redraw the current screen instead of starting blank.
- **A serialized write lock**, owned by the PTY entry itself (not by the WS-handler layer). Every write — whether from the focused terminal's input box or the new-session kickoff flow — goes through this one queue. This is the structural fix for today's concurrent-write corruption: it's not a check a future code path could forget, it's the only path writes can take.

Both the ring buffer and the write lock live and die with the PTY entry — idle-eviction (unchanged from today) clears them along with the process; a later send just reopens fresh, same as today.

One concrete win this unlocks: `AskUserQuestion` already renders as a native interactive arrow-key/Enter prompt inside the real terminal output — Shepherd just wasn't showing it. With the raw stream rendered directly, that native prompt appears as-is; no `QuestionCard` reconstruction or pending-question tracking is needed for the *interactive* path (the passive card-summary parsing in `parse.ts` is untouched, since that only feeds the read-only overview).

## Components

### Server (`sender.ts`, `index.ts`)

`PersistentPty` gains a ring buffer, a set of subscribed WS connections (for live output fan-out), and an internal async write lock. New WS message types, replacing `send`/`cancel`:

- `attachTerm { sessionId, cwd }` — ensures the PTY is live (existing `getOrSpawnPty`), sends the ring-buffer replay, then subscribes this connection to live output.
- `detachTerm { sessionId }` — unsubscribes this connection. The PTY itself is untouched (same idle-eviction as today).
- `termInput { sessionId, text }` — enqueues a write on that session's lock: clear-line defensively, write `text`, write `\r`.
- `termResize { sessionId, cols, rows }` — calls `pty.resize(cols, rows)`.

Deleted outright (not deprecated): `sendToSession`, `waitForTurnToFinish`, `didMessageLand`, `countLines`, and everything in the message-queue system (`queueSend`/`dequeueSend`/`forceSendQueued`/blocked-draft tracking). These exist solely to compensate for not having a live view — once the view is live, they have no job left to do.

`spawnSession` (the "+ new session" kickoff) keeps its existing discovery logic (typing the kickoff, polling for the new transcript file to learn the session id), since there's genuinely no session to attach to yet at that point — but the client can attach to its raw output immediately after the kickoff fires (we already hold the live `IPty` from `pty.spawn`), so the whole boot sequence (MCP connections, etc.) is visible in real time rather than hidden until discovery completes. Once discovered, this PTY is registered as that session's owner exactly as it is today.

### Web

- **`TerminalView.tsx`** (new) — wraps `@xterm/xterm` + `@xterm/addon-fit`. Receives raw output chunks over the WS, writes them to the `Terminal` instance. Before writing, scans each chunk for our own `[Pasted image N — read this file: <path>]` notes and, on a match, still writes the raw text (fidelity preserved) but additionally pins a thumbnail via `registerDecoration` at that buffer line. Fit-addon drives `termResize` on container resize. The existing A-/A+ font-size control now sets xterm's own `fontSize` option directly instead of the `--chat-font` CSS variable (which only ever styled the chat reconstruction being removed).
- **`TermComposer.tsx`** (new, replaces `Composer.tsx`) — a plain textarea. Paste-image keeps today's mechanism (save to temp file, inject the note) since a real terminal has no native image-paste. Enter sends `termInput` and clears the box; Shift+Enter inserts a newline. No sending/queued state at all — the terminal view is what tells you what happened.
- **`FocusView.tsx`** — swaps `ChatTranscript` + `Composer` + `WorkingIndicator` + `QueuedMessage` + in-chat `QuestionCard` for `TerminalView` + `TermComposer`. Card strip and canvas overview are unchanged.
- **`api.ts`** — the `send`/`sendingIds`/`pending`/`queuedMsgs`/queue-flush-effect machinery is removed. New surface: `attachTerminal(sessionId, cwd)`, `detachTerminal(sessionId)`, `sendTermInput(sessionId, text)`, `resizeTerm(sessionId, cols, rows)`. Snapshot/card/limits state is untouched.

## Data flow

1. Click a card → `focus()` → client sends `attachTerm`.
2. Server ensures the PTY is live, sends the ring-buffer replay, subscribes the connection.
3. New PTY output → appended to the ring buffer and streamed to every subscribed connection for that session, as raw bytes.
4. User types in `TermComposer`, hits Enter → `termInput` → queued on the session's write lock → written to the PTY. The reply streams back through the same channel already being watched — echo and confirmation are just what's on screen, not a separate mechanism.
5. Container resize → fit-addon recomputes cols/rows → `termResize` → `pty.resize()`.
6. Unfocusing sends `detachTerm`; the PTY keeps running per today's idle-eviction.

## Error handling

- PTY spawn failure: written as an error line directly into the terminal buffer, not a separate popup — keeps one surface for "what's going on with this session" instead of two.
- Daemon down: existing `ConnectionBanner` is unchanged; on reconnect, the client re-issues `attachTerm` and gets a fresh replay.
- Live-elsewhere collision: today's warn-only banner, unchanged (explicitly out of scope, see above).

## Testing

- **Server**: unit tests for the ring buffer (bounded size, correct eviction/replay order) and the write lock (two concurrent `termInput` calls for the same session are provably serialized, never interleaved — simulate with a fake pty double). Today's `didMessageLand`/`countLines` tests are deleted along with the code they test.
- **Web**: `TermComposer`'s submit behavior (calls `sendTermInput` with the right text, clears, handles paste) is unit-testable with existing patterns. The terminal rendering itself is verified live via Playwright — same approach used throughout today's session.
