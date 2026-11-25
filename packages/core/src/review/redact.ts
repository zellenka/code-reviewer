import type { FileDiff } from '../diff/types';

interface Pattern {
  label: string;
  re: RegExp;
  /**
   * Extra check on a match: the value, the kept prefix, the rest of the line after the match
   * and the line before it.
   */
  accept?: (value: string, prefix: string, after: string, before: string) => boolean;
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
  'none',
  'null',
  'nil',
  'true',
  'false',
  'empty',
  'todo',
  'tbd',
]);

/** Templates, variables, masks and placeholder words that stand in for a value. */
function isPlaceholderValue(value: string): boolean {
  return (
    /^(.)\1*$/.test(value) ||
    PLACEHOLDERS.has(value.toLowerCase()) ||
    /^(?:\$[{(\w]|#\{|[?%]|<.*>$|__\w+__$)/.test(value)
  );
}

/** Names of UI text about a credential (`passwordLabel`, `tokenHint`), not the credential. */
const LABEL_NAME =
  /(?:label|hint|placeholder|title|text|message|msg|prompt|caption|tooltip|description|error|help)["']?\s*(?:=>|[:=])\s*["'`]$/i;

/**
 * Tells a quoted value under a credential name from a label or a stand-in: placeholders,
 * templates and paths; the name itself (`"token": "token"`); one capitalised or upper-case
 * word or a word in another script (`"password": "Passwort"`, an i18n file); a string-literal
 * union type (`secret: 'hmac' | 'rsa'`); UI text under a label name.
 */
function isQuotedSecret(value: string, prefix: string, after: string, before: string): boolean {
  if (isPlaceholderValue(value) || value.startsWith('{')) return false;
  if (/^(?:[/~]|\.\.?[/\\]|[A-Za-z]:[/\\])/.test(value)) return false;
  if (/^(?:\p{Lu}[\p{Ll}\p{M}]*|\p{Lu}+|[\p{Lo}\p{M}]+)$/u.test(value)) return false;
  if (/^\s*\|/.test(after) || LABEL_NAME.test(prefix.slice(-64))) return false;
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const word = normalize(value);
  return !word || !normalize((before.slice(-64) + prefix).slice(-128)).endsWith(word);
}

/**
 * `isQuotedSecret` for a value that may hold spaces (XML text, a PHP constant): words of
 * letters only are text (`put your unique phrase here`), not a password. A Maven-encrypted
 * password (`{COQLCE6DU6GtcS5P=}`) is a secret: it is only as safe as `settings-security.xml`.
 */
function isSpacedSecret(value: string, prefix: string, after: string, before: string): boolean {
  const v = value.trim();
  if (!v || v.includes(REDACTED_MARK)) return false;
  if (/^\{(?=[^}]*[\d+/=])[A-Za-z0-9+/]{8,}={0,2}\}$/.test(v)) return true;
  if (/^[\p{L}\p{M}'’-]+(?:\s+[\p{L}\p{M}'’-]+)+[.!?:]?$/u.test(v)) return false;
  return isQuotedSecret(v, prefix, after, before);
}

/** The text of an XML element named after a credential; not after a self-closing tag. */
function isXmlElementSecret(value: string, prefix: string, after: string, before: string): boolean {
  return !prefix.endsWith('/>') && isSpacedSecret(value, prefix, after, before);
}

/** Words a credential's name has in it (`db_password`, `clientSecret`, `x-api-key`). */
const CREDENTIAL_KEY = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)`;
/**
 * The end of a name that names a credential (`DbPassword`, `client-secret`, `apiKey2`):
 * `tokenCount` or `passwordLabel` name something else. One digit per suffix step, so a name
 * matches in one way only (these run over untrusted lines and must stay linear).
 */
const CREDENTIAL_NAME_END = String.raw`${CREDENTIAL_KEY}(?:[_-]?(?:key|value|base|\d))*`;
/** `:`, `=` or `=>` (PHP, Ruby, Perl: `'password' => 'hunter2'`) between a name and its value. */
const ASSIGN = '(?:=>|[:=])';
/** A quote of any kind, and a character that is neither a quote nor a space. */
const QUOTE = '["\'`]';
const UNQUOTED = '[^"\'`\\s]';
/** WordPress's authentication keys and salts (`AUTH_KEY`, `SECURE_AUTH_SALT`, …). */
const WORDPRESS_KEY = String.raw`(?:SECURE_AUTH|AUTH|LOGGED_IN|NONCE)_(?:KEY|SALT)`;

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

