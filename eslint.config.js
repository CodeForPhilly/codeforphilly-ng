import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.vite/**',
      '**/coverage/**',
      '.claude/worktrees/**',
      // Skill source is upstream-managed (hash-pinned in skills-lock.json);
      // its scripts ship as CommonJS and aren't ours to relint.
      '.agents/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Paths the server answers before the SPA (specs/screens/chat.md →
      // "Linking to it from the app"): a router <Link> never reaches them and
      // renders the SPA's 404 page. Use a plain <a href> for these.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='to'] > Literal[value=/^\\/(chat|calendar)(\\/|\\?|$)|^\\/api\\//]",
          message: 'Server-handled path: use <a href>, not a router link (specs/screens/chat.md).',
        },
        {
          selector:
            "JSXAttribute[name.name='to'] > JSXExpressionContainer > TemplateLiteral > TemplateElement:first-child[value.raw=/^\\/(chat|calendar)(\\/|\\?|$)|^\\/api\\//]",
          message: 'Server-handled path: use <a href>, not a router link (specs/screens/chat.md).',
        },
      ],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
