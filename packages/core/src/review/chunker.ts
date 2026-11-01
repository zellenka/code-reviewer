import type { FileDiff, Hunk } from '../diff/types';
import { estimateTokens } from '../provider/usage';

export interface ChunkFile {
  path: string;
  oldPath?: string;
  status: FileDiff['status'];
  hunks: Hunk[];
  /** Set when a large file was split: part `index` of `total` (1-based). */
  part?: { index: number; total: number };
}

export interface Chunk {
  index: number;
  files: ChunkFile[];
  /** Estimated tokens of the rendered chunk. */
  tokens: number;
}

/** Thrown when the diff would need more requests than allowed. Message is user-facing. */
export class ReviewTooLargeError extends Error {
  override readonly name = 'ReviewTooLargeError';
  constructor(
    readonly chunks: number,
    readonly limit: number,
  ) {
    super(
      `These changes are too large to review in one go (${chunks} parts, limit ${limit}). Narrow the scope: review staged changes, one file or a selection.`,
    );
  }
}

export interface ChunkOptions {
  /** Max estimated tokens for one rendered chunk. */
  maxTokens: number;
  /** Max number of chunks. Default 40. */
  maxChunks?: number;
  /** Token estimator. Default chars/3.5. */
  countTokens?: (text: string) => number;
}

/**
 * Renders one file for the prompt with explicit new-side line numbers:
 *
 *     <file path="src/a.ts" status="modified">
 *     @@ -10,3 +10,4 @@
 *        10   context
 *        11 + added
 *           - deleted
 *     </file>
 */
export function renderFile(file: ChunkFile): string {
  const attrs = [`path="${escapeAttr(file.path)}"`, `status="${file.status}"`];
  if (file.oldPath) attrs.push(`old_path="${escapeAttr(file.oldPath)}"`);
  if (file.part) attrs.push(`part="${file.part.index}/${file.part.total}"`);
  const out = [`<file ${attrs.join(' ')}>`];
  for (const hunk of file.hunks) out.push(renderHunk(hunk));
  out.push('</file>');
  return out.join('\n');
}

export function renderHunk(hunk: Hunk): string {
  const lines = [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`];
  for (const line of hunk.lines) {
    const num = line.newLine !== undefined ? String(line.newLine).padStart(6) : '      ';
    const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    lines.push(`${num} ${marker} ${line.text}`);
  }
  return lines.join('\n');
}

export function renderChunk(chunk: Chunk): string {
  return chunk.files.map(renderFile).join('\n\n');
}

/**
 * Splits files into chunks that each fit `maxTokens`:
 * small files are merged, large files split by hunk groups, and huge hunks by lines.
 * File order is kept so related files tend to land together.
 */
export function chunkFiles(files: FileDiff[], options: ChunkOptions): Chunk[] {
  const count = options.countTokens ?? estimateTokens;
  const maxChunks = options.maxChunks ?? 40;
  // Room for the <file> wrapper and separators.
  const limit = Math.max(200, options.maxTokens);

  const pieces: { file: ChunkFile; tokens: number }[] = [];
  for (const file of files) {
    const whole = toChunkFile(file, file.hunks);
    const tokens = count(renderFile(whole));
    if (tokens <= limit) {
      pieces.push({ file: whole, tokens });
      continue;
    }
    const parts = splitFile(file, limit, count);
    parts.forEach((hunks, i) => {
      const part = toChunkFile(file, hunks, { index: i + 1, total: parts.length });
      pieces.push({ file: part, tokens: count(renderFile(part)) });
    });
  }

  const chunks: Chunk[] = [];
  let current: Chunk | undefined;
  for (const piece of pieces) {
    if (!current || current.tokens + piece.tokens > limit) {
      current = { index: chunks.length, files: [], tokens: 0 };
      chunks.push(current);
    }
    current.files.push(piece.file);
    current.tokens += piece.tokens + 1;
  }
  if (chunks.length > maxChunks) throw new ReviewTooLargeError(chunks.length, maxChunks);
  return chunks;
}

function toChunkFile(file: FileDiff, hunks: Hunk[], part?: ChunkFile['part']): ChunkFile {
  const out: ChunkFile = { path: file.path, status: file.status, hunks };
  if (file.oldPath) out.oldPath = file.oldPath;
  if (part) out.part = part;
  return out;
}

/** Groups consecutive hunks into parts under `limit`; splits oversized hunks first. */
function splitFile(file: FileDiff, limit: number, count: (t: string) => number): Hunk[][] {
  const header = count(renderFile(toChunkFile(file, []))) + 8;
  const budget = Math.max(100, limit - header);
  const hunks = file.hunks.flatMap((h) =>
    count(renderHunk(h)) <= budget ? [h] : splitHunk(h, budget, count),
  );
  const parts: Hunk[][] = [];
  let current: Hunk[] = [];
  let used = 0;
  for (const hunk of hunks) {
    const tokens = count(renderHunk(hunk)) + 1;
    if (current.length && used + tokens > budget) {
      parts.push(current);
      current = [];
      used = 0;
    }
    current.push(hunk);
    used += tokens;
  }
  if (current.length) parts.push(current);
  return parts;
}

/** Cuts one hunk into line windows that fit `budget`, with correct start lines. */
function splitHunk(hunk: Hunk, budget: number, count: (t: string) => number): Hunk[] {
  const out: Hunk[] = [];
  let lines: Hunk['lines'] = [];
  let used = 0;
  const flush = () => {
    if (!lines.length) return;
    const firstOld = lines.find((l) => l.oldLine !== undefined)?.oldLine;
    const firstNew = lines.find((l) => l.newLine !== undefined)?.newLine;
    const oldCount = lines.filter((l) => l.kind !== 'add').length;
    const newCount = lines.filter((l) => l.kind !== 'del').length;
    out.push({
      oldStart: firstOld ?? hunk.oldStart,
      oldLines: oldCount,
      newStart: firstNew ?? hunk.newStart,
      newLines: newCount,
      lines,
    });
    lines = [];
    used = 0;
  };
  for (const line of hunk.lines) {
    // 6-digit number + marker + text; long lines are kept whole.
    const tokens = count(line.text) + 3;
    if (lines.length && used + tokens > budget) flush();
    lines.push(line);
    used += tokens;
  }
  flush();
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
