import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'shepherd-projects-'));

/** A realistic slice of ~/.claude/projects: two real sessions, plus the
 *  subagent transcripts one of them spawned. Subagents live one level deeper,
 *  under `<sessionId>/subagents/`, and must never be mistaken for sessions —
 *  restoring one would spawn a process for a conversation that only ever
 *  existed as a child of another. */
beforeAll(() => {
  const project = path.join(root, 'C--Code-repo');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), '');
  writeFileSync(path.join(project, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), '');

  const subagents = path.join(project, 'aaaaaaaa-1111-2222-3333-444444444444', 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(path.join(subagents, 'agent-cccccccc.jsonl'), '');
  writeFileSync(path.join(subagents, 'agent-dddddddd.jsonl'), '');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('listSessionFiles (CoD 3)', () => {
  it('lists real sessions and never their subagent transcripts', async () => {
    process.env.SHEPHERD_PROJECTS_DIR = root;
    const { listSessionFiles } = await import('../src/scan.js');

    const files = await listSessionFiles();
    const names = files.map((f) => path.basename(f)).sort();

    expect(names).toEqual([
      'aaaaaaaa-1111-2222-3333-444444444444.jsonl',
      'bbbbbbbb-1111-2222-3333-444444444444.jsonl',
    ]);
    expect(files.some((f) => f.includes('subagents'))).toBe(false);
  });
});
