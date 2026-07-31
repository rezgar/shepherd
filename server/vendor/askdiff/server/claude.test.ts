import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AskMessage } from "../protocol/index.js";

// Regression coverage for asks silently stranding forever: streamAnswer
// spawned a bare `"claude"`, resolved via the process's PATH — which
// ENOENTs inside the packaged desktop app (its PATH doesn't include the
// CLI shim's directory the way a normal terminal's does). Node reports a
// failed spawn via an async `error` event, not a thrown exception; with
// nothing listening for it, that event is an UNCAUGHT exception that
// crashes straight past every try/catch here, past handleAsk's own
// try/catch in index.ts, and lands only in the daemon's top-level
// uncaughtException handler — no `chunk`/`done`/`error` WS message is ever
// sent, so the ask sits in "streaming" state forever. These tests exercise
// the REAL node:child_process spawn path (not mocked) against a genuinely
// nonexistent executable, so they fail the same way production did if the
// `error` listener regresses to missing again.
vi.mock("../../../src/claudeExecutable.js", () => ({
  resolveClaudeExecutable: () => path.join(os.tmpdir(), "definitely-does-not-exist-claude-binary-12345"),
}));

const { streamAnswer, ClaudeCliError } = await import("./claude.js");

const ASK: AskMessage = {
  type: "ask",
  id: "test-ask-1",
  file: "src/example.ts",
  from_line: 1,
  to_line: 1,
  chunk: "const x = 1;",
  question: "why?",
};

describe("streamAnswer — spawn failure", () => {
  it("surfaces a ClaudeCliError instead of hanging or throwing uncaught", async () => {
    const controller = new AbortController();
    const chunks: string[] = [];

    await expect(async () => {
      for await (const delta of streamAnswer({
        cwd: process.cwd(),
        sessionId: "fake-session",
        ask: ASK,
        signal: controller.signal,
      })) {
        chunks.push(delta);
      }
    }).rejects.toThrow(ClaudeCliError);

    expect(chunks).toEqual([]);
  }, 10_000);
});
