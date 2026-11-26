import type { FileDiff, UnifiedDiff } from '../diff/types';
import type { SkippedFile } from './types';

/**
 * Whether a file (repo-relative, `/`) is excluded from AI review, e.g. by the organization's
 * Copilot content exclusion or the user's list. Excluded files are never sent: not their
 * content, not their name. Supplied by the host (`ReviewOptions.isExcluded`).
 */
export type IsExcluded = (path: string, signal: AbortSignal) => Promise<boolean>;

/**
 * `isExcluded` asked once per path (for one review). A call that rejects, cancelled for
 * example, is asked again next time.
 */
export function cacheExclusion(isExcluded: IsExcluded): IsExcluded {
  const answers = new Map<string, Promise<boolean>>();
  return (path, signal) => {
    let answer = answers.get(path);
    if (!answer) {
      const pending = isExcluded(path, signal);
      pending.catch(() => {
        if (answers.get(path) === pending) answers.delete(path);
      });
      answers.set(path, pending);
      answer = pending;
    }
    return answer;
  };
}

/**
 * Whether a file of the diff is excluded: by its path, or for a rename by its old path. A
 * check that fails because the review was cancelled counts as excluded (nothing is sent then
 * anyway); any other failure rejects.
 */
async function isExcludedFile(
  file: Pick<FileDiff, 'path' | 'oldPath'>,
  isExcluded: IsExcluded,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const paths =
      file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path];
    return (await Promise.all(paths.map((p) => isExcluded(p, signal)))).some(Boolean);
  } catch (err) {
    if (signal.aborted) return true;
    throw err;
  }
}

/** The diff without its excluded files, which are listed as skipped (`'excluded'`). */
export async function removeExcluded(
  diff: UnifiedDiff,
  isExcluded: IsExcluded,
  signal: AbortSignal,
): Promise<{ diff: UnifiedDiff; excluded: SkippedFile[] }> {
  const flags = await Promise.all(diff.files.map((f) => isExcludedFile(f, isExcluded, signal)));
  if (!flags.some(Boolean)) return { diff, excluded: [] };
  return {
    diff: { files: diff.files.filter((_, i) => !flags[i]) },
    excluded: diff.files
      .filter((_, i) => flags[i])
      .map((f) => ({ path: f.path, reason: 'excluded' as const })),
  };
}
