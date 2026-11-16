import { describe, expect, it } from 'vitest';
import type { WorkspaceTools } from '../diff/types';
import type { AgentTool } from './loop';
import { createReviewTools, type ReviewToolsOptions } from './tools';

const FILES: Record<string, string> = {
  'src/price.ts':
    'export function formatPrice(cents: number, currency: string) {\n  return `${currency} ${(cents / 100).toFixed(2)}`;\n}\n',
  'src/cart.ts':
    "import { formatPrice } from './price';\nconst key = 'AKIAIOSFODNN7EXAMPLE';\nexport const label = formatPrice('EUR', 100);\n",
  '.env': 'TOKEN=secret',
  '.git/config': '[remote] url = https://token@github.com/x',
  'big.ts': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'),
  'src/keys.ts': [
    'export const before = 1;',
    'const pem = `',
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    'FAKEKEYBODYLINE0002abcdEFGH5678',
    'FAKEKEYBODYLINE0003ijklMNOP9012',
    '-----END PRIVATE KEY-----',
    '`;',
    'export function size() {',
    '  return pem.length;',
    '}',
    '',
  ].join('\n'),
};
const KEY_BODY = /MIIEvQ|FAKEKEYBODY/;

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

const toolsOn = (host: WorkspaceTools, options: ReviewToolsOptions = { maxLines: 50 }) => {
  const tools = new Map(createReviewTools(host, options).map((t) => [t.def.name, t]));
  return (name: string, input: unknown) => {
    const tool = tools.get(name)! as unknown as AgentTool<unknown>;
    return tool.run(tool.schema.parse(input), new AbortController().signal);
  };
};
const call = toolsOn(ws);

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

describe('read_file ranges', () => {
  it('numbers a range from the middle of a file with its real line numbers', async () => {
    expect(await call('read_file', { path: 'big.ts', startLine: 500, endLine: 502 })).toBe(
      'big.ts lines 500-502:\n   500  line 500\n   501  line 501\n   502  line 502\n… (1000 lines in total; ask for startLine 503+)',
    );
  });

  it('returns a whole short file without a "more" note', async () => {
    expect(await call('read_file', { path: 'src/price.ts' })).toBe(
      'src/price.ts lines 1-3:\n     1  export function formatPrice(cents: number, currency: string) {\n     2    return `${currency} ${(cents / 100).toFixed(2)}`;\n     3  }',
    );
  });

  it('caps a long range at maxLines', async () => {
    const out = await call('read_file', { path: 'big.ts', startLine: 100, endLine: 400 });
    expect(out).toMatch(/^big\.ts lines 100-149:\n {3}100 {2}line 100\n/);
    expect(out).not.toContain('line 150');
    expect(out).toContain('1000 lines in total; ask for startLine 150+');
  });

  it('clips a range that runs past the end of the file', async () => {
    const out = await call('read_file', { path: 'big.ts', startLine: 990, endLine: 2000 });
    expect(out).toMatch(/^big\.ts lines 990-1000:\n/);
    expect(out.endsWith('  1000  line 1000')).toBe(true);
  });

  it('says so when the range is past the end or reversed', async () => {
    expect(await call('read_file', { path: 'big.ts', startLine: 1001 })).toBe(
      'big.ts has 1000 line(s); nothing at 1001.',
    );
    await expect(call('read_file', { path: 'big.ts', startLine: 5, endLine: 4 })).rejects.toThrow(
      'endLine is before startLine.',
    );
  });
});

describe('search_code results', () => {
  it('lists hits as path:line: trimmed text', async () => {
    expect(await call('search_code', { pattern: 'formatPrice|toFixed' })).toBe(
      "src/price.ts:1: export function formatPrice(cents: number, currency: string) {\nsrc/price.ts:2: return `${currency} ${(cents / 100).toFixed(2)}`;\nsrc/cart.ts:1: import { formatPrice } from './price';\nsrc/cart.ts:3: export const label = formatPrice('EUR', 100);",
    );
    expect(await call('search_code', { pattern: 'nothing-like-this' })).toBe('No matches.');
  });

  it('caps the number of hits', async () => {
    const few = toolsOn(ws, { maxMatches: 3 });
    expect(await few('search_code', { pattern: '^line 1' })).toBe(
      'big.ts:1: line 1\nbig.ts:10: line 10\nbig.ts:11: line 11\n… more matches; narrow the pattern or glob.',
    );
  });

  it('redacts secrets in hit lines', async () => {
    expect(await call('search_code', { pattern: 'AKIA' })).toBe(
      "src/cart.ts:2: const key = '[REDACTED:aws-access-key]';",
    );
  });
});

