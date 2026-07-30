import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DiffFile } from "../../protocol/index.js";

export interface StalenessResult {
  stale: boolean;
  staleFiles: string[];
}

// Compare the diff file's mtime against the mtime of each file in the
// parsed diff (relative to `cwd`). A file counts as "stale" if its
// current mtime is newer than the diff file's mtime, or if it has been
// removed from disk. Only meaningful for working-tree diffs — call sites
// must gate on `state.volatile`.
export const checkStaleness = async (
  diffFile: string,
  cwd: string,
  files: DiffFile[],
): Promise<StalenessResult> => {
  const diffStat = await stat(diffFile).catch(() => null);
  if (diffStat === null) return { stale: false, staleFiles: [] };
  const diffMtime = diffStat.mtimeMs;

  const staleFiles: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      if (file.path.length === 0) return;
      const filePath = join(cwd, file.path);
      const fileStat = await stat(filePath).catch(() => null);
      // Missing file ⇒ removed since the diff was taken ⇒ stale.
      if (fileStat === null) {
        staleFiles.push(file.path);
        return;
      }
      if (fileStat.mtimeMs > diffMtime) staleFiles.push(file.path);
    }),
  );

  return { stale: staleFiles.length > 0, staleFiles };
};
