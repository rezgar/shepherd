import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** scanAll is the integration point that actually changes what the operator
 *  sees — and, because index.ts hands its output straight to
 *  selectRestoreTargets, what gets restored on boot. Testing only the
 *  predicate would leave that wiring unverified: a filter applied in the UI
 *  instead of here would pass every machineIssued test and still let restore
 *  resurrect sessions no card ever shows. */

const root = mkdtempSync(path.join(tmpdir(), 'shepherd-scan-'));
const NOW = Date.now();
const at = (ms: number) => new Date(NOW - ms).toISOString();

function session(project: string, id: string, lines: object[]): void {
  const dir = path.join(root, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

let scanAll: (now: number) => Promise<{ sessionId: string }[]>;

beforeAll(async () => {
  // A one-shot commit-message session, idle well past the grace window.
  session('C--repo', 'aaaaaaaa-0000-0000-0000-000000000001', [
    { type: 'user', cwd: 'C:/repo', gitBranch: 'main', timestamp: at(8 * 3_600_000), message: { role: 'user', content: 'Write a git ' + 'commit mess' + 'age for the staged diff below.' } },
    { type: 'assistant', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 1000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fix: thing' }] } },
  ]);

  // A session someone actually worked in, idle just as long.
  session('C--repo', 'bbbbbbbb-0000-0000-0000-000000000002', [
    { type: 'user', cwd: 'C:/repo', gitBranch: 'main', timestamp: at(8 * 3_600_000), message: { role: 'user', content: 'find the bug' } },
    { type: 'assistant', cwd: 'C:/repo', timestamp: at(8 * 3_600_000 - 1000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Grep', input: {} }] } },
  ]);

  process.env['SHEPHERD_PROJECTS_DIR'] = root;
  vi.resetModules();
  ({ scanAll } = await import('./scan.js'));
});

afterAll(() => {
  delete process.env['SHEPHERD_PROJECTS_DIR'];
  rmSync(root, { recursive: true, force: true });
});

describe('scanAll drops machine-issued sessions', () => {
  it('omits the one-shot session and keeps the one that was worked in', async () => {
    const agents = await scanAll(NOW);
    const ids = agents.map((a) => a.sessionId);

    expect(ids).toContain('bbbbbbbb-0000-0000-0000-000000000002');
    expect(ids).not.toContain('aaaaaaaa-0000-0000-0000-000000000001');
  });
});
