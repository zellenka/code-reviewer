import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, applyUserThresholds, parseConfig } from './index';

describe('parseConfig', () => {
  it('returns defaults for a missing or empty file', () => {
    expect(parseConfig(undefined)).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
    expect(parseConfig('  \n')).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
    expect(parseConfig('# only a comment\n').config).toEqual(DEFAULT_CONFIG);
  });

  it('defaults: style is off, minor/0.6 thresholds, changed lines only', () => {
    const { config } = parseConfig(undefined);
    expect(config.severityThreshold).toBe('minor');
    expect(config.confidenceThreshold).toBe(0.6);
    expect(config.onlyChangedLines).toBe(true);
    expect(config.review.categories).not.toContain('style');
    expect(config.review.mode).toBe('single-pass');
    expect(config.language).toBe('en');
  });

  it('reads every field', () => {
    const { config, warnings } = parseConfig(`
version: 1
severityThreshold: major
confidenceThreshold: 0.8
onlyChangedLines: false
ignore: ["**/*.generated.ts"]
rules: docs/rules.md
language: de
review:
  mode: agentic
  categories: [bug, style]
  verify: true
`);
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      version: 1,
      severityThreshold: 'major',
      confidenceThreshold: 0.8,
      onlyChangedLines: false,
      ignore: ['**/*.generated.ts'],
      rules: 'docs/rules.md',
      language: 'de',
      review: { mode: 'agentic', categories: ['bug', 'style'], verify: true },
    });
  });

  it('invalid YAML gives a warning and defaults, never a throw', () => {
    const result = parseConfig('severityThreshold: [major\n');
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings[0]).toMatch(/invalid YAML/);
  });

  it('a non-mapping top level gives a warning and defaults', () => {
    const result = parseConfig('- a\n- b\n');
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warnings).toHaveLength(1);
  });

  it('drops only the invalid fields and keeps the valid ones', () => {
    const result = parseConfig(`
severityThreshold: urgent
confidenceThreshold: 0.9
review:
  categories: [bug, typo]
colour: blue
`);
    expect(result.config.severityThreshold).toBe('minor');
    expect(result.config.confidenceThreshold).toBe(0.9);
    expect(result.config.review.categories).toEqual(DEFAULT_CONFIG.review.categories);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toMatch(/severityThreshold/);
    expect(result.warnings.join('\n')).toMatch(/colour/);
    expect(result.warnings.join('\n')).toMatch(/review\.categories/);
  });

  it('rejects an unsupported version', () => {
    const result = parseConfig('version: 2\nseverityThreshold: nit\n');
    expect(result.warnings[0]).toMatch(/version/);
    expect(result.config.severityThreshold).toBe('nit');
  });
});

describe('applyUserThresholds (precedence)', () => {
  const repo = parseConfig('severityThreshold: minor\nconfidenceThreshold: 0.7\n').config;

  it('a user setting can make thresholds stricter', () => {
    const config = applyUserThresholds(repo, {
      severityThreshold: 'major',
      confidenceThreshold: 0.9,
    });
    expect(config.severityThreshold).toBe('major');
    expect(config.confidenceThreshold).toBe(0.9);
  });

  it('a user setting can never make thresholds looser', () => {
    const config = applyUserThresholds(repo, {
      severityThreshold: 'nit',
      confidenceThreshold: 0.1,
    });
    expect(config.severityThreshold).toBe('minor');
    expect(config.confidenceThreshold).toBe(0.7);
  });

  it('ignores missing or junk user values and does not mutate the input', () => {
    const before = structuredClone(repo);
    expect(applyUserThresholds(repo, {})).toEqual(repo);
    expect(
      applyUserThresholds(repo, {
        severityThreshold: 'bogus' as never,
        confidenceThreshold: Number.NaN,
      }),
    ).toEqual(repo);
    expect(repo).toEqual(before);
  });
});
