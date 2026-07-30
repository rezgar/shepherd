import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// git's canonical empty-tree object — diffing against it is equivalent to
// "everything in the working tree is new", which is what we want when
// `HEAD` doesn't resolve (a brand-new repo with no commits yet).
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_BUFFER = 64 * 1024 * 1024;

// Recomputes the working-tree diff, mirroring the `askdiff` skill's own
// Step 2 bash (tracked changes via `git diff HEAD`, untracked files
// unioned in via `--no-index` since `git diff HEAD` never shows them).
// Called on every filesystem event for a volatile session so the server
// can push a live update instead of waiting for the user to re-run
// `/askdiff`.
export async function captureWorkingTreeDiff(cwd: string): Promise<string> {
  const tracked = await diffAgainstHead(cwd);

  const { stdout: rawUntracked } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd, maxBuffer: MAX_BUFFER },
  );
  const untrackedFiles = rawUntracked.split("\0").filter((f) => f.length > 0);

  const untrackedDiffs = await Promise.all(
    untrackedFiles.map((file) => diffAgainstDevNull(cwd, file)),
  );

  return tracked + untrackedDiffs.join("");
}

async function diffAgainstHead(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--no-color"], {
      cwd,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    // `HEAD` doesn't resolve — no commits yet. Fall back to the empty
    // tree rather than surfacing the ref-resolution error.
    const { stdout } = await execFileAsync(
      "git",
      ["diff", EMPTY_TREE_SHA, "--no-color"],
      { cwd, maxBuffer: MAX_BUFFER },
    );
    return stdout;
  }
}

// `git diff --no-index` exits 1 whenever the two sides differ — which is
// always true here (a real file against /dev/null) — so Node treats it as
// a rejected promise even though this is the expected, successful case.
// Unwrap `stdout` from the error rather than treating it as a failure.
async function diffAgainstDevNull(cwd: string, file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--no-color", "--", "/dev/null", file],
      { cwd, maxBuffer: MAX_BUFFER },
    );
    return stdout;
  } catch (err) {
    if (isExecFileErrorWithStdout(err)) return err.stdout;
    throw err;
  }
}

function isExecFileErrorWithStdout(err: unknown): err is { stdout: string } {
  return (
    typeof err === "object" && err !== null && "stdout" in err && typeof err.stdout === "string"
  );
}
