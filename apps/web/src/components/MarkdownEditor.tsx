import { useEffect, useId, useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/MarkdownView';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api';

interface MarkdownEditorProps {
  label?: string;
  description?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength?: number;
  minHeight?: number;
  error?: string;
  required?: boolean;
}

interface ToolbarButton {
  label: string;
  insert: string;
  wrap?: { before: string; after: string };
}

const TOOLBAR: ToolbarButton[] = [
  { label: 'B', insert: 'bold text', wrap: { before: '**', after: '**' } },
  { label: 'I', insert: 'italic text', wrap: { before: '_', after: '_' } },
  { label: 'Link', insert: 'link text', wrap: { before: '[', after: '](https://)' } },
  { label: 'List', insert: '- item' },
  { label: 'Code', insert: 'code', wrap: { before: '`', after: '`' } },
  { label: 'Quote', insert: '> quote' },
];

/**
 * Shared markdown editor used across authoring screens.
 *
 * Per specs/behaviors/markdown-rendering.md, preview is rendered server-side
 * via POST /api/_preview — there is intentionally no client-side markdown
 * parser bundled. We debounce the round-trip; the textarea remains responsive
 * because rendering happens asynchronously.
 */
export function MarkdownEditor({
  label,
  description,
  value,
  onChange,
  placeholder,
  maxLength,
  minHeight = 220,
  error,
  required,
}: MarkdownEditorProps) {
  const id = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = value.trim();
    if (!trimmed) {
      // No content → no async work. Stale state is cleared in render below.
      return;
    }
    const startTimer = setTimeout(() => {
      if (cancelled) return;
      // Mark loading right before the network call (not in effect body) — this
      // keeps the effect free of cascading setState per react-hooks rules.
      setPreviewLoading(true);
      api
        .preview(value)
        .then((res) => {
          if (cancelled) return;
          setPreviewHtml(res.data.html);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError) {
            setPreviewError(err.message);
          } else {
            setPreviewError('Preview unavailable');
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
  }, [value]);

  // Sync render-derived clears so an empty source shows the placeholder
  // without setState-in-effect.
  const trimmedValue = value.trim();
  if (!trimmedValue && previewHtml !== '') {
    setPreviewHtml('');
  }
  if (!trimmedValue && previewError !== null) {
    setPreviewError(null);
  }
  if (!trimmedValue && previewLoading) {
    setPreviewLoading(false);
  }

  const applyToolbar = (btn: ToolbarButton) => {
    const ta = textareaRef.current ?? (document.getElementById(id) as HTMLTextAreaElement | null);
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || btn.insert;
    let inserted: string;
    let cursorOffset: number;
    if (btn.wrap) {
      inserted = `${btn.wrap.before}${selected}${btn.wrap.after}`;
      cursorOffset = start + btn.wrap.before.length + selected.length + btn.wrap.after.length;
    } else {
      inserted = selected;
      cursorOffset = start + inserted.length;
    }
    const next = value.slice(0, start) + inserted + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(cursorOffset, cursorOffset);
    });
  };

  const count = value.length;
  const overSoftLimit = maxLength !== undefined && count > maxLength;

  return (
    <div className="space-y-1.5">
      {label && (
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
          {required && <span className="text-destructive ml-0.5">*</span>}
        </Label>
      )}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <div className="border border-border rounded-md overflow-hidden">
        <div className="flex flex-wrap gap-1 bg-muted/50 border-b border-border px-2 py-1.5">
          {TOOLBAR.map((btn) => (
            <Button
              key={btn.label}
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => applyToolbar(btn)}
            >
              {btn.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
          <Textarea
            ref={textareaRef}
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="rounded-none border-0 focus-visible:ring-0 font-mono text-sm resize-y"
            style={{ minHeight }}
            aria-invalid={error ? 'true' : 'false'}
          />
          <div
            className="p-3 bg-background text-sm overflow-auto"
            style={{ minHeight }}
            aria-live="polite"
          >
            {previewError ? (
              <p className="text-xs text-destructive">{previewError}</p>
            ) : previewHtml ? (
              <MarkdownView html={previewHtml} />
            ) : value.trim() ? (
              <p className="text-xs text-muted-foreground">
                {previewLoading ? 'Rendering preview…' : 'Preview will appear here.'}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground italic">Preview</p>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span className="text-muted-foreground">Markdown · supports GFM</span>
        )}
        <span
          className={cn(
            'tabular-nums',
            overSoftLimit ? 'text-destructive font-medium' : 'text-muted-foreground',
          )}
        >
          {count}
          {maxLength !== undefined && ` / ${maxLength}`}
        </span>
      </div>
    </div>
  );
}
