import { parentPort } from 'node:worker_threads';
import { parseSessionRaw } from './parse.js';
import { parseTranscript } from './transcript.js';

/** Worker entry point for rawParsePool (#71, extended by #123 to also cover
 *  the focused-transcript path — see rawParsePool.ts's parseTranscript doc
 *  comment) — runs the expensive file read + line-by-line JSON.parse off the
 *  daemon's main thread, so it never competes with PTY draining and WS
 *  broadcast for the same event loop, and a single oversized file can only
 *  blow THIS worker's capped heap, never the daemon's. Deliberately minimal:
 *  this worker does ONLY the pure, file-derived parse — never touches PTY
 *  state, hook state, or anything else that lives on the main thread. */

if (!parentPort) {
  throw new Error('parseWorker must be run as a worker_thread');
}
const port = parentPort;

interface RawRequest {
  id: number;
  kind?: 'raw';
  file: string;
}

interface TranscriptRequest {
  id: number;
  kind: 'transcript';
  file: string;
  sessionId: string;
}

port.on('message', (msg: RawRequest | TranscriptRequest) => {
  const { id } = msg;
  if (msg.kind === 'transcript') {
    parseTranscript(msg.file, msg.sessionId).then(
      (transcript) => port.postMessage({ id, transcript }),
      (error) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  parseSessionRaw(msg.file).then(
    (raw) => port.postMessage({ id, raw }),
    (error) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  );
});
