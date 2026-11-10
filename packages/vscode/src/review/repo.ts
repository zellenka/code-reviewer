import { DiffSourceError, toPosixPath, type Logger } from '@ai-review/core';
import { GitCliDiffSource, createGitRunner, findRepoRoot } from '@ai-review/node-host';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** The part of the built-in Git extension API (vscode.git, API v1) we use. */
interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: { readonly rootUri: vscode.Uri }[];
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export interface RepoContext {
  /** Absolute OS path of the repo root. */
  root: string;
  source: GitCliDiffSource;
}

/**
 * Finds the repo to review and builds a diff source for it. Repo discovery uses the
 * built-in Git extension (multi-repo aware) and its git binary; diffs come from the
 * same git CLI code the CLI and evals use.
 */
export class RepoLocator {
  constructor(private readonly logger: Logger) {}

  /**
   * Repo for `target` (a file or folder), else the active editor's repo,
   * else the only repo, else asks. Throws `DiffSourceError` when there's none.
   */
  async resolve(target?: vscode.Uri | string): Promise<RepoContext | undefined> {
    const api = await this.gitApi();
    const gitPath = api?.git.path;
    const explicit = typeof target === 'string' ? target : target?.fsPath;
    if (explicit) {
      // git needs a directory as its working directory.
      const dir = (await isDirectory(explicit)) ? explicit : path.dirname(explicit);
      return this.create(await findRepoRoot(dir, gitPath), gitPath);
    }

    const roots = await this.knownRoots(api);
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      const owner = roots
        .filter((r) => isInside(r, active.fsPath))
        .sort((a, b) => b.length - a.length)[0];
      if (owner) return this.create(owner, gitPath);
    }
    if (roots.length === 1) return this.create(roots[0]!, gitPath);
    if (roots.length === 0) {
      throw new DiffSourceError('noRepo', 'No git repository found in this workspace.');
    }
    const picked = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: path.basename(r), description: r, root: r })),
      { placeHolder: 'Which repository do you want to review?' },
    );
    return picked ? this.create(picked.root, gitPath) : undefined;
  }

  /** All repositories in the workspace (absolute OS paths), without asking. */
  async roots(): Promise<string[]> {
    return this.knownRoots(await this.gitApi());
  }

  /** Local and remote-tracking branch names of `root`, for the base branch picker. */
  async branches(root: string): Promise<string[]> {
    try {
      const git = createGitRunner(root, (await this.gitApi())?.git.path);
      const { stdout } = await git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
        { allowFail: true },
      );
      return stdout
        .split('\n')
        .map((b) => b.trim())
        .filter((b) => b && !b.endsWith('/HEAD') && b !== 'origin');
    } catch (err) {
      this.logger.debug(`listing branches failed: ${String(err)}`);
      return [];
    }
  }

  private create(root: string, gitPath: string | undefined): RepoContext {
    const source = new GitCliDiffSource({
      root,
      ...(gitPath ? { gitPath } : {}),
      defaultBase: () =>
        vscode.workspace.getConfiguration('aiReview').get<string>('baseBranch') || undefined,
      logger: this.logger,
    });
    return { root, source };
  }

  private async knownRoots(api: GitApi | undefined): Promise<string[]> {
    const roots = new Set<string>();
    for (const repo of api?.repositories ?? []) roots.add(path.resolve(repo.rootUri.fsPath));
    if (!roots.size) {
      // Git extension missing or still scanning: ask git directly for each folder.
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        try {
          roots.add(await findRepoRoot(folder.uri.fsPath, api?.git.path));
        } catch {
          // not a repo
        }
      }
    }
    return [...roots];
  }

  private async gitApi(): Promise<GitApi | undefined> {
    try {
      const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!ext) return undefined;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (!exports.enabled) return undefined;
      const api = exports.getAPI(1);
      if (api.state !== 'initialized') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          const sub = api.onDidChangeState((s) => {
            if (s === 'initialized') {
              clearTimeout(timer);
              sub.dispose();
              resolve();
            }
          });
        });
      }
      return api;
    } catch (err) {
      this.logger.debug(`git extension unavailable: ${String(err)}`);
      return undefined;
    }
  }
}

/** Repo-relative POSIX path of `fsPath`, or undefined if it's outside `root`. */
export function relativeToRepo(root: string, fsPath: string): string | undefined {
  if (!isInside(root, fsPath)) return undefined;
  return toPosixPath(path.relative(root, fsPath));
}

function isInside(root: string, target: string): boolean {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const rel = path.relative(ci ? root.toLowerCase() : root, ci ? target.toLowerCase() : target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
