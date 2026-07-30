# Lines-changed indicator + embedded askdiff diff panel

## Why

Sessions run for a long time, and the only way to see what's actually changed on disk today is to leave Shepherd and open a terminal or IDE elsewhere — breaking the "everything about this session lives in one place" loop the terminal-focused-view work already established (`docs/superpowers/specs/2026-07-16-terminal-focused-view-design.md`). A live diff view reachable with one click from the same top bar keeps code review in the same surface as the coding session itself.

Separately, a personal fork of `askdiff` (github.com/rezgar/askdiff, branch `live-working-tree-refresh`) was just built specifically to make its working-tree diff view auto-refresh via real filesystem events — no manual re-invocation needed. Pairing that with Shepherd's own always-on daemon turns "click to see the diff" into "click to see whatever's on disk right now, continuously," which is exactly what a session that's mid-edit needs.

## Scope

**In scope:**

- A `+N -M` lines-changed pill in the focused-mode top bar (`focus__tools`), reflecting the focused session's *working-tree* diff only (uncommitted + untracked changes — matching askdiff's own default, no-description behavior).
- Clicking the pill swaps the terminal for an embedded askdiff view in the same layout slot; Esc or a close button swaps back to the terminal.
- Pre-warming: the askdiff instance for the focused session starts spawning as soon as the session is focused (before any click), so opening the panel is normally instant.
- Vendoring askdiff's `server` + `protocol` packages (from the personal fork, not the public npm package) into this repo as source, since the fork's live-refresh feature is the reason to embed it at all.

**Explicitly out of scope** (decided during brainstorming):

- Showing the count/pill anywhere in canvas/card view — focused mode only, per the ask.
- Committed-but-unmerged branch diffs (`git diff main...HEAD`, PR-style). A different, non-volatile diff that doesn't line up with askdiff's default working-tree view; could be a future mode toggle, isn't this feature.
- A native/embedded askdiff UI component. It's a full SPA with its own WS channel and no embeddable API — embedding means iframing its served URL, not reimplementing its UI.
- Multi-session pre-warming. Only the currently-focused session gets a warm askdiff instance; switching sessions cold-starts a new one for the newly-focused session (mitigated by the idle-eviction grace period below, so flipping back to a *recently* focused session is still usually warm).

## Architecture

Two independent pieces, deliberately decoupled so the top-bar count never waits on the (heavier) askdiff process:

1. **Lines-changed count** — computed server-side, scoped to whichever session is currently focused, not the whole fleet (unlike most `AgentModel` fields, this is only ever relevant for one session at a time, so computing it for every tracked session on every rescan would be wasted work). A cheap `git -C <cwd> diff --shortstat HEAD` plus an untracked-file line count — mirroring exactly what askdiff's own working-tree capture does, so the top-bar number always matches what the panel shows once opened — runs once when a session is focused, and again whenever the daemon's existing chokidar-driven rescan trigger fires (that's already the daemon's live "something changed on disk" signal).

2. **The askdiff instance** — one per focused session, an in-process call to the vendored `startServer()` (from `@askdiff/server`) on its own ephemeral port, with `cwd` set to the session's cwd and `volatile: true` (working-tree mode, live-refreshing). No OS subprocess needed — askdiff's server is just a function call; the daemon is already a long-running Node process. Lifecycle mirrors the existing persistent-PTY model in `sender.ts`: spawned lazily the moment a session is focused (pre-warm, tied to the same signal that pins a session's PTY against idle-eviction while it's focused), kept alive across unfocus for the same idle-eviction grace period PTYs get today (so flipping back to a recently-viewed session's diff doesn't cold-start it again), and torn down on daemon shutdown alongside everything else `shutdownAllSessions()` already cleans up.

**Why vendor instead of depending on the fork directly**: the fork lives in a separate, unpublished clone (`C:/Code/ai/askdiff`). A path or git dependency pointing at it would either break on a fresh machine — contrary to this repo's own reproduce-on-a-new-machine goal (`BOOTSTRAP.md`) — or require publishing a personal package just for this. Vendoring `packages/server` + `packages/protocol` as plain source keeps this repo self-contained; the cost is manually re-pulling future askdiff changes instead of `pnpm update`, which is an acceptable trade for a personal tool. `chokidar` and `ws` are already Shepherd dependencies matching what the vendored code needs; `zod` (askdiff's own schema validation) is the one new dependency this adds.

## Components

### Server (`server/src/`)

