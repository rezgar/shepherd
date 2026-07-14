# 🐑 Agent Shepherd

A spatial cockpit for many parallel Claude Code agents. Rides your existing Claude Code CLI (subscription auth) — it does **not** call the API directly.

## Why

Running 10+ `claude` sessions across projects and worktrees means terminal-tab hoarding: you lose track of which agent is doing what, and which one is blocked waiting on you. Shepherd gives you a product-grouped canvas + a full-screen chat, so you can survey everything at a glance and work one agent at a time without losing the others.

## Design (locked)

- **Observer-first.** Shepherd watches `~/.claude/projects/**/*.jsonl` (the transcripts Claude Code writes live) and — later — registers Claude Code hooks for precise state. It sees every session you already run, no workflow change.
- **Local web app.** A Node/TS daemon (tail + classify + WebSocket) and a Vite/React browser UI. Because *we* render the UI (not an embedded terminal), chat renders markdown, mermaid, and images.
- **Two modes of one workspace:**
  - **Overview** — full-screen canvas, agents clustered into **per-project lanes** (A "tab-group" grouping).
  - **Focus** — full-screen chat (~85%) with a persistent **product-grouped card strip** on top so you can see & switch agents without leaving chat.
- **Each card** shows a **stage pipeline** (Definition → Planning → Implementation → Testing → Debugging), progress, and a one-line status.
- **Agents needing action** get a loud amber card + red badge (F+H). Approvals & short choices resolve inline; **long-form questions open a roomy popover** resolver over the current chat.

Mockups: [`design/mockup.html`](design/mockup.html) (full), [`design/mockup-actions.html`](design/mockup-actions.html) (action states).

## Slices

- **Slice 1 (this one)** — *See my real sessions, grouped, live.* Daemon scans `~/.claude/projects`, derives per-agent `product / state / stage / status` from the transcript, streams over WebSocket; the web UI renders the **overview canvas grouped by project**, updating live.
- **Slice 2** — Focus-mode chat (render transcript as markdown/mermaid/images) + the card strip. **Composer requirement:** pressing **↑ (arrow-up)** in an empty composer recalls your last message into the input for editing/resend (terminal-style history) — required.
- **Slice 3** — Hooks for precise `needs-you` state; the popover resolver; reply/queue back into a launched session.

> State classification in Slice 1 is heuristic (recency + last-turn shape). Slice 3's hooks (`Notification`/`Stop`/`PreToolUse`) make it exact.

## Dev

```bash
pnpm install
pnpm dev:server     # ws://localhost:4177, watches ~/.claude/projects
pnpm dev:web        # Vite UI on http://localhost:5173

# sanity check the parser against your real sessions, no server:
pnpm --filter @shepherd/server start -- --once
```
