import { readFile } from "node:fs/promises";
import type { DiffFile, DiffHunk } from "../../protocol/index.js";

// Failure to read or parse the diff file. The skill is the only producer of
// these files; surfacing this distinct class lets the WS layer attach a
// stable error message when something goes wrong on read.
export class DiffError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "DiffError";
  }
}

export interface DiffResult {
  raw: string;
  files: DiffFile[];
}

export const getDiff = async (path: string): Promise<DiffResult> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new DiffError(
      `failed to read diff file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  return { raw, files: parseUnifiedDiff(raw) };
};

export const parseUnifiedDiff = (raw: string): DiffFile[] => {
  if (raw.length === 0) return [];

  const lines = raw.split("\n");
  const files: DiffFile[] = [];

  let current: DiffFile | null = null;
  let hunk: { header: string; body: string[]; newStart: number; newCount: number } | null = null;

  const flushHunk = () => {
    if (current && hunk) {
      const content = [hunk.header, ...hunk.body].join("\n");
      current.hunks.push(toHunk(hunk.newStart, hunk.newCount, content));
    }

    hunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (current)
      files.push(current);

    current = null;
  };

  for (const line of lines) {
    // `diff --git a/X b/Y` — file delimiter. Commit the previous file (and its
    // last hunk), then start a fresh one with the path extracted from this line.
    if (line.startsWith("diff --git ")) {
      flushFile();
      current = { path: extractPath(line), hunks: [] };
      continue;
    }

    // Anything before the first `diff --git` (prologue, garbage) is skipped:
    // we have no file to attach it to.
    if (!current) continue;

    // `--- a/X` (from-path) and `+++ b/Y` (to-path) — path refiners. Git always
    // emits these after `diff --git`. The `+++` line is preferred since it's
    // the post-change path (what the file IS now). Fall back to `---` only if
    // we somehow didn't get a path from `diff --git` at all.
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const path = extractHeaderPath(line);
      if (path && line.startsWith("+++ ")) {
        current.path = path;
      } else if (path && line.startsWith("--- ") && current.path === "") {
        current.path = path;
      }
      continue;
    }

    // `@@ -OLD,COUNT +NEW,COUNT @@` — hunk header. Commit the previous hunk,
    // then start a new one. Keep both the raw header line (for the rendered
    // `content`) and the parsed line numbers (for `from_line`/`to_line`).
    if (line.startsWith("@@")) {
      flushHunk();
      const header = parseHunkHeader(line);
      if (!header) continue;
      hunk = {
        header: line,
        body: [],
        newStart: header.newStart,
        newCount: header.newCount,
      };
      continue;
    }

    // Inside an open hunk, body lines start with one of:
    //   " " context, "+" addition, "-" removal, "\" the rare
    //   "\ No newline at end of file" marker.
    // Anything else (blank lines between hunks, `index abc..def` lines, etc.)
    // is silently dropped — defensive against malformed input.
    if (hunk) {
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) {
        hunk.body.push(line);
      }
    }
  }
  flushFile();

  return files;
};

const toHunk = (newStart: number, newCount: number, content: string): DiffHunk => {
  const from = newStart;
  const to = newCount > 0 ? newStart + newCount - 1 : newStart;
  return { from_line: from, to_line: to, content };
};

const extractPath = (diffLine: string): string => {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(diffLine);
  if (!match) return "";
  return match[2] ?? match[1] ?? "";
};

const extractHeaderPath = (line: string): string | null => {
  const body = line.slice(4).trim();
  if (body === "/dev/null") return null;
  if (body.startsWith("a/") || body.startsWith("b/")) return body.slice(2);
  return body;
};

const parseHunkHeader = (line: string): { newStart: number; newCount: number } | null => {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  const newStart = Number.parseInt(match[1] ?? "0", 10);
  const newCount = match[2] ? Number.parseInt(match[2], 10) : 1;
  return { newStart, newCount };
};
