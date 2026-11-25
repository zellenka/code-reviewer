import picomatch from 'picomatch';
import type { ReviewConfig } from '../config/schema';
import type { FileDiff } from '../diff/types';
import type { SkipReason, SkippedFile } from './types';

/**
 * Files that never reach the provider. `secret` rules can't be undone by config;
 * the others are noise (not worth tokens).
 */
const BUILT_IN: { reason: SkipReason; globs: string[] }[] = [
  {
    reason: 'secret',
    globs: [
      '.env',
      '.env.*',
      '*.env',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      '*.jks',
      '*.keystore',
      'id_rsa*',
      'id_dsa*',
      'id_ecdsa*',
      'id_ed25519*',
      '.npmrc',
      '.pypirc',
      '.netrc',
      '_netrc',
      '.git-credentials',
      '.pgpass',
      '.htpasswd',
      '*.ovpn',
      // Apple's App Store Connect and push keys (AuthKey_*.p8).
      '*.p8',
      // Cloud and cluster credentials.
      'credentials.json',
      'application_default_credentials.json',
      'service-account*.json',
      'serviceAccountKey.json',
      '*.publishsettings',
      '**/.aws/credentials',
      '**/.aws/config',
      '**/.kube/config',
      'kubeconfig',
      'kubeconfig.yaml',
      'kubeconfig.yml',
      '*.kubeconfig',
      '**/.docker/config.json',
      '.dockercfg',
      // Terraform: variable values and state hold the secrets a configuration is given.
      '*.tfvars',
      '*.tfvars.json',
      '*.tfstate',
      '*.tfstate.*',
      'credentials.tfrc.json',
      // App settings with real values. `appsettings.json` is reviewed: it is mostly ordinary
      // config, and its connection-string passwords and credential-keyed values are redacted.
      // A `settings.xml` outside `.m2/` is reviewed too: Android and IDEs use the name.
      'appsettings.*.json',
      'local.settings.json',
      'secrets.json',
      'secrets.yaml',
      'secrets.yml',
      'secrets.toml',
      'wp-config.php',
      '**/.m2/settings.xml',
      'settings-security.xml',
    ],
  },
  {
    reason: 'lockfile',
    globs: [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'bun.lock',
      'Cargo.lock',
      'Gemfile.lock',
      'composer.lock',
      'poetry.lock',
      'Pipfile.lock',
      'uv.lock',
      'go.sum',
      'flake.lock',
      'packages.lock.json',
      'Podfile.lock',
      'pubspec.lock',
      'mix.lock',
    ],
  },
  {
    reason: 'buildOutput',
    globs: [
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.next/**',
      '**/__pycache__/**',
      '*.pyc',
      '*.tsbuildinfo',
    ],
  },
  { reason: 'minified', globs: ['*.min.js', '*.min.mjs', '*.min.css', '*.map'] },
  { reason: 'snapshot', globs: ['**/__snapshots__/**', '*.snap'] },
];

/**
 * Generated and vendored code by convention, reviewed unless the repository's `ignore:`
 * skips it. With the built-in noise above and files whose header says they are generated,
 * these are the only files `ignore:` may skip (A2): leaving them out only keeps reviews
 * quiet, while the repository can't hide its own source from a review.
 */
const GENERATED_OR_VENDORED = [
  '**/vendor/**',
  '**/generated/**',
  '**/__generated__/**',
  '*.generated.*',
  '*.pb.go',
  '*.pb.cc',
  '*.pb.h',
  '*_pb2.py',
  '*_pb2_grpc.py',
];

/**
 * gitignore-like matching: a pattern without `/` matches the file name at any depth,
 * a trailing `/` means "everything in this directory".
 */
export function compileGlobs(globs: string[], nocase = false): (path: string) => boolean {
  const patterns = globs.map((g) => {
    const dir = g.endsWith('/') ? `${g}**` : g;
    return dir.includes('/') ? dir.replace(/^\//, '') : `**/${dir}`;
  });
  return picomatch(patterns, { dot: true, nocase });
}

const builtInMatchers = BUILT_IN.map(({ reason, globs }) => ({
  reason,
  // Secrets are matched case-insensitively (`.ENV`, `KEY.PEM`).
  match: compileGlobs(globs, reason === 'secret'),
}));

const generatedOrVendoredPath = compileGlobs([
  ...BUILT_IN.filter((b) => b.reason !== 'secret').flatMap((b) => b.globs),
  ...GENERATED_OR_VENDORED,
]);

/**
 * The file Windows opens for `path` (with `/`): `.` and `..` steps resolved, and in each name
 * an alternate data stream (`.env::$DATA`) and trailing dots and spaces (`.env.`) dropped.
 * Short names (`GIT~1`) are left to the host, which gives core the real path of a file.
 */
function openedPath(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    const name = part.replace(/:.*$/, '').replace(/[. ]+$/, '');
    if (part === '..') out.pop();
    else if (name) out.push(name);
  }
  return out.join('/');
}

/**
 * True for files that must never be sent, whatever the config says. Also checks the name
 * Windows opens the path by (`src/../.env`, `.env.`, `server.key::$DATA`).
 */
export function isSecretPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return builtInMatchers[0]!.match(p) || builtInMatchers[0]!.match(openedPath(p));
}

/**
 * Secret files and anything in `.git/`: never readable by the model, whatever the path. The
 * one check of what may be sent: the diff filter, the agent tools and the rules loader use it.
 */
export function isProtectedPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return isSecretPath(p) || [p, openedPath(p)].some((s) => /(^|\/)\.git(\/|$)/i.test(s));
}

/** `@generated` / "Code generated … DO NOT EDIT." near the top of the file. */
const GENERATED_RE = /@generated\b|^\W*Code generated .* DO NOT EDIT\.?$|<auto-generated/m;
/** Lines this long mean minified or machine-written content. */
const MINIFIED_LINE_LENGTH = 3000;

/**
 * A generated, vendored or lock file: by path (build output, minified files, snapshots,
 * `vendor/`, `generated/`, `*.pb.go`, …) or, for a file of the diff, by a generated-code
 * header. The only kind of file the repository's `ignore:` may skip (A2).
 */
export function isGeneratedOrVendored(file: string | FileDiff): boolean {
  const path = (typeof file === 'string' ? file : file.path).replace(/\\/g, '/');
  return generatedOrVendoredPath(path) || (typeof file !== 'string' && isGenerated(file));
}

/** The repository's `ignore:` and whether it may skip any file (`ReviewConfig`). */
export type RepoIgnore = Pick<ReviewConfig, 'ignore' | 'ignoreAnyFile'>;

/**
 * Paths the repository's `ignore:` hides from the agent tools, as from the diff: generated
 * and vendored ones (by path), others only with `ignoreAnyFile`. Undefined when none.
 */
export function repoIgnoreBlocks(config: RepoIgnore): ((path: string) => boolean) | undefined {
  if (!config.ignore.length) return undefined;
  const match = compileGlobs(config.ignore);
  return (path) => match(path) && (!!config.ignoreAnyFile || isGeneratedOrVendored(path));
}

/** A file `ignore:` matched although it isn't generated, vendored or a lock file. */
export interface RelaxedIgnore {
  path: string;
  /** The first pattern of `ignore:` that matched it. */
  pattern: string;
}

export interface FilterResult {
  files: FileDiff[];
  skipped: SkippedFile[];
  /**
   * Files that would be reviewed but for the repository's `ignore:`, and aren't generated,
   * vendored or lock files: skipped with `ignoreAnyFile`, else reviewed (A2). Either way
   * the review says so (`reviewSettingsWarnings`).
   */
  relaxedIgnore: RelaxedIgnore[];
}

/**
 * Splits a diff into files to review and files to skip (with the reason). `ignore` globs
 * come from `.codereview.yml` (a trailing `/` means "this directory"); they skip generated,
 * vendored and lock files, and other files only with `ignoreAnyFile` (A2).
 */
export function filterFiles(files: FileDiff[], config: RepoIgnore = { ignore: [] }): FilterResult {
  const patterns = config.ignore.map((g) => ({ pattern: g, match: compileGlobs([g]) }));
  const kept: FileDiff[] = [];
  const skipped: SkippedFile[] = [];
  const relaxedIgnore: RelaxedIgnore[] = [];

  for (const file of files) {
    const pattern = patterns.find((p) => p.match(file.path))?.pattern;
    let ignored = false;
    if (pattern !== undefined) {
      const permitted = isGeneratedOrVendored(file);
      ignored = permitted || !!config.ignoreAnyFile;
      if (!permitted && !skipReason(file, false)) relaxedIgnore.push({ path: file.path, pattern });
    }
    const reason = skipReason(file, ignored);
    if (reason) skipped.push({ path: file.path, reason });
    else kept.push(file);
  }
  return { files: kept, skipped, relaxedIgnore };
}

function skipReason(file: FileDiff, ignored: boolean): SkipReason | undefined {
  // Secrets first, so a deleted .env isn't even listed as "deleted".
  if (isSecretPath(file.path) || (file.oldPath && isSecretPath(file.oldPath))) return 'secret';
  if (file.status === 'deleted') return 'deleted';
  if (file.unmerged) return 'unmerged';
  if (file.binary) return 'binary';
  for (const { reason, match } of builtInMatchers.slice(1)) {
    if (match(file.path)) return reason;
  }
  if (ignored) return 'configIgnore';
  // Pure deletions are kept: removing a guard can be a bug worth reporting.
  if (!file.hunks.some((h) => h.lines.some((l) => l.kind !== 'ctx'))) return 'noChanges';
  if (isGenerated(file)) return 'generated';
  if (file.hunks.some((h) => h.lines.some((l) => l.text.length > MINIFIED_LINE_LENGTH))) {
    return 'minified';
  }
  return undefined;
}

function isGenerated(file: FileDiff): boolean {
  const head =
    file.newContent !== undefined
      ? file.newContent.split('\n', 10).join('\n')
      : (file.hunks[0]?.newStart ?? 99) <= 10
        ? file.hunks[0]!.lines.filter((l) => l.kind !== 'del' && (l.newLine ?? 99) <= 10)
            .map((l) => l.text)
            .join('\n')
        : '';
  return GENERATED_RE.test(head);
}
