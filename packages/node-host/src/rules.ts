import { readFile } from 'node:fs/promises';
import {
  isDiffSourceError,
  isProtectedPath,
  loadRepoRules,
  noopLogger,
  type LoadRulesOptions,
  type Logger,
  type RepoRules,
  type ReviewConfig,
} from '@ai-review/core';
import { realRepoPath, resolveInRepo } from './sandbox';

/**
 * Reads a repo-relative text file, sandboxed to `root`. Undefined when it doesn't exist.
 * Throws for paths outside the repo (e.g. a `rules:` value of `../secrets.md`) and for
 * symlinks to secret files.
 */
export async function readRepoText(root: string, relPath: string): Promise<string | undefined> {
  const abs = await resolveInRepo(root, relPath);
  try {
    if (isProtectedPath(await realRepoPath(root, abs))) {
      throw new Error(`${relPath} can't be read: it may contain secrets.`);
    }
    return await readFile(abs, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw err;
  }
}

/** Loads `.codereview.md` (or `rules:`), AGENTS.md and .github/copilot-instructions.md. */
export async function loadRepoRulesFromDisk(
  root: string,
  config: Pick<ReviewConfig, 'rules'>,
  options: LoadRulesOptions & { logger?: Logger } = {},
): Promise<RepoRules> {
  const logger = options.logger ?? noopLogger;
  return loadRepoRules(
    async (p) => {
      try {
        return await readRepoText(root, p);
      } catch (err) {
        if (isDiffSourceError(err)) {
          logger.warn(`rules file ${p} ignored: it is outside the repository`);
          return undefined;
        }
        throw err;
      }
    },
    config,
    options,
  );
}
