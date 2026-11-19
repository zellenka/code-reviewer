import { readFile } from 'node:fs/promises';
import {
  loadRepoRules,
  type LoadRulesOptions,
  type RepoRules,
  type ReviewConfig,
} from '@ai-review/core';
import { realRepoPath, resolveInRepo } from './sandbox';

/**
 * Reads a repo-relative text file, sandboxed to `root`. Undefined when it doesn't exist.
 * Throws for paths outside the repo (e.g. a `rules:` value of `../secrets.md`). Secret files
 * are refused by the caller (`loadRepoRules`).
 */
export async function readRepoText(root: string, relPath: string): Promise<string | undefined> {
  const abs = await resolveInRepo(root, relPath);
  try {
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
  options: LoadRulesOptions = {},
): Promise<RepoRules> {
  return loadRepoRules((p) => readRepoText(root, p), config, {
    realPath: async (p) => realRepoPath(root, await resolveInRepo(root, p)),
    ...options,
  });
}
