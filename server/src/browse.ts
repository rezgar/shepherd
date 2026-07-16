import { readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface DirEntry {
  name: string;
}

export interface DirListing {
  path: string;
  /** '' means "go up to the drive list" (Windows only); null means already at the top. */
  parent: string | null;
  entries: DirEntry[];
}

async function listSubdirs(dirPath: string): Promise<DirEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Windows has no single filesystem root — enumerate which drive letters
 *  actually exist by probing each one rather than assuming C: is the only one. */
async function listDrives(): Promise<DirEntry[]> {
  const drives: DirEntry[] = [];
  for (const code of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${code}:\\`;
    try {
      await readdir(drive);
      drives.push({ name: drive });
    } catch {
      /* drive letter not present */
    }
  }
  return drives;
}

/** The parent folder of the most recently active known project — opening
 *  the picker here means you start right next to whatever you were just
 *  working on (and can see sibling projects too), rather than a drive root.
 *  Deliberately NOT the common ancestor of every project ever scanned: on a
 *  machine with any real history, that collapses to the drive root the
 *  moment even one old, unrelated session is in the mix. Falls back to the
 *  home directory when nothing's been scanned yet. */
export function defaultBrowseRoot(agents: { repoPath: string; lastActivity: number }[]): string {
  if (!agents.length) return os.homedir();
  const mostRecent = agents.reduce((a, b) => (b.lastActivity > a.lastActivity ? b : a));
  const parts = mostRecent.repoPath.replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop(); // the repo root's own parent, not the repo root itself
  if (!parts.length) return os.homedir();
  // First segment is a Windows drive letter ("C:") — needs a trailing
  // separator to be a valid root path, unlike every other segment.
  return parts.length === 1 ? `${parts[0]}\\` : parts.join('\\');
}

export async function listDir(
  requestedPath: string | undefined,
  agents: { repoPath: string; lastActivity: number }[],
): Promise<DirListing> {
  if (requestedPath === '') {
    return { path: '', parent: null, entries: await listDrives() };
  }
  const target = requestedPath && requestedPath.length ? requestedPath : defaultBrowseRoot(agents);
  const parsed = path.parse(target);
  const atDriveRoot = os.platform() === 'win32' && path.normalize(target) === parsed.root;
  const entries = await listSubdirs(target);
  const parent = atDriveRoot ? '' : path.dirname(target);
  return { path: target, parent, entries };
}
