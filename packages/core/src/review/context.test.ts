import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { parseUnifiedDiff } from '../diff/parse';
import type { FileDiff } from '../diff/types';
import { MockProvider, mockToolCall } from '../provider/mock';
import type { ModelInfo } from '../provider/types';
import { chunkFiles, renderChunk } from './chunker';
import { buildFileContext, changedSymbols, renderChangedSymbols } from './context';
import { REPORT_TOOL_NAME } from './output';
import { runReview } from './orchestrator';
import { enclosingSymbols, heuristicSymbols, loadSymbols, type CodeSymbol } from './symbols';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'Mock',
  vendor: 'mock',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
  supportsTools: true,
};

const CART = `import { tax } from './tax';

/** A shopping cart. */
export class Cart {
  private items: Item[] = [];

  add(item: Item): void {
    this.items.push(item);
  }

  total(): number {
    let sum = 0;
    for (const item of this.items) {
      sum += item.price * item.qty;
    }
    const withTax = sum + tax(sum);
    return withTax;
  }

  clear(): void {
    this.items = [];
  }
}

export function emptyCart(): Cart {
  return new Cart();
}
`;

/** A one-line change inside Cart.total (line 16), as git would show it with 1 line of context. */
function cartDiff(content = CART): FileDiff {
  const diff = parseUnifiedDiff(
    [
      'diff --git a/src/cart.ts b/src/cart.ts',
      '--- a/src/cart.ts',
      '+++ b/src/cart.ts',
      '@@ -15,3 +15,3 @@',
      '     }',
      '-    const withTax = sum * tax(sum);',
      '+    const withTax = sum + tax(sum);',
      '     return withTax;',
      '',
    ].join('\n'),
  ).files[0]!;
  return { ...diff, newContent: content };
}

describe('heuristicSymbols', () => {
  it('finds classes, methods and functions with their blocks', () => {
    const tree = heuristicSymbols(CART);
    expect(tree.map((s) => [s.kind, s.name, s.startLine, s.endLine])).toEqual([
      ['class', 'Cart', 4, 23],
      ['function', 'emptyCart', 25, 27],
    ]);
    expect(tree[0]!.children!.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['add', 7, 9],
      ['total', 11, 18],
      ['clear', 20, 22],
    ]);
    expect(enclosingSymbols(tree, 16).map((s) => s.name)).toEqual(['Cart', 'total']);
  });

  it('handles Python, arrow functions and multi-line signatures', () => {
    const py =
      'class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        pass\n\nx = 1\n';
    const tree = heuristicSymbols(py);
    expect(tree[0]).toMatchObject({ name: 'A', startLine: 1, endLine: 6 });
    expect(tree[0]!.children!.map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['f', 2, 3],
      ['g', 5, 6],
    ]);

    const ts = [
      'export const run = async (a: number) => {',
      '  return a;',
      '};',
      'function long(',
      '  a: number,',
      '  b: number,',
      '): number {',
      '  return a + b;',
      '}',
      'if (x) {',
      '  call();',
      '}',
    ].join('\n');
    expect(heuristicSymbols(ts).map((s) => [s.name, s.startLine, s.endLine])).toEqual([
      ['run', 1, 3],
      ['long', 4, 9],
    ]);
  });
});

