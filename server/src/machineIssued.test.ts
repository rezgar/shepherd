import { describe, it, expect } from 'vitest';
import { isMachineIssued } from './machineIssued.js';

/** The shapes below are taken from real transcripts on a working machine, not
 *  invented: every `aic.sh` session observed there is exactly one user turn,
 *  one assistant reply and no tool use, and every genuine session has either
 *  more turns or real tool use. */

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const minutesAgo = (m: number) => NOW - m * 60_000;

/** An `aic.sh` commit-message session: one machine-issued turn, no tools. */
const aic = {
  userTurns: 1,
  toolUses: 0,
  lastActivity: minutesAgo(90),
};

describe('isMachineIssued', () => {
  it('flags a commit-message session — one turn, no tools, long idle', () => {
    expect(isMachineIssued(aic, NOW)).toBe(true);
  });

  it('flags the `.`-prompt sdk sessions that appear under C:\\Windows\\System32', () => {
    // Same shape as aic (11 lines, single "." prompt, no tool use); they are
    // the most-restored group in the daemon log and equally unreachable.
    expect(isMachineIssued({ userTurns: 1, toolUses: 0, lastActivity: minutesAgo(700) }, NOW)).toBe(true);
  });

  it('spares a session that used a tool, however short', () => {
    // One turn but real work done — a genuine one-shot the operator may want
    // to look at.
    expect(isMachineIssued({ userTurns: 1, toolUses: 3, lastActivity: minutesAgo(90) }, NOW)).toBe(false);
  });

  it('spares a conversation — more than one turn', () => {
    // Someone replied at least once. Note this is the ONLY thing separating a
    // used session from an abandoned one when no tool ever ran: shepherd's own
    // `spawnSession` kickoff ("New session started via Shepherd…") that nobody
    // then talked to counts as a single turn and IS hidden, correctly — its
    // three other `user` events are `<local-command-…>` echoes that parse.ts
    // excludes from the count, so it holds no conversation at all.
    expect(isMachineIssued({ userTurns: 2, toolUses: 0, lastActivity: minutesAgo(90) }, NOW)).toBe(false);
  });

  it('spares a freshly-started session that has not answered yet', () => {
    // THE case that makes a naive shape rule dangerous: a session spawned
    // seconds ago looks identical to a finished machine-issued one — one
    // turn, no tools — because nothing has happened in it YET. Hiding it
    // would make "+ new session" appear to do nothing.
    expect(isMachineIssued({ userTurns: 1, toolUses: 0, lastActivity: minutesAgo(1) }, NOW)).toBe(false);
  });

  it('spares a session still inside the grace window', () => {
    expect(isMachineIssued({ userTurns: 1, toolUses: 0, lastActivity: minutesAgo(9) }, NOW)).toBe(false);
  });

  it('flags it once the grace window has passed with nothing more happening', () => {
    expect(isMachineIssued({ userTurns: 1, toolUses: 0, lastActivity: minutesAgo(11) }, NOW)).toBe(true);
  });

  it('spares a session with no turns at all', () => {
    // Zero turns means nothing was ever sent — a transcript that exists but
    // holds no conversation. Not our business to hide.
    expect(isMachineIssued({ userTurns: 0, toolUses: 0, lastActivity: minutesAgo(90) }, NOW)).toBe(false);
  });
});

/** End-to-end over real transcript shapes: the counts these rules act on come
 *  from parse.ts, so a change there (what counts as a "user turn") silently
 *  changes what gets hidden. These fixtures are the two shapes that actually
 *  occur on a working machine. */
describe('isMachineIssued over parsed transcripts', () => {
  it('hides a commit-message session but keeps a session someone worked in', async () => {
    const { parseSession } = await import('./parse.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;

    const dir = mkdtempSync(path.join(tmpdir(), 'shepherd-mi-'));
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const write = (name: string, lines: object[]) => {
      const p = path.join(dir, name);
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
      return p;
    };

    // Exactly the aic.sh shape: one queued prompt, one plain reply, no tools.
    const aicFile = write('aic.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', gitBranch: 'main', timestamp: at(60 * 60_000), message: { role: 'user', content: 'Write a git ' + 'commit mess' + 'age for the staged diff below.' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: at(59 * 60_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fix: thing' }] } },
    ]);

    // A session someone actually used: a turn plus a real tool call.
    const realFile = write('real.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', gitBranch: 'main', timestamp: at(60 * 60_000), message: { role: 'user', content: 'find the bug' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: at(59 * 60_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Grep', input: {} }] } },
    ]);

    const aicModel = await parseSession(aicFile, NOW);
    const realModel = await parseSession(realFile, NOW);

    expect(aicModel).not.toBeNull();
    expect(realModel).not.toBeNull();
    expect(aicModel!.userTurns).toBe(1);
    expect(aicModel!.toolUses).toBe(0);
    expect(realModel!.toolUses).toBeGreaterThan(0);

    expect(isMachineIssued(aicModel!, NOW)).toBe(true);
    expect(isMachineIssued(realModel!, NOW)).toBe(false);
  });
});