- **Diff-stat computation** (new, e.g. `diffStat.ts`) — mirrors `scan.ts`'s existing `pexec`-based git-shelling pattern (see `repoSlug()`), but **not** cached like `repoCache`/`titleCache` — this one must reflect live disk state on every call, not a static fact computed once.
- **`askdiffInstances.ts`** (new) — a per-session askdiff-instance map (`Map<sessionId, { handle, lastUsed }>`) with spawn-lazily and idle-evict functions, following `sender.ts`'s `readyPtys` / `getOrSpawnPty` / idle-sweep shape as closely as possible so the two per-session-resource lifecycles read the same way to a future maintainer.
- **`index.ts`** — on the existing `focus` message, in addition to today's window-send: kick off the diff-stat compute (pushing a `linesChanged { sessionId, added, removed }` message, the same shape as the existing `limits` broadcast) and pre-warm the session's askdiff instance. A new message (`askdiffReady { sessionId, port }`, or the port folded into the `focus` response — implementation plan to decide the exact shape) tells the client once the pre-warmed instance's port is live.
- **`server/vendor/askdiff/`** (new) — vendored `@askdiff/server` + `@askdiff/protocol` source from the fork's `live-working-tree-refresh` branch.

### Web (`web/src/`)

- **`FocusView.tsx`** — adds the pill to `focus__tools` (not rendered at all when the diff is 0/0 — nothing to show), and a `showDiff` boolean controlling which of `<TerminalView/>` / a new `<AskdiffView/>` renders in the `focus__main` slot — same detach-on-swap discipline `TerminalView` already follows on unmount. Esc handling follows the existing `SubagentModal` precedent (a `window.keydown` listener guarded on `showDiff`).
- **`AskdiffView.tsx`** (new) — an `<iframe>` pointed at `http://localhost:<port>/`, where `port` comes from the server once the pre-warmed instance is up. Falls back to a lightweight loading state if the click happens before pre-warm finishes (should be rare, since pre-warm starts at focus time, well before a user typically clicks).
- **`api.ts`** — new client state for the linesChanged count and the focused session's askdiff port, plus whatever outbound wiring the chosen message shape needs.

## Data flow

1. Session becomes focused → client sends `focus` (as today) → server starts the diff-stat compute (pushes `linesChanged` when done) **and** pre-warms the askdiff instance for that session, non-blocking.
2. Top bar renders the pill as soon as `linesChanged` arrives — independent of whether the askdiff instance has finished starting.
3. User clicks the pill → `showDiff = true` → `TerminalView` unmounts (detaches, same as an unfocus today) → `AskdiffView` mounts, iframing the now-likely-already-up instance's port.
4. Esc or the close button → `showDiff = false` → `AskdiffView` unmounts → `TerminalView` remounts and reattaches (same as it already does on session switch) — the askdiff instance itself keeps running, untouched.
5. Session unfocused → the askdiff instance is *not* torn down immediately; it idle-evicts on the same timer PTYs use if the session isn't refocused first.
6. On-disk changes (Claude editing files) → the vendored askdiff instance's own working-tree watcher pushes a fresh diff to any open `AskdiffView` iframe on its own, independent of Shepherd's rescan cadence. Separately, the next `linesChanged` recompute (tied to the same chokidar-driven rescan trigger) updates the top-bar count to match.

## Error handling

- Session `cwd` isn't a git repo (e.g. mid-provisioning) or the `git` call errors: diff-stat compute fails soft — no pill shown, not an error banner, same as the 0/0 case above.
- askdiff instance fails to start (port exhaustion, cwd vanished): the click still swaps the slot, but `AskdiffView` shows an inline error state in place of the iframe — mirrors the terminal view's own "write PTY spawn failure directly into the buffer, not a popup" precedent — rather than silently reverting to the terminal.
- Daemon restart: both the diff-stat state and the askdiff-instance map are in-memory and rebuild from scratch on the next focus, same as PTYs do today.

## Testing

- **Server**: unit tests for the diff-stat computation (tracked modification, untracked addition, clean tree, no-git-repo) against real scratch git repos, in the same style as the vendored askdiff fork's own `working-tree-diff.test.ts`. Unit tests for the askdiff-instance map's spawn/reuse/idle-evict behavior (fake clock), matching the shape of any existing `sender.ts` eviction tests.
- **Web**: pill rendering (hidden at 0/0, visible and clickable otherwise) and the `showDiff` slot-swap + Esc handling, with existing component-test patterns.
- **Live**: the actual panel swap, iframe load, and live-refresh-while-editing behavior verified with Playwright against a real daemon and a real vendored askdiff instance — same approach used to verify the terminal view's rendering.