describe('buildFileContext', () => {
  it('includes the whole changed method and the class header (P4-1)', () => {
    const file = cartDiff();
    const ranges = buildFileContext(file, file.hunks, undefined);
    const lines = ranges.flatMap((r) => r.lines.map((text, i) => [r.startLine + i, text]));
    const numbers = lines.map(([n]) => n);
    // Class header, then total() lines 11-18 minus the hunk's own lines 15-17.
    expect(numbers).toEqual([4, 11, 12, 13, 14, 18]);
    expect(lines[0]![1]).toBe('export class Cart {');

    const rendered = renderChunk(
      chunkFiles([file], {
        maxTokens: 10_000,
        context: (f, h) => buildFileContext(f, h, undefined),
      })[0]!,
    );
    expect(rendered).toContain('<context path="src/cart.ts">');
    expect(rendered).toMatch(/ {5}4 {3}export class Cart \{/);
    expect(rendered).toMatch(/11 {3} {2}total\(\): number \{/);
    expect(rendered).not.toContain('clear()');
  });

  it('prefers language-server symbols when given', () => {
    const file = cartDiff();
    const symbols: CodeSymbol[] = [
      {
        name: 'Cart',
        kind: 'class',
        startLine: 4,
        endLine: 23,
        children: [{ name: 'total', kind: 'method', startLine: 13, endLine: 17 }],
      },
    ];
    const numbers = buildFileContext(file, file.hunks, symbols).flatMap((r) =>
      r.lines.map((_, i) => r.startLine + i),
    );
    expect(numbers).toEqual([4, 13, 14]);
  });

  it('falls back to surrounding lines outside any symbol or when the symbol is too big', () => {
    const content = Array.from({ length: 60 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');
    const file: FileDiff = {
      path: 'src/v.ts',
      status: 'modified',
      binary: false,
      newContent: content,
      hunks: [
        {
          oldStart: 30,
          oldLines: 1,
          newStart: 30,
          newLines: 1,
          lines: [
            { kind: 'del', text: 'const v30 = 0;', oldLine: 30 },
            { kind: 'add', text: 'const v30 = 30;', newLine: 30 },
          ],
        },
      ],
    };
    const ranges = buildFileContext(file, file.hunks, undefined, { surroundingLines: 3 });
    expect(ranges.map((r) => [r.startLine, r.lines.length])).toEqual([
      [27, 3],
      [31, 3],
    ]);
  });

  it('keeps within the token budget and returns nothing without content', () => {
    const file = cartDiff();
    const tiny = buildFileContext(file, file.hunks, undefined, { maxTokens: 12 });
    expect(tiny.flatMap((r) => r.lines)).toEqual(['export class Cart {']);
    const { newContent: _c, ...noContent } = file;
    expect(buildFileContext(noContent, file.hunks, undefined)).toEqual([]);
  });

  it('drops the context of a chunk that would not fit with it', () => {
    const file = cartDiff();
    const plain = chunkFiles([file], { maxTokens: 200 });
    const withContext = chunkFiles([file], {
      maxTokens: 200,
      context: () => [{ startLine: 1, lines: Array.from({ length: 200 }, () => 'x'.repeat(40)) }],
    });
    expect(renderChunk(withContext[0]!)).toBe(renderChunk(plain[0]!));
  });
});

describe('changed symbols index', () => {
  it('lists the innermost changed symbol per file, only for multi-file diffs', () => {
    const cart = cartDiff();
    const util: FileDiff = {
      path: 'src/util.ts',
      status: 'added',
      binary: false,
      newContent: 'export function fmt(n: number) {\n  return n.toFixed(2);\n}\n',
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: 'add', text: 'export function fmt(n: number) {', newLine: 1 },
            { kind: 'add', text: '  return n.toFixed(2);', newLine: 2 },
            { kind: 'add', text: '}', newLine: 3 },
          ],
        },
      ],
    };
    const list = changedSymbols([cart, util]);
    expect(list.map((s) => `${s.path} ${s.names.join('.')}`)).toEqual([
      'src/cart.ts Cart.total',
      'src/util.ts fmt',
    ]);
    const text = renderChangedSymbols(list)!;
    expect(text).toContain('- src/cart.ts:11-18 method Cart.total: `total(): number {`');
    expect(renderChangedSymbols(changedSymbols([cart]))).toBeUndefined();
  });

  it('is sent before every part, with a cache hint, and context reaches the model', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ ...cartDiff(), path: `src/c${i}.ts` }));
    const provider = new MockProvider({
      fallback: mockToolCall(REPORT_TOOL_NAME, { findings: [] }),
    });
    await runReview(
      { files },
      { provider, model: MODEL, config: DEFAULT_CONFIG, maxChunkTokens: 600, concurrency: 1 },
    );
    expect(provider.requests.length).toBeGreaterThan(1);
    for (const req of provider.requests) {
      const [shared, diff] = req.messages[0]!.content;
      expect(shared).toMatchObject({ type: 'text', cache: true });
      expect((shared as { text: string }).text).toContain('<changed_symbols>');
      expect((diff as { text: string }).text).toContain('<context path=');
      expect(req.system.at(-1)!.cache).toBe(true);
    }
  });

  it('can be turned off', async () => {
    const provider = new MockProvider({
      fallback: mockToolCall(REPORT_TOOL_NAME, { findings: [] }),
    });
    await runReview(
      { files: [cartDiff(), { ...cartDiff(), path: 'src/b.ts' }] },
      { provider, model: MODEL, config: DEFAULT_CONFIG, context: false },
    );
    const text = JSON.stringify(provider.requests[0]!.messages);
    expect(text).not.toContain('<changed_symbols>');
    expect(text).not.toContain('<context');
  });
});

describe('loadSymbols', () => {
  it('collects host symbols, skipping failures and slow files', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts'].map((p): FileDiff => ({
      path: p,
      status: 'modified',
      binary: false,
      hunks: [],
      newContent: 'x',
    }));
    const index = await loadSymbols(
      files,
      {
        documentSymbols: async (p) => {
          if (p === 'b.ts') throw new Error('no server');
          if (p === 'c.ts') return new Promise(() => {});
          return [{ name: 'A', kind: 'class', startLine: 1, endLine: 1 }];
        },
      },
      { timeoutMs: 20 },
    );
    expect([...index.keys()]).toEqual(['a.ts']);
  });
});
