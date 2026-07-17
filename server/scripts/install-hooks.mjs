#!/usr/bin/env node
// Merge Shepherd's hooks into ~/.claude/settings.json (idempotent, backed
// up). Explicit and opt-in — run `pnpm setup:hooks`. Undo by deleting the
// shepherd-hook entries (or restoring the .shepherd-backup).

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookPath = fileURLToPath(new URL('../hooks/shepherd-hook.mjs', import.meta.url));
const command = `node "${hookPath}"`;

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
const PLAIN_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop', 'StopFailure'];

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`Refusing to touch ${settingsPath} — could not parse it: ${e.message}`);
    process.exit(1);
  }
  copyFileSync(settingsPath, `${settingsPath}.shepherd-backup`);
}
settings.hooks ??= {};

const hasCmd = (entries) => (entries ?? []).some((e) => (e.hooks ?? []).some((h) => h.command === command));
const addEntry = (event, withMatcher) => {
  settings.hooks[event] ??= [];
  if (hasCmd(settings.hooks[event])) return false;
  const entry = { hooks: [{ type: 'command', command }] };
  if (withMatcher) entry.matcher = '*';
  settings.hooks[event].push(entry);
  return true;
};

let added = 0;
for (const ev of TOOL_EVENTS) if (addEntry(ev, true)) added++;
for (const ev of PLAIN_EVENTS) if (addEntry(ev, false)) added++;

writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Installed Shepherd hooks into ${settingsPath} (${added} event group(s) added).`);
console.log(`  hook: ${command}`);
if (existsSync(`${settingsPath}.shepherd-backup`)) console.log(`  backup: ${settingsPath}.shepherd-backup`);
console.log('Open new (or continue existing) Claude Code sessions for hooks to take effect.');
