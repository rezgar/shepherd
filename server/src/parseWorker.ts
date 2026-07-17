import { parentPort } from 'node:worker_threads';
import { parseSessionRaw } from './parse.js';

/** Worker entry point for rawParsePool (#71) — runs parseSessionRaw's file
 *  read + line-by-line JSON.parse off the daemon's main thread, so a big
 *  batch of newly-changed transcripts doesn't compete with PTY draining and
 *  WS broadcast for the same event loop. Deliberately minimal: this worker
 *  does ONLY the pure, file-derived parse (see parseSessionRaw's doc
 *  comment) — never touches PTY state, hook state, or anything else that
 *  lives on the main thread. */

if (!parentPort) {
  throw new Error('parseWorker must be run as a worker_thread');
}
const port = parentPort;

interface Request {
  id: number;
  file: string;
}

port.on('message', (msg: Request) => {
  const { id, file } = msg;
  parseSessionRaw(file).then(
    (raw) => port.postMessage({ id, raw }),
    (error) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  );
});
