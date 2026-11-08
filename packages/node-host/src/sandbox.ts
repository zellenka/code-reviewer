import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { DiffSourceError } from '@ai-review/core';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function isInside(root: string, target: string): boolean {
  const rel = path.relative(
    caseInsensitive ? root.toLowerCase() : root,
    caseInsensitive ? target.toLowerCase() : target,
  );
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Where an existing file inside the repo really lives (after symlinks), repo-relative with
 * `/`. A committed `docs/notes.md → ../.env` gives `.env`, so callers can refuse secrets by
 * what is read, not by the name asked for.
 */
export async function realRepoPath(root: string, abs: string): Promise<string> {
  const [realRoot, real] = await Promise.all([realpath(path.resolve(root)), realpath(abs)]);
  return path.relative(realRoot, real).split(path.sep).join('/');
}

/**
 * Resolves a repo-relative path to an absolute one inside `root`.
 * Rejects absolute paths, `..` escapes and symlinks that point outside the repo.
 * Throws `DiffSourceError('outsideRepo')`.
 */
export async function resolveInRepo(root: string, relPath: string): Promise<string> {
  const reject = () =>
    new DiffSourceError('outsideRepo', `Path is outside the repository: ${relPath}`);
  if (!relPath || relPath.includes('\0')) throw reject();
  const posix = relPath.replace(/\\/g, '/');
  if (path.isAbsolute(relPath) || path.posix.isAbsolute(posix) || /^[a-zA-Z]:/.test(posix)) {
    throw reject();
  }
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, ...posix.split('/'));
  if (!isInside(absRoot, target)) throw reject();

  // Follow symlinks (for the deepest existing ancestor too, so new paths are checked).
  const realRoot = await realpath(absRoot);
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      const resolved = path.join(real, ...rest);
      if (!isInside(realRoot, resolved)) throw reject();
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
