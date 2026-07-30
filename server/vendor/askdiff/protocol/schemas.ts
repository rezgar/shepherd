import { z } from "zod";
import type { ClientMessage } from "./types.js";

export const PROTOCOL_VERSION = "askdiff/1";

export const DiffHunkSchema = z.object({
  from_line: z.number().int().nonnegative(),
  to_line: z.number().int().nonnegative(),
  content: z.string(),
});

export const DiffFileSchema = z.object({
  path: z.string(),
  hunks: z.array(DiffHunkSchema),
});

export const AskMessageSchema = z.object({
  type: z.literal("ask"),
  id: z.string().min(1),
  file: z.string(),
  from_line: z.number().int().nonnegative(),
  to_line: z.number().int().nonnegative(),
  chunk: z.string(),
  question: z.string().min(1),
  model: z.string().min(1).optional(),
});

export const CancelMessageSchema = z.object({
  type: z.literal("cancel"),
  id: z.string().min(1),
});

export const DiffRequestMessageSchema = z.object({
  type: z.literal("diff_request"),
});

export const PingMessageSchema = z.object({
  type: z.literal("ping"),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  AskMessageSchema,
  CancelMessageSchema,
  DiffRequestMessageSchema,
  PingMessageSchema,
]);

export const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  project: z.string(),
});

export const DiffMessageSchema = z.object({
  type: z.literal("diff"),
  raw: z.string(),
  files: z.array(DiffFileSchema),
  // Short human description of *what* this diff shows ("HEAD~1..HEAD",
  // "main…feature/x", "Working tree"). The skill sets it via the
  // ASKDIFF_DIFF_LABEL env var; absent for legacy clients.
  label: z.string().optional(),
  // Set true when the server detected that one or more files in the diff
  // have been modified (or removed) since the diff was captured. Only
  // populated for "volatile" diffs — i.e. working-tree diffs the skill
  // marked with ASKDIFF_DIFF_VOLATILE=1. Description-based diffs
  // (HEAD~1..HEAD, main…feature/x) never set this since their content
  // doesn't depend on the working tree.
  stale: z.boolean().optional(),
  // Paths (relative to project cwd) of files whose mtime is newer than
  // the diff file's mtime, or that no longer exist on disk. The UI uses
  // this to mark individual files in the FileTree.
  staleFiles: z.array(z.string()).optional(),
});

export const ChunkMessageSchema = z.object({
  type: z.literal("chunk"),
  id: z.string().min(1),
  delta: z.string(),
});

export const DoneMessageSchema = z.object({
  type: z.literal("done"),
  id: z.string().min(1),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  id: z.string().min(1).optional(),
  message: z.string(),
});

export const PongMessageSchema = z.object({
  type: z.literal("pong"),
});

// Read-only — emitted once on connect so the UI can display "asks go to
// this session." There is no client-side counterpart: session attachment
// is locked in at server startup via ASKDIFF_SESSION_ID.
export const SessionMessageSchema = z.object({
  type: z.literal("session"),
  session_id: z.string().min(1),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  DiffMessageSchema,
  ChunkMessageSchema,
  DoneMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
  SessionMessageSchema,
]);

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const parseClientMessage = (raw: unknown): ParseResult<ClientMessage> => {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const result = ClientMessageSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error) };
  }
  return { ok: true, value: result.data };
};

const formatZodError = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
