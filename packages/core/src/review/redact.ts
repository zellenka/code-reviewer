import type { FileDiff } from '../diff/types';

/** Known credential formats. Always redacted before anything is sent to a provider. */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  {
    label: 'aws-secret-key',
    re: /(aws.{0,20}?(?:secret|key).{0,20}?[:=]\s*["'`]?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
  },
  { label: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { label: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { label: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'stripe-key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { label: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    label: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    label: 'connection-string-password',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)([^\s@"'`]{3,})(@)/gi,
  },
  {
    label: 'secret',
    // password = "hunter2xyz" — the name is kept so the model can still flag hard-coded secrets.
    re: /(\b[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w.-]*["']?\s*[:=]\s*["'`])(?!\[REDACTED)([^"'`\s]{8,})(["'`])/gi,
  },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

export const REDACTED_MARK = '[REDACTED';

export interface RedactOptions {
  /** Also redact long random-looking strings (may hide real code). Default false. */
  highEntropy?: boolean;
}

export interface Redactor {
  /** Redacts one line. `inKeyBlock` state is tracked across calls for PEM blocks. */
  line(text: string): string;
  count: number;
  reset(): void;
}

export function createRedactor(options: RedactOptions = {}): Redactor {
  let inKeyBlock = false;
  const redactor: Redactor = {
    count: 0,
    reset() {
      inKeyBlock = false;
    },
    line(text: string): string {
      if (inKeyBlock) {
        if (PRIVATE_KEY_END.test(text)) inKeyBlock = false;
        else if (text.trim()) {
          redactor.count++;
          return '[REDACTED:private-key]';
        }
        return text;
      }
      if (PRIVATE_KEY_BEGIN.test(text) && !PRIVATE_KEY_END.test(text)) inKeyBlock = true;

      let out = text;
      for (const { label, re } of PATTERNS) {
        re.lastIndex = 0;
        out = out.replace(re, (...m: string[]) => {
          redactor.count++;
          const groups = m.slice(1, -2).filter((g) => typeof g === 'string');
          // Patterns with capture groups keep the prefix (and suffix) and replace the value.
          if (groups.length >= 2) {
            return `${groups[0]}[REDACTED:${label}]${groups.length >= 3 ? groups[2] : ''}`;
          }
          return `[REDACTED:${label}]`;
        });
      }
      if (options.highEntropy) {
        out = out.replace(/[A-Za-z0-9+/=_-]{24,}/g, (token) => {
          if (token.includes(REDACTED_MARK) || !looksRandom(token)) return token;
          redactor.count++;
          return '[REDACTED:high-entropy]';
        });
      }
      return out;
    },
  };
  return redactor;
}

/** Redacts secrets in a whole text (line by line, so line numbers don't move). */
export function redactText(
  text: string,
  options: RedactOptions = {},
): { text: string; count: number } {
  const redactor = createRedactor(options);
  const out = text
    .split('\n')
    .map((l) => redactor.line(l))
    .join('\n');
  return { text: out, count: redactor.count };
}

/**
 * Returns copies of the files with secrets replaced in diff lines and `newContent`.
 * Lines are only changed in place, so line numbers stay valid.
 */
export function redactFiles(
  files: FileDiff[],
  options: RedactOptions = {},
): { files: FileDiff[]; count: number } {
  let count = 0;
  const out = files.map((file) => {
    // With the full file, new-side lines come from the redacted file, so a hunk that
    // starts inside a private key block is still redacted.
    const content =
      file.newContent !== undefined ? redactText(file.newContent, options).text : undefined;
    const contentLines = content?.split('\n');
    const redactor = createRedactor(options);
    const hunks = file.hunks.map((h) => {
      redactor.reset();
      return {
        ...h,
        lines: h.lines.map((l) => {
          const fromContent = l.newLine !== undefined ? contentLines?.[l.newLine - 1] : undefined;
          const text = redactor.line(l.text);
          if (
            fromContent !== undefined &&
            fromContent !== l.text &&
            fromContent.includes(REDACTED_MARK)
          ) {
            if (text === l.text) redactor.count++;
            return { ...l, text: fromContent };
          }
          return { ...l, text };
        }),
      };
    });
    count += redactor.count;
    const copy: FileDiff = { ...file, hunks };
    if (content !== undefined) copy.newContent = content;
    return copy;
  });
  return { files: out, count };
}

/** Shannon entropy per character + a mix of character classes. */
function looksRandom(token: string): boolean {
  if (/^[a-z_-]+$/i.test(token) || /^\d+$/.test(token)) return false;
  if (!/\d/.test(token) || !/[a-z]/.test(token) || !/[A-Z]/.test(token)) return false;
  const freq = new Map<string, number>();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 4;
}