describe('get_symbol results', () => {
  const classAt = (startLine: number, endLine: number): WorkspaceTools => ({
    ...ws,
    getSymbolAt: async () => ({ name: 'Big', kind: 'class', startLine, endLine }),
  });

  it('returns the whole symbol with real line numbers', async () => {
    expect(await call('get_symbol', { path: 'src/price.ts', line: 2 })).toBe(
      'function formatPrice (src/price.ts lines 1-3):\n     1  export function formatPrice(cents: number, currency: string) {\n     2    return `${currency} ${(cents / 100).toFixed(2)}`;\n     3  }',
    );
  });

  it('says so when no symbol contains the line', async () => {
    expect(await call('get_symbol', { path: 'big.ts', line: 5 })).toBe(
      'No enclosing function or class found at big.ts:5.',
    );
  });

  it("uses the host's symbol and caps a long one at maxLines", async () => {
    const out = await toolsOn(classAt(101, 300))('get_symbol', { path: 'big.ts', line: 120 });
    expect(out).toMatch(/^class Big \(big\.ts lines 101-300\):\n {3}101 {2}line 101\n/);
    expect(out).toContain('   150  line 150');
    expect(out).not.toContain('line 151');
    expect(out.endsWith('\n… (150 more lines)')).toBe(true);
  });

  it('redacts secrets in the symbol', async () => {
    const out = await toolsOn(classAt(1, 3))('get_symbol', { path: 'src/cart.ts', line: 2 });
    expect(out).toContain("     2  const key = '[REDACTED:aws-access-key]';");
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('find_references results', () => {
  it('redacts secrets in line text and counts what is left out', async () => {
    const host: WorkspaceTools = {
      ...ws,
      findReferences: async () => [
        { path: 'src/cart.ts', line: 2 },
        { path: 'src/cart.ts', line: 3 },
        { path: 'src/price.ts', line: 1 },
      ],
    };
    const input = { path: 'src/price.ts', line: 1, symbol: 'formatPrice' };
    expect(await toolsOn(host, { maxMatches: 2 })('find_references', input)).toBe(
      "src/cart.ts:2: const key = '[REDACTED:aws-access-key]';\nsrc/cart.ts:3: export const label = formatPrice('EUR', 100);\n… 1 more.",
    );
  });
});

describe('cancellation (F8)', () => {
  it("passes the loop's signal to the host and stops between files", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const reads: string[] = [];
    const cancelOn = new Set<string>();
    const host: WorkspaceTools = {
      ...ws,
      readFile: async (p, range, signal) => {
        seen.push(`readFile ${signal === controller.signal}`);
        reads.push(p);
        if (cancelOn.has(p)) controller.abort();
        return ws.readFile(p, range);
      },
      grep: async (pattern, glob, signal) => {
        seen.push(`grep ${signal === controller.signal}`);
        return ws.grep(pattern, glob);
      },
      findReferences: async (p, line, col, signal) => {
        seen.push(`findReferences ${signal === controller.signal}`);
        return ws.findReferences(p, line, col);
      },
    };
    const tools = new Map(createReviewTools(host).map((t) => [t.def.name, t]));
    const run = (name: string, input: unknown) => {
      const tool = tools.get(name)! as unknown as AgentTool<unknown>;
      return tool.run(tool.schema.parse(input), controller.signal);
    };
    await run('read_file', { path: 'src/price.ts' });
    await run('find_references', { path: 'src/price.ts', line: 1, symbol: 'formatPrice' });
    // Hits in three files: reading the second one cancels, so the third isn't read.
    reads.length = 0;
    cancelOn.add('src/cart.ts');
    await expect(run('search_code', { pattern: 'formatPrice|pem' })).rejects.toThrow();
    expect(reads).toEqual(['src/price.ts', 'src/cart.ts']);
    // Every host call got the loop's signal.
    expect(seen.filter((s) => s.endsWith('false'))).toEqual([]);
    expect(seen).toContain('grep true');
    expect(seen).toContain('findReferences true');
  });
});

// A key body line only looks like a secret after its BEGIN line, which a part of the file lacks.
describe('private key blocks in parts of a file', () => {
  it('read_file redacts a range that starts inside a key block', async () => {
    expect(await call('read_file', { path: 'src/keys.ts', startLine: 4, endLine: 6 })).toBe(
      'src/keys.ts lines 4-6:\n     4  [REDACTED:private-key]\n     5  [REDACTED:private-key]\n     6  [REDACTED:private-key]\n… (11 lines in total; ask for startLine 7+)',
    );
    // Lines after the block keep their text and numbers.
    expect(await call('read_file', { path: 'src/keys.ts', startLine: 6 })).toBe(
      'src/keys.ts lines 6-11:\n     6  [REDACTED:private-key]\n     7  -----END PRIVATE KEY-----\n     8  `;\n     9  export function size() {\n    10    return pem.length;\n    11  }',
    );
  });

  it('search_code redacts hits on key body lines', async () => {
    expect(await call('search_code', { pattern: 'MIIEvQ|FAKEKEYBODY|pem\\.length' })).toBe(
      'src/keys.ts:4: [REDACTED:private-key]\nsrc/keys.ts:5: [REDACTED:private-key]\nsrc/keys.ts:6: [REDACTED:private-key]\nsrc/keys.ts:10: return pem.length;',
    );
  });

  it('get_symbol redacts a symbol that starts inside a key block', async () => {
    const host: WorkspaceTools = {
      ...ws,
      getSymbolAt: async () => ({ name: 'pem', kind: 'variable', startLine: 5, endLine: 8 }),
    };
    expect(await toolsOn(host)('get_symbol', { path: 'src/keys.ts', line: 5 })).toBe(
      'variable pem (src/keys.ts lines 5-8):\n     5  [REDACTED:private-key]\n     6  [REDACTED:private-key]\n     7  -----END PRIVATE KEY-----\n     8  `;',
    );
  });

  it('find_references redacts references on key body lines', async () => {
    const host: WorkspaceTools = {
      ...ws,
      findReferences: async () => [
        { path: 'src/keys.ts', line: 5 },
        { path: 'src/keys.ts', line: 10 },
      ],
    };
    const input = { path: 'src/price.ts', line: 1, symbol: 'formatPrice' };
    expect(await toolsOn(host)('find_references', input)).toBe(
      'src/keys.ts:5: [REDACTED:private-key]\nsrc/keys.ts:10: return pem.length;',
    );
  });

  it('search_code hides a hit it cannot check against the file', async () => {
    const hidden = '[line not shown: it could not be checked for secrets]';
    // The host cut the file before the hit (as FsWorkspaceTools does with large files).
    const cut: WorkspaceTools = {
      ...ws,
      readFile: async (p) => (await ws.readFile(p)).split('\n').slice(0, 4).join('\n'),
    };
    expect(await toolsOn(cut)('search_code', { pattern: 'FAKEKEYBODY|pem\\.length' })).toBe(
      `src/keys.ts:5: ${hidden}\nsrc/keys.ts:6: ${hidden}\nsrc/keys.ts:10: ${hidden}`,
    );
    const unreadable: WorkspaceTools = {
      ...ws,
      readFile: async () => {
        throw new Error('gone');
      },
    };
    const out = await toolsOn(unreadable)('search_code', { pattern: 'FAKEKEYBODY' });
    expect(out).toBe(`src/keys.ts:5: ${hidden}\nsrc/keys.ts:6: ${hidden}`);
    expect(out).not.toMatch(KEY_BODY);
  });

  it('search_code reads each file with hits once and cuts long lines', async () => {
    const reads: string[] = [];
    const wide = `const wide = '${'x'.repeat(600)}';`;
    const host: WorkspaceTools = {
      ...ws,
      readFile: async (p, range) => {
        reads.push(p);
        return p === 'wide.ts' ? wide : ws.readFile(p, range);
      },
      grep: async (pattern) => [
        { path: 'wide.ts', line: 1, text: wide.slice(0, 500) },
        ...(await ws.grep(pattern)),
      ],
    };
    const out = await toolsOn(host)('search_code', { pattern: 'FAKEKEYBODY|formatPrice' });
    expect(out.split('\n')[0]).toBe(`wide.ts:1: ${wide.slice(0, 500)}`);
    expect(out.split('\n')).toHaveLength(6);
    expect(reads.sort()).toEqual(['src/cart.ts', 'src/keys.ts', 'src/price.ts', 'wide.ts']);
  });
});
