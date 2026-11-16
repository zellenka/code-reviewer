import type { FileDiff } from '../diff/types';

interface Pattern {
  label: string;
  re: RegExp;
  /** Extra check on a match: the value, the kept prefix and the rest of the line after the match. */
  accept?: (value: string, prefix: string, after: string) => boolean;
}

/** Values that stand for "no secret here" in config files and docs. */
const PLACEHOLDERS = new Set([
  'changeme',
  'changeit',
  'password',
  'passwd',
  'secret',
  'apikey',
  'accesskey',
  'privatekey',
  'username',
  'undefined',
  'redacted',
  'required',
  'optional',
  'disabled',
  'placeholder',
]);

/**
 * Tells an unquoted literal (`password: hunter2hunter2`, `DB_PASSWORD=plainsecretvalue`) from
 * code (`password = getPassword()`, `token: Uint8Array`). Without quotes nothing marks a
 * literal, so this prefers missing a weak, word-like value to hiding code.
 */
function looksLikeUnquotedSecret(value: string, prefix: string, after: string): boolean {
  // The value must run to whitespace or the end of the line (not stop at a quote).
  if (after && !/^\s/.test(after)) return false;
  // Calls, member access, templates, placeholders, lists, variable references, paths, operators.
  if (/[(){}[\]<>,;.|\\]/.test(value) || /^[$/~@#%&*!+=:?-]/.test(value)) return false;
  if (/==|!=|=>|->|&&|::|:\/\//.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || /^(.)\1+$/.test(value)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    // Shaped like an identifier. Digits in two places (`hunter2hunter2`, hex, random tokens)
    // are rare in names; `Uint8Array`, `base64url` or `password1` have one.
    if ((value.match(/\d+/g) ?? []).length >= 2) return true;
    // KEY=value with no spaces and nothing after it is the .env / properties form. Only a
    // plain lower-case value counts there: `password=userPassword` is a keyword argument.
    return (
      /\S=$/.test(prefix) && !after.trim() && /^[a-z0-9]+$/.test(value) && !PLACEHOLDERS.has(value)
    );
  }
  // Has punctuation that is not code: `S3cr3t!Pass`, `Xk9#mP2$vL8qR4`.
  return /\d/.test(value);
}

/** Known credential formats. Always redacted before anything is sent to a provider. */
const PATTERNS: Pattern[] = [
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
    re: /((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w.-]*["']?\s*[:=]\s*["'`])(?!\[REDACTED)([^"'`\s]{8,})(["'`])/gi,
  },
  {
    label: 'bearer-token',
    // Authorization: Bearer abc123… — a literal token has a digit; `Bearer ${token}` does not match.
    re: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi,
    accept: (value) => /\d/.test(value),
  },
  {
    label: 'secret',
    // password: hunter2hunter2, DB_PASSWORD=plainsecretvalue — no quotes; the value runs to
    // whitespace. The name must end with the keyword (`tokenCount`, `secretName` are not secrets).
    // Written to match in one way only (no name prefix, one digit per suffix step, no lookahead):
    // this runs over untrusted lines and must stay linear. The value's end is checked in `accept`.
    re: /((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)(?:[_-]?(?:key|value|base|\d))*["']?\s*[:=]\s*)([^"'`\s]{8,})/gi,
    accept: looksLikeUnquotedSecret,
  },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/;

/** Quotes, `\n` escapes and punctuation next to a marker are not key material. */
const hasKeyMaterial = (s: string): boolean => /[A-Za-z0-9]/.test(s.replace(/\\[nrt]/g, ''));

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
  /**
   * Replaces key material that shares a line with a BEGIN/END marker (one-line keys,
   * `"private_key": "-----BEGIN ...\n...\n-----END ...\n"`). Markers and outside text stay.
   */
  const keyMarkerLine = (text: string): string => {
    let out = '';
    let rest = text;
    for (;;) {
      const marker = (inKeyBlock ? PRIVATE_KEY_END : PRIVATE_KEY_BEGIN).exec(rest);
      const before = marker ? rest.slice(0, marker.index) : rest;
      if (inKeyBlock && hasKeyMaterial(before)) {
        redactor.count++;
        out += '[REDACTED:private-key]';
      } else out += before;
      if (!marker) return out;
      out += marker[0];
      rest = rest.slice(marker.index + marker[0].length);
      inKeyBlock = !inKeyBlock;
    }
  };
  const redactor: Redactor = {
    count: 0,
    reset() {
      inKeyBlock = false;
    },
    line(text: string): string {
      if (inKeyBlock && !PRIVATE_KEY_END.test(text)) {
        if (!text.trim()) return text;
        redactor.count++;
        return '[REDACTED:private-key]';
      }

      let out = keyMarkerLine(text);
      for (const { label, re, accept } of PATTERNS) {
        re.lastIndex = 0;
        out = out.replace(re, (...m: (string | number)[]) => {
          const match = m[0] as string;
          const groups = m.slice(1, -2).filter((g) => typeof g === 'string');
          if (accept) {
            const after = (m.at(-1) as string).slice((m.at(-2) as number) + match.length);
            if (!accept(groups[1]!, groups[0]!, after)) return match;
          }
          redactor.count++;
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
