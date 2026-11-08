import {
  enclosingSymbols,
  isDiffSourceError,
  normalizeEol,
  type CodeSymbol,
  type Logger,
  type SymbolProvider,
} from '@ai-review/core';
import {
  FsWorkspaceTools,
  resolveInRepo,
  type FsWorkspaceToolsOptions,
} from '@ai-review/node-host';
import * as vscode from 'vscode';
import { relativeToRepo } from './repo';

/** Language servers can be slow (first start of tsserver); after this we fall back. */
const LSP_TIMEOUT_MS = 5_000;

/** Symbol kinds that make useful context. Single-line variables are dropped separately. */
const STRUCTURAL = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Package,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Object,
  vscode.SymbolKind.Variable,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.Property,
]);

/**
 * Read-only workspace tools for agentic reviews: file reads and grep from node-host
 * (same path sandbox: no `..`, no symlinks out of the repo, size caps), references and
 * symbols from the language server when one answers, else grep / heuristics.
 */
export class VsCodeWorkspaceTools extends FsWorkspaceTools {
  constructor(
    root: string,
    private readonly logger: Logger,
    options?: FsWorkspaceToolsOptions,
  ) {
    super(root, options);
  }

  override async findReferences(
    relPath: string,
    line: number,
    col: number,
  ): Promise<{ path: string; line: number }[]> {
    const abs = await resolveInRepo(this.root, relPath);
    try {
      const locations = await withTimeout(
        vscode.commands.executeCommand<vscode.Location[] | undefined>(
          'vscode.executeReferenceProvider',
          vscode.Uri.file(abs),
          new vscode.Position(line - 1, Math.max(0, col - 1)),
        ),
      );
      if (locations?.length) {
        const out: { path: string; line: number }[] = [];
        for (const loc of locations) {
          const rel = relativeToRepo(this.root, loc.uri.fsPath);
          // Outside the repo, or in dependencies: not useful and possibly large.
          if (!rel || /(^|\/)(node_modules|\.git)\//.test(rel)) continue;
          out.push({ path: rel, line: loc.range.start.line + 1 });
        }
        // A server that only knows the open file (no project loaded) finds just the
        // declaration: add the text matches from other files.
        if (out.some((r) => r.path !== relPath)) return out;
        if (out.length) return mergeRefs(out, await super.findReferences(relPath, line, col));
      }
    } catch (err) {
      this.logger.debug(`reference provider failed for ${relPath}: ${String(err)}`);
    }
    return super.findReferences(relPath, line, col);
  }

  override async getSymbolAt(
    relPath: string,
    line: number,
  ): Promise<{ name: string; kind: string; startLine: number; endLine: number } | null> {
    const abs = await resolveInRepo(this.root, relPath);
    const symbols = await documentSymbols(vscode.Uri.file(abs), this.logger);
    const inner = symbols ? enclosingSymbols(symbols, line).at(-1) : undefined;
    if (!inner) return null;
    return {
      name: inner.name,
      kind: inner.kind,
      startLine: inner.startLine,
      endLine: inner.endLine,
    };
  }
}

function mergeRefs(
  a: { path: string; line: number }[],
  b: { path: string; line: number }[],
): { path: string; line: number }[] {
  const seen = new Set(a.map((r) => `${r.path}:${r.line}`));
  return [...a, ...b.filter((r) => !seen.has(`${r.path}:${r.line}`))];
}

/** Language-server symbols for review context (P4-1), when the editor's file matches the reviewed content. */
export class VsCodeSymbolProvider implements SymbolProvider {
  constructor(
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

  async documentSymbols(path: string, content: string): Promise<CodeSymbol[] | undefined> {
    try {
      const abs = await resolveInRepo(this.root, path);
      const uri = vscode.Uri.file(abs);
      const doc = await vscode.workspace.openTextDocument(uri);
      // Staged reviews (index ≠ working tree) or unsaved edits: line numbers would be wrong.
      if (normalizeEol(doc.getText()) !== normalizeEol(content)) return undefined;
      return await documentSymbols(uri, this.logger);
    } catch (err) {
      if (!isDiffSourceError(err)) this.logger.debug(`no symbols for ${path}: ${String(err)}`);
      return undefined;
    }
  }
}

async function documentSymbols(uri: vscode.Uri, logger: Logger): Promise<CodeSymbol[] | undefined> {
  try {
    const result = await withTimeout(
      vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
      >('vscode.executeDocumentSymbolProvider', uri),
    );
    if (!result?.length) return undefined;
    return result.flatMap(toCodeSymbol);
  } catch (err) {
    logger.debug(`symbol provider failed for ${uri.fsPath}: ${String(err)}`);
    return undefined;
  }
}

function toCodeSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): CodeSymbol[] {
  if (!STRUCTURAL.has(symbol.kind)) return [];
  const range = 'range' in symbol ? symbol.range : symbol.location.range;
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  const isValue =
    symbol.kind === vscode.SymbolKind.Variable ||
    symbol.kind === vscode.SymbolKind.Constant ||
    symbol.kind === vscode.SymbolKind.Property;
  // `const x = 1` inside a function would hide the function itself.
  if (isValue && startLine === endLine) return [];
  const out: CodeSymbol = {
    name: symbol.name,
    kind: (vscode.SymbolKind[symbol.kind] ?? 'symbol').toLowerCase(),
    startLine,
    endLine,
  };
  if ('children' in symbol && symbol.children.length) {
    const children = symbol.children.flatMap(toCodeSymbol);
    if (children.length) out.children = children;
  }
  return [out];
}

function withTimeout<T>(thenable: Thenable<T>): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), LSP_TIMEOUT_MS);
    thenable.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
