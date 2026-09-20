import { describe, it, expect } from 'vitest';
import { isMachineIssued, type SessionShape } from './machineIssued.js';

/** The shapes here are modelled on transcripts observed on a working machine —
 *  every `aic.sh` session there is exactly one user turn, one assistant reply
 *  and no tool use — but the objects below are constructed, not loaded from
 *  those files. The end-to-end block at the bottom is the one that runs real
 *  transcript JSON through parse.ts. */

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const minutesAgo = (m: number) => NOW - m * 60_000;
const hoursAgo = (h: number) => NOW - h * 3_600_000;

/** An idle session with nothing unusual about it; each test overrides only the
 *  field it is actually about, so a new guard cannot silently pass because a
 *  fixture happened to omit a field. */
const base: SessionShape = {
  userTurns: 1,
  toolUses: 0,
  lastActivity: hoursAgo(8),
  state: 'idle',
  queued: 0,
};
const shape = (o: Partial<SessionShape> = {}): SessionShape => ({ ...base, ...o });

describe('isMachineIssued', () => {
  it('flags a commit-message session — one turn, no tools, long idle', () => {
    expect(isMachineIssued(shape(), NOW)).toBe(true);
  });

  it('flags the `.`-prompt sdk sessions that appear under C:\\Windows\\System32', () => {
    // Same shape as an aic session: 11 lines, a single "." prompt, no tool
    // use. They were the most-restored group in the daemon log and are
    // equally unreachable.
    expect(isMachineIssued(shape({ lastActivity: hoursAgo(30) }), NOW)).toBe(true);
  });

  it('spares a session that used a tool, however short', () => {
    expect(isMachineIssued(shape({ toolUses: 3 }), NOW)).toBe(false);
  });

  it('spares a conversation — more than one turn', () => {
    // Someone replied at least once. This is the only thing separating a used
    // session from an abandoned one when no tool ever ran: shepherd's own
    // `spawnSession` kickoff that nobody talked to counts as a single turn and
    // IS hidden, correctly — its other `user` events are `<local-command-…>`
    // echoes (including an explicit `/exit`) that parse.ts excludes.
    expect(isMachineIssued(shape({ userTurns: 2 }), NOW)).toBe(false);
  });

  it('spares a session with no turns at all', () => {
    // Zero turns means nothing was ever sent — an empty transcript, not a
    // machine-issued one. Not our business to hide.
    expect(isMachineIssued(shape({ userTurns: 0 }), NOW)).toBe(false);
  });

  describe('live state always wins over shape', () => {
    // A `working` session can sit far past the grace window without writing to
    // its transcript — a long think, a slow MCP call, a long-running Bash. And
    // because this filter runs upstream of restore selection (scan.ts), hiding
    // one would also drop it from the restore set, not just the card strip.
    it('spares a working session however long its transcript has been quiet', () => {
      expect(isMachineIssued(shape({ state: 'working', lastActivity: hoursAgo(30) }), NOW)).toBe(false);
    });

    it('spares a session waiting on the operator', () => {
      // Reachable with no tool call at all — a trailing question in prose.
      expect(isMachineIssued(shape({ state: 'needs-you' }), NOW)).toBe(false);
    });

    it('spares a session that errored', () => {
      expect(isMachineIssued(shape({ state: 'error' }), NOW)).toBe(false);
    });

    it('spares a session with work queued up', () => {
      expect(isMachineIssued(shape({ queued: 2 }), NOW)).toBe(false);
    });
  });

  describe('grace window', () => {
    it('spares a freshly-started session that has not answered yet', () => {
      // The case that makes a naive shape rule dangerous: a session spawned
      // seconds ago is indistinguishable from a finished machine-issued one,
      // because nothing has happened in it YET.
      expect(isMachineIssued(shape({ lastActivity: minutesAgo(1) }), NOW)).toBe(false);
    });

    it('spares a one-question session answered in prose that the operator walked away from', () => {
      // No tool call, one turn, genuinely idle — its shape NEVER distinguishes
      // it from an aic session, so only elapsed time can, and an hour away
      // from the keyboard is ordinary. Hidden cards are unrecoverable from the
      // UI; clutter is not.
      expect(isMachineIssued(shape({ lastActivity: hoursAgo(1) }), NOW)).toBe(false);
    });

    it('still spares it late in the window', () => {
      expect(isMachineIssued(shape({ lastActivity: hoursAgo(5) }), NOW)).toBe(false);
    });

    it('flags it once the window has passed with nothing more happening', () => {
      expect(isMachineIssued(shape({ lastActivity: hoursAgo(7) }), NOW)).toBe(true);
    });
  });
});

/** The counts these rules act on come from parse.ts, so a change there — what
 *  counts as a "user turn" — silently changes what gets hidden. These run real
 *  transcript JSON through the real parser. */
describe('isMachineIssued over parsed transcripts', () => {
  const setup = async () => {
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
    return { parseSession, write, at };
  };

  it('hides a commit-message session but keeps one someone worked in', async () => {
    const { parseSession, write, at } = await setup();

    // Exactly the aic.sh shape: one queued prompt, one plain reply, no tools.
    const aicFile = write('aic.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', gitBranch: 'main', timestamp: at(8 * 3_600_000), message: { role: 'user', content: 'Write a git ' + 'commit mess' + 'age for the staged diff below.' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: at(8 * 3_600_000 - 1000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fix: thing' }] } },
    ]);

    const realFile = write('real.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', gitBranch: 'main', timestamp: at(8 * 3_600_000), message: { role: 'user', content: 'find the bug' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: at(8 * 3_600_000 - 1000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Grep', input: {} }] } },
    ]);

    const aicModel = await parseSession(aicFile, NOW);
    const realModel = await parseSession(realFile, NOW);

    expect(aicModel!.userTurns).toBe(1);
    expect(aicModel!.toolUses).toBe(0);
    expect(realModel!.toolUses).toBeGreaterThan(0);

    expect(isMachineIssued(aicModel!, NOW)).toBe(true);
    expect(isMachineIssued(realModel!, NOW)).toBe(false);
  });

  it('counts a turn whose content is only an image, and so keeps that session', async () => {
    const { parseSession, write, at } = await setup();

    // A screenshot-driven conversation: the second turn carries no text at
    // all. Counting turns off rendered text missed it, read the session as a
    // one-shot, and hid it.
    const file = write('image.jsonl', [
      { type: 'user', cwd: 'C:/repo', gitBranch: 'main', timestamp: at(8 * 3_600_000), message: { role: 'user', content: 'look at this' } },
      { type: 'assistant', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 1000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 2000), message: { role: 'user', content: [{ type: 'image', source: {} }] } },
      { type: 'assistant', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 3000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I see it' }] } },
    ]);

    const model = await parseSession(file, NOW);
    expect(model!.userTurns).toBe(2);
    expect(isMachineIssued(model!, NOW)).toBe(false);
  });

  it('does not count tool results as turns', async () => {
    const { parseSession, write, at } = await setup();

    // Tool results arrive as `user` events. Counting them would make every
    // tool-using session look like a conversation.
    const file = write('toolresult.jsonl', [
      { type: 'user', cwd: 'C:/repo', gitBranch: 'main', timestamp: at(8 * 3_600_000), message: { role: 'user', content: 'run it' } },
      { type: 'assistant', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 1000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'user', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 2000), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);

    const model = await parseSession(file, NOW);
    expect(model!.userTurns).toBe(1);
  });
});
