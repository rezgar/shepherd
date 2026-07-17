#!/usr/bin/env node
// Claude Code hook handler for Shepherd.
//
// Claude Code invokes this on session events and pipes the event JSON on stdin.
// We map the event to an exact agent state and write a tiny per-session file to
// ~/.claude/shepherd-state/<session_id>.json that the Shepherd daemon reads.
//
// Design rules: never throw, never block, always exit 0 — a hook must never
// interfere with the user's Claude Code session.

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const EVENT_STATE = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  SubagentStop: 'working', // a subagent finished; the parent is still going
  Notification: 'needs-you', // permission prompt / idle-waiting — needs attention
  Stop: 'idle', // main turn finished — the user's move
  StopFailure: 'error', // session terminated on a rate limit / API / billing error
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const e = JSON.parse(input || '{}');
    const sid = e.session_id;
    const event = e.hook_event_name;
    const state = EVENT_STATE[event];
    if (sid && state) {
      const dir = join(homedir(), '.claude', 'shepherd-state');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${sid}.json`),
        JSON.stringify({
          state,
          event,
          tool: e.tool_name ?? null,
          errorType: e.error_type ?? null,
          ts: Date.now(),
        }),
      );
    }
  } catch {
    /* swallow — never break the session */
  }
  process.exit(0);
});
