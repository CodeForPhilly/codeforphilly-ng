import { cn } from '@/lib/utils';

interface MarkdownViewProps {
  /** Sanitized HTML from the API (e.g., overviewHtml, bioHtml). */
  html: string;
  className?: string;
}

// Pre-rendered, sanitized HTML from the server per
// specs/behaviors/markdown-rendering.md — no client-side markdown library.
export function MarkdownView({ html, className }: MarkdownViewProps) {
  if (!html) return null;
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none dark:prose-invert',
        '[&_a]:text-primary [&_a]:underline hover:[&_a]:no-underline',
        '[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2',
        '[&_h4]:text-base [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1.5',
        '[&_p]:mb-2 [&_p]:leading-relaxed',
        '[&_ul]:list-disc [&_ul]:ml-5 [&_ul]:mb-2',
        '[&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:mb-2',
        '[&_li]:mb-0.5',
        '[&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm',
        '[&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
        '[&_img]:rounded [&_img]:max-w-full',
        '[&_table]:border-collapse [&_table]:my-3',
        '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_th]:font-semibold',
        '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
