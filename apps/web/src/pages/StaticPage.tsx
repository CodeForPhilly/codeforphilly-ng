/**
 * Static content pages — `/pages/:slug`.
 *
 * Content lives in `apps/web/src/content/pages/*.md` and is loaded as
 * raw text at build time via Vite's `import.meta.glob`. We use `marked`
 * to parse the markdown source on render. This is safe to do client-
 * side because the content is bundle-time-static — it can't be
 * influenced by users.
 *
 * Per specs/behaviors/app-shell.md → "The /pages/* URLs serve static
 * content pages authored as MDX/Markdown in the code repo".
 */
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { marked } from 'marked';
import { NotFound } from '@/pages/NotFound';
import { cn } from '@/lib/utils';

// Eagerly load all .md files in the content/pages directory as raw text.
// Vite turns this into a slug→source map at build time.
const RAW_PAGES = import.meta.glob('../content/pages/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Strip the directory + extension so the map is keyed by slug only.
const PAGES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW_PAGES).map(([path, source]) => {
    const match = /\/([^/]+)\.md$/.exec(path);
    return [match?.[1] ?? path, source];
  }),
);

// Marked config: GFM features (tables, autolinks) on; no breaks-on-newline
// because the content is hand-authored markdown, not chat input.
marked.setOptions({ gfm: true, breaks: false });

export function StaticPage() {
  const { slug } = useParams<{ slug: string }>();
  const source = slug ? PAGES[slug] : undefined;

  const html = useMemo(() => {
    if (!source) return null;
    // marked.parse() returns string | Promise<string>. With async: false
    // (the default in v18+ for synchronous extensions), it's a string.
    return marked.parse(source, { async: false }) as string;
  }, [source]);

  if (!source || html === null) return <NotFound />;

  return (
    <article className="container mx-auto px-4 py-8 max-w-3xl">
      <div
        className={cn(
          'prose prose-sm max-w-none dark:prose-invert sm:prose-base',
          '[&_a]:text-primary [&_a]:underline hover:[&_a]:no-underline',
          '[&_h1]:text-3xl [&_h1]:font-bold [&_h1]:mb-6',
          '[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3',
          '[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2',
          '[&_p]:mb-4 [&_p]:leading-relaxed',
          '[&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-4',
          '[&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-4',
          '[&_li]:mb-1',
          '[&_hr]:my-8 [&_hr]:border-border',
          '[&_em]:italic',
          '[&_strong]:font-semibold',
          '[&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm',
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}
