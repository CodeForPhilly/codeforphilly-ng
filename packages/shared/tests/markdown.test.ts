import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../src/markdown.js';

describe('renderMarkdown', () => {
  describe('basic rendering', () => {
    it('renders a heading and link to HTML', () => {
      const { html } = renderMarkdown('# Hello\n[link](https://x.org)');
      // h1 is demoted to h3
      expect(html).toContain('<h3>');
      expect(html).toContain('<a href="https://x.org">link</a>');
    });

    it('produces a plain-text excerpt', () => {
      const { excerpt } = renderMarkdown('# Hello\n[link](https://x.org)');
      expect(excerpt).not.toContain('<');
      expect(excerpt).not.toContain('(');
    });

    it('returns both html and excerpt', () => {
      const result = renderMarkdown('Hello **world**');
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('excerpt');
      expect(result.html).toContain('<strong>world</strong>');
      expect(result.excerpt).toBe('Hello world');
    });
  });

  describe('heading demotion', () => {
    it('demotes h1 to h3', () => {
      const { html } = renderMarkdown('# Top level');
      expect(html).toContain('<h3>');
      expect(html).not.toContain('<h1>');
    });

    it('demotes h2 to h4', () => {
      const { html } = renderMarkdown('## Second level');
      expect(html).toContain('<h4>');
      expect(html).not.toContain('<h2>');
    });

    it('caps demotion at h6', () => {
      const { html } = renderMarkdown('##### Level 5');
      // h5 + 2 = h7, but capped at h6
      expect(html).toContain('<h6>');
    });
  });

  describe('sanitization — script/XSS', () => {
    it('strips <script> tags entirely', () => {
      const { html } = renderMarkdown('<script>alert("xss")</script>');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });

    it('strips javascript: URLs from links', () => {
      const { html } = renderMarkdown('[click me](javascript:alert(1))');
      expect(html).not.toContain('javascript:');
    });

    it('strips on* event attributes from raw HTML', () => {
      const { html } = renderMarkdown('<a href="https://x.org" onclick="alert(1)">link</a>');
      expect(html).not.toContain('onclick');
    });

    it('strips raw HTML <style> blocks', () => {
      const { html } = renderMarkdown('<style>body{display:none}</style>');
      expect(html).not.toContain('<style>');
      expect(html).not.toContain('display:none');
    });

    it('strips <iframe> raw HTML', () => {
      const { html } = renderMarkdown('<iframe src="https://evil.com"></iframe>');
      expect(html).not.toContain('<iframe>');
      expect(html).not.toContain('evil.com');
    });
  });

  describe('allowed content', () => {
    it('renders GFM tables', () => {
      const { html } = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |');
      expect(html).toContain('<table>');
      expect(html).toContain('<td>');
    });

    it('renders fenced code blocks', () => {
      const { html } = renderMarkdown('```js\nconsole.log("hi")\n```');
      expect(html).toContain('<code');
      expect(html).toContain('console.log');
    });

    it('renders blockquotes', () => {
      const { html } = renderMarkdown('> Quoted text');
      expect(html).toContain('<blockquote>');
    });

    it('allows https image URLs', () => {
      const { html } = renderMarkdown('![alt](https://example.com/img.png)');
      expect(html).toContain('src="https://example.com/img.png"');
      expect(html).toContain('loading="lazy"');
    });

    it('strips non-https image src', () => {
      const { html } = renderMarkdown('![alt](http://example.com/img.png)');
      // Should not render the image with http src — sanitizer strips non-https
      expect(html).not.toContain('src="http://');
    });
  });

  describe('excerpt truncation', () => {
    it('does not truncate short text', () => {
      const { excerpt } = renderMarkdown('Hello world.');
      expect(excerpt).toBe('Hello world.');
      expect(excerpt).not.toContain('…');
    });

    it('truncates long text with ellipsis at word boundary', () => {
      const long = 'word '.repeat(100).trim();
      const { excerpt } = renderMarkdown(long);
      expect(excerpt.endsWith('…')).toBe(true);
      expect(excerpt.length).toBeLessThanOrEqual(282); // 280 + '…' character
    });

    it('strips markdown formatting from excerpt', () => {
      const { excerpt } = renderMarkdown('**bold** and _italic_');
      expect(excerpt).not.toContain('**');
      expect(excerpt).not.toContain('_');
    });
  });
});
