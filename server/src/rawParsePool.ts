import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { parseSessionRaw, type RawSession } from './parse.js';

/** Runs parseSessionRaw (the expensive read+parse half of session parsing,
 *  see parse.ts) in worker_threads instead of the daemon's main thread —
 *  #71. scanAll's mtime cache (scan.ts) already eliminates re-parsing files
 *  that haven't changed since the last scan; this addresses what's left
 *  (files that DID change — a session mid-conversation writes one on nearly
 *  every turn) so that work no longer competes with PTY draining and WS
 *  broadcast, both of which live on the main thread and are exactly what
 *  spawning a *new* session's precisely-timed kickoff keystrokes was found
 *  to be sensitive to (see typeLine's jitter handling in sender.ts).
 *
 *  Fails open by design: if the pool can't be created at all (worker file
 *  missing, worker_threads unavailable, whatever), every call transparently
 *  falls back to running parseSessionRaw in-process — same as before this
 *  file existed. A worker dying mid-flight rejects only ITS in-flight
 *  requests and gets respawned; it never takes down scanning. */

/** Directory this module itself lives in, in a way that works in BOTH
 *  environments this file runs in — confirmed by actually running the
 *  desktop bundler (#71), not assumed:
 *   - Packaged desktop app: esbuild bundles this file to CJS, where
 *     `__dirname` is a real, correctly-shimmed global — but esbuild
 *     explicitly warns `import.meta.url` is left EMPTY for cjs output, so
 *     that path would silently resolve to the filesystem root.
 *   - `tsx` dev run: this file is real ESM, so `__dirname` doesn't exist,
 *     but `import.meta.url` is the genuine module URL.
 *  Try the CJS global first (typeof-guarded so referencing it doesn't throw
 *  under ESM), fall back to the ESM path. */
function resolveHere(): string {
  if (typeof __dirname === 'string' && __dirname) return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}
const here = resolveHere();
/** Prefer the compiled sibling esbuild produces for the packaged desktop
 *  app (daemon.cjs's own directory, see bundle-daemon.mjs) — fall back to
 *  the TypeScript source for `tsx` dev runs, where worker_threads inherits
 *  the parent's execArgv (and so the same tsx loader) automatically —
 *  confirmed directly (not assumed) by running a real worker under tsx. */
function resolveWorkerPath(): string {
  const compiled = path.join(here, 'parseWorker.cjs');
  if (existsSync(compiled)) return compiled;
  return path.join(here, 'parseWorker.ts');
}

interface PendingRequest {
  resolve: (raw: RawSession | null) => void;
  reject: (err: Error) => void;
}

class RawParsePool {
  private workers: Worker[] = [];
  private nextWorker = 0;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private disabled = false;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      try {
        this.spawn(i);
      } catch (e) {
        console.error('[rawParsePool] failed to spawn worker, falling back to in-process parsing', e);
        this.disabled = true;
        break;
      }
    }
    if (!this.workers.length) this.disabled = true;
  }

  private spawn(slot: number): void {
    const worker = new Worker(resolveWorkerPath());
    worker.on('message', (msg: { id: number; raw?: RawSession | null; error?: string }) => {
      const req = this.pending.get(msg.id);
      if (!req) return; // late reply for a request already settled some other way
      this.pending.delete(msg.id);
      if (msg.error) req.reject(new Error(msg.error));
      else req.resolve(msg.raw ?? null);
    });
    const onDead = (err?: Error) => {
      // Every request still waiting on THIS worker can never get a reply —
      // reject them so callers fall back rather than hang forever, then
      // replace the worker so future calls keep working.
      for (const [id, req] of this.pending) {
        // Only this worker's own in-flight requests — a Map has no per-worker
        // tagging today (single field), so this simple pool just rejects
        // everything still pending on ANY worker when ANY one dies. With a
        // small pool (2) and errors expected to be rare, the small blast
        // radius (a few in-flight scanAll calls falling back that scan) is a
        // reasonable trade for staying simple.
        req.reject(err ?? new Error('rawParsePool worker exited'));
        this.pending.delete(id);
      }
      this.workers[slot] = undefined as unknown as Worker; // mark dead
      try {
        this.spawn(slot);
      } catch (e) {
        console.error('[rawParsePool] failed to respawn worker', e);
      }
    };
    worker.on('error', onDead);
    worker.on('exit', (code) => {
      if (code !== 0) onDead(new Error(`worker exited with code ${code}`));
    });
    this.workers[slot] = worker;
  }

  async parse(file: string): Promise<RawSession | null> {
    if (this.disabled) return parseSessionRaw(file);
    const alive = this.workers.filter((w): w is Worker => !!w);
    if (!alive.length) return parseSessionRaw(file);
    const worker = alive[this.nextWorker % alive.length];
    this.nextWorker++;

    const id = this.nextId++;
    return new Promise<RawSession | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, file });
    }).catch((e) => {
      // A worker-side failure (crash, unexpected error) falls back to an
      // in-process parse for THIS file rather than surfacing the error —
      // matches parseSessionRaw's own existing `.catch(() => null)` callers'
      // expectations (getRaw already treats a failed parse as "no card").
      console.error('[rawParsePool] worker parse failed, falling back in-process', file, e);
      return parseSessionRaw(file);
    });
  }
}

/** Small pool, not one-per-core — this is occasional bursty work (only
 *  changed files, after scanAll's mtime cache), not a sustained throughput
 *  need; the goal is keeping the main thread free, not maximizing worker
 *  parallelism. */
const POOL_SIZE = Math.max(1, Math.min(2, os.cpus().length - 1));
let pool: RawParsePool | null = null;

/** Lazily created — a daemon that never actually calls this (every test file
 *  that imports scan.ts, for instance) never pays for spawning worker
 *  threads it doesn't need. */
function getPool(): RawParsePool {
  if (!pool) pool = new RawParsePool(POOL_SIZE);
  return pool;
}

export async function parseRawInWorker(file: string): Promise<RawSession | null> {
  return getPool().parse(file);
}
