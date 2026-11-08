import { describe, expect, it } from 'vitest';
import type { WorkspaceTools } from '../diff/types';
import type { AgentTool } from './loop';
import { createReviewTools } from './tools';

const FILES: Record<string, string> = {
  'src/price.ts':
    'export function formatPrice(cents: number, currency: string) {\n  return `${currency} ${(cents / 100).toFixed(2)}`;\n}\n',
  'src/cart.ts':
    "import { formatPrice } from './price';\nconst key = 'AKIAIOSFODNN7EXAMPLE';\nexport const label = formatPrice('EUR', 100);\n",
  '.env': 'TOKEN=secret',
  '.git/config': '[remote] url = https://token@github.com/x',
  'big.ts': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'),
};

/** In-memory host: sandboxing is the host's job, so this one just refuses '..'. */
const ws: WorkspaceTools = {
  readFile: async (p, range) => {
    if (p.includes('..')) throw new Error(`Path is outside the repository: ${p}`);
    const text = FILES[p];
    if (text === undefined)
      throw Object.assign(new Error(`ENOENT: C:\\Users\\me\\${p}`), { code: 'ENOENT' });
    return range
      ? text
          .split('\n')
          .slice(range.start - 1, range.end)
          .join('\n')
      : text;
  },
  grep: async (pattern) =>
    Object.entries(FILES).flatMap(([path, text]) =>
      text
        .split('\n')
        .flatMap((t, i) => (new RegExp(pattern).test(t) ? [{ path, line: i + 1, text: t }] : [])),
    ),
  findReferences: async () => [
    { path: 'src/price.ts', line: 1 },
    { path: 'src/cart.ts', line: 3 },
    { path: '.env', line: 1 },
  ],
  getSymbolAt: async () => null,
};

const tools = new Map(createReviewTools(ws, { maxLines: 50 }).map((t) => [t.def.name, t]));
const call = (name: string, input: unknown) => {
  const tool = tools.get(name)! as unknown as AgentTool<unknown>;
  return tool.run(tool.schema.parse(input), new AbortController().signal);
};

describe('review tools', () => {
  it('reads files with line numbers and caps long ones', async () => {
    expect(await call('read_file', { path: './src/price.ts', startLine: 1, endLine: 1 })).toBe(
      'src/price.ts lines 1-1:\n     1  export function formatPrice(cents: number, currency: string) {\n… (3 lines in total; ask for startLine 2+)',
    );
    const long = await call('read_file', { path: 'big.ts' });
    expect(long).toContain('    50  line 50');
    expect(long).not.toContain('line 51');
    expect(long).toContain('1000 lines in total; ask for startLine 51+');
  });

  it('refuses secrets and .git, and hides absolute paths', async () => {
    await expect(call('read_file', { path: '.env' })).rejects.toThrow(/may contain secrets/);
    await expect(call('read_file', { path: '.git/config' })).rejects.toThrow(/may contain secrets/);
    await expect(call('read_file', { path: '../outside.ts' })).rejects.toThrow(
      /outside the repository/,
    );
    await expect(call('read_file', { path: 'missing.ts' })).rejects.toThrow(
      'File not found: missing.ts',
    );
    expect(await call('search_code', { pattern: 'TOKEN|remote' })).toBe('No matches.');
  });

  it('redacts secrets in results', async () => {
    const text = await call('read_file', { path: 'src/cart.ts' });
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('[REDACTED');
  });

  it('finds references by symbol name, with line text', async () => {
    const out = await call('find_references', {
      path: 'src/price.ts',
      line: '1',
      symbol: 'formatPrice',
    });
    expect(out).toBe(
      "src/price.ts:1: export function formatPrice(cents: number, currency: string) {\nsrc/cart.ts:3: export const label = formatPrice('EUR', 100);",
    );
    await expect(
      call('find_references', { path: 'src/price.ts', line: 1, symbol: 'nothere' }),
    ).rejects.toThrow(/not on line 1/);
  });

  it('returns the enclosing symbol (heuristic fallback)', async () => {
    const out = await call('get_symbol', { path: 'src/price.ts', line: 2 });
    expect(out).toMatch(/^function formatPrice \(src\/price\.ts lines 1-3\):/);
    expect(out).toContain('     3  }');
  });
});