/** Keys of ADO.NET, ODBC and JDBC connection strings that sit next to a password. */
const CONNECTION_STRING_KEY =
  /(?:^|[;&?"'`\s])(?:server|data source|host|address|addr|network address|user id|userid|uid|user|user name|username|database|initial catalog|dsn|driver|provider|port)\s*=/i;

/**
 * Tells `Password=…` / `Pwd=…` in a connection string (`Server=db;User Id=sa;Password=hunter2;`)
 * from code and templates. The pair must be `;`-separated and share the line with another
 * connection-string key; any literal value counts, however short, but templates, variables,
 * masks and placeholder words do not. Braces hold a format argument or an interpolated name
 * (`{0}`, `{password}`) unless they quote an ODBC value with punctuation (`{p@ss;w0rd}`).
 */
function isConnectionStringPassword(
  value: string,
  prefix: string,
  after: string,
  before: string,
): boolean {
  if (value.includes(REDACTED_MARK)) return false;
  if (value.startsWith('{')) {
    if (value.startsWith('{{') || !value.endsWith('}') || /^\{[\w.]*\}$/.test(value)) return false;
  } else if (isPlaceholderValue(value)) return false;
  // `Password = pwd` with spaces is how code assigns (`{ UserID = "sa", Password = pwd }`);
  // a literal written that way needs a digit or a symbol, like an unquoted secret.
  if (/\s/.test(prefix) && (/\s/.test(value) || /^[A-Za-z_]+$/.test(value))) return false;
  const near = before.slice(-200);
  if (!/[;&?]\s*$/.test(near) && !/^\s*[;&]/.test(after)) return false;
  return CONNECTION_STRING_KEY.test(near) || CONNECTION_STRING_KEY.test(after.slice(0, 200));
}

/** `Authorization: Basic …` holds base64 of `user:password`; English after "Basic" does not. */
function isBasicCredentials(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, 'base64').toString('latin1');
  const colon = decoded.indexOf(':');
  return colon > 0 && colon < decoded.length - 1 && /^[ -~]+$/.test(decoded);
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
  { label: 'slack-token', re: /\b(?:xox[abeoprs]|xapp-\d+)-[A-Za-z0-9-]{10,}/g },
  {
    label: 'slack-webhook',
    // https://hooks.slack.com/services/T…/B…/… — the host and kind stay, the path is the secret.
    re: /(\bhooks\.slack\.com\/(?:services|workflows|triggers)\/)([A-Za-z0-9_/-]{20,})/g,
  },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'stripe-key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { label: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
  // The 84-character format, with its fixed `AZDO` signature (the older 52-character one has none).
  { label: 'azure-devops-pat', re: /\b[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}\b/g },
  {
    label: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    label: 'connection-string-password',
    // scheme://user:password@host. Tried once per run of non-space, non-quote characters, and
    // only when that run ends in `@`; the scheme is checked backwards from `://`. Starting at
    // every scheme or `://` instead rescans the rest of a long line from each one.
    re: /(?<![^\s@"'`])(?=[^\s@"'`]*@)([^\s@"'`]*?:\/\/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@"'`]+:)([^\s@"'`]{3,})(@)/gi,
  },
  {
    label: 'connection-string-password',
    // Server=db;User Id=sa;Password=hunter2; — the value runs to `;`, a quote or the end of the
    // line and may hold spaces; an ODBC value may be quoted in braces (`PWD={p@ss;w0rd}`).
    re: /((?<![\w.$-])(?:password|pwd)\s*=\s*)(\{[^{}"'`\r\n]*\}|[^;"'`\s]+(?:[ \t]+[^;"'`\s]+)*)/gi,
    accept: isConnectionStringPassword,
  },
  {
    label: 'azure-key',
    // AccountKey=… in Azure Storage, SharedAccessKey=… in Service Bus / Event Hubs strings.
    re: /((?<![\w-])(?:AccountKey|SharedAccessKey)["']?\s*[:=]\s*["']?)([A-Za-z0-9+/]{20,}={0,2})/g,
    accept: (value) => /[\d+/]/.test(value),
  },
  {
    label: 'azure-sas-signature',
    // ?sv=…&sig=… — the other SAS parameters (version, expiry, permissions) are not secret.
    re: /([?&;]sig=)([A-Za-z0-9%+/=]{20,})/g,
    accept: (value) => /\d/.test(value),
  },
  {
    label: 'secret',
    // password = "hunter2xyz" — the name is kept so the model can still flag hard-coded secrets.
    // The name is any run of [\w.-] with a keyword in it (`db_password`, `passwordHash`). It is
    // matched from the start of the run only: starting at each keyword is quadratic on long runs.
    re: new RegExp(
      String.raw`((?<![\w.-])(?=[\w.-]*?${CREDENTIAL_KEY})[\w.-]+["']?\s*${ASSIGN}\s*${QUOTE})(?!\[REDACTED)(${UNQUOTED}{8,})(${QUOTE})`,
      'gi',
    ),
    accept: isQuotedSecret,
  },
  {
    label: 'secret',
    // "Password": "hunter2" — a name that ends with the keyword (as for unquoted secrets below)
    // makes a shorter quoted value a secret too; `passwordHint = "short"` keeps the 8 above.
    re: new RegExp(
      String.raw`(${CREDENTIAL_NAME_END}["']?\s*${ASSIGN}\s*${QUOTE})(?!\[REDACTED)(${UNQUOTED}{4,7})(${QUOTE})`,
      'gi',
    ),
    accept: isQuotedSecret,
  },
  {
    label: 'secret',
    // <password>hunter2</password>, <client-secret>…</client-secret> (Maven, Spring, SOAP) on
    // one line. The text may hold spaces; it can't hold `<` or `>`, so each `<` is tried once.
    re: new RegExp(
      String.raw`(<[\w.:-]*?${CREDENTIAL_NAME_END}(?:\s[^<>]*)?>)(?!\[REDACTED)([^<>\r\n]{4,})(<\/[\w.:-]+\s*>)`,
      'gi',
    ),
    accept: isXmlElementSecret,
  },
  {
    label: 'secret',
    // <add key="DbPassword" value="hunter2" /> (.NET appSettings), <property name="password"
    // value="…"/> (Spring): the key or name attribute names the credential, `value` holds it.
    re: new RegExp(
      String.raw`((?<![\w.:-])(?:key|name)\s*=\s*["'][\w.:-]*?${CREDENTIAL_NAME_END}["']\s+value\s*=\s*["'])(?!\[REDACTED)([^"'\r\n]{4,})(["'])`,
      'gi',
    ),
    accept: isSpacedSecret,
  },
  {
    label: 'secret',
    // define('DB_PASSWORD', 'hunter2'), and WordPress's keys and salts, which may hold spaces.
    re: new RegExp(
      String.raw`(\bdefine\s*\(\s*["'](?:[\w.:-]*?${CREDENTIAL_NAME_END}|${WORDPRESS_KEY})["']\s*,\s*["'])(?!\[REDACTED)([^"'\r\n]{4,})(["'])`,
      'gi',
    ),
    accept: isSpacedSecret,
  },
  {
    label: 'bearer-token',
    // Authorization: Bearer abc123… — a literal token has a digit; `Bearer ${token}` does not match.
    re: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{20,})/gi,
    accept: (value) => /\d/.test(value),
  },
  {
    label: 'basic-auth',
    // Authorization: Basic dXNlcjpwYXNz — only a value that decodes to `user:password`.
    re: /(\bBasic\s+)([A-Za-z0-9+/]{8,}={0,2})/gi,
    accept: isBasicCredentials,
  },
  {
    label: 'secret',
    // password: hunter2hunter2, DB_PASSWORD=plainsecretvalue — no quotes; the value runs to
    // whitespace. The name must end with the keyword (`tokenCount`, `secretName` are not secrets).
    // Written to match in one way only (no name prefix, one digit per suffix step, no lookahead):
    // this runs over untrusted lines and must stay linear. The value's end is checked in `accept`.
    re: new RegExp(String.raw`(${CREDENTIAL_NAME_END}["']?\s*[:=]\s*)(${UNQUOTED}{8,})`, 'gi'),
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
  /** After a private key's BEGIN marker, before its END. */
  readonly inKeyBlock: boolean;
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
    get inKeyBlock() {
      return inKeyBlock;
    },
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
            const line = m.at(-1) as string;
            const offset = m.at(-2) as number;
            const after = line.slice(offset + match.length);
            if (!accept(groups[1]!, groups[0]!, after, line.slice(0, offset))) return match;
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
 * The known secret formats redacted in text that may hold many files (a whole prompt part).
 * Like `redactText` without the high-entropy heuristic, except that a private key block is
 * only redacted up to an END marker: a BEGIN marker with none after it (a string literal in
 * code) would hide everything that follows. Text redacted already passes unchanged.
 */
export function redactPromptText(text: string): string {
  const lines = text.split('\n');
  let lastEnd = lines.length - 1;
  while (lastEnd >= 0 && !PRIVATE_KEY_END.test(lines[lastEnd]!)) lastEnd--;
  const redactor = createRedactor();
  return lines
    .map((l, i) => {
      const out = redactor.line(l);
      // A key block opened here can't end.
      if (i >= lastEnd && redactor.inKeyBlock) redactor.reset();
      return out;
    })
    .join('\n');
}

/**
 * Returns copies of the files with secrets replaced in diff lines and `newContent`.
 * Lines are only changed in place, so line numbers stay valid. Each hunk is redacted on
 * its own: `hunkCounts[file][hunk]` is what it adds to `count`.
 */
export function redactFiles(
  files: FileDiff[],
  options: RedactOptions = {},
): { files: FileDiff[]; count: number; hunkCounts: number[][] } {
  let count = 0;
  const hunkCounts: number[][] = [];
  const out = files.map((file) => {
    // With the full file, new-side lines come from the redacted file, so a hunk that
    // starts inside a private key block is still redacted.
    const content =
      file.newContent !== undefined ? redactText(file.newContent, options).text : undefined;
    const contentLines = content?.split('\n');
    const redactor = createRedactor(options);
    const counts: number[] = [];
    hunkCounts.push(counts);
    const hunks = file.hunks.map((h) => {
      redactor.reset();
      const before = redactor.count;
      const hunk = {
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
      counts.push(redactor.count - before);
      return hunk;
    });
    count += redactor.count;
    const copy: FileDiff = { ...file, hunks };
    if (content !== undefined) copy.newContent = content;
    return copy;
  });
  return { files: out, count, hunkCounts };
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
