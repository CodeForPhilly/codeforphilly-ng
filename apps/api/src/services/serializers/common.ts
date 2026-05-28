/**
 * Shared serialization helpers used across entity serializers.
 */
import { renderMarkdown as rawRenderMarkdown, type RenderMarkdownResult } from '@cfp/shared';
import type { Person, Tag } from '@cfp/shared/schemas';

/**
 * Boot-installed renderer. Defaults to the bare `@cfp/shared` pipeline so
 * tests + dev code that import serializers directly without booting the
 * markdown plugin keep working. The markdown plugin
 * (`apps/api/src/plugins/markdown.ts`) calls `setRenderMarkdown` at boot
 * to swap in a renderer bound to `CFP_SITE_HOST` + the live
 * `inMemoryState.personIdBySlug` lookup, so all serializer output applies
 * the external-link + `@mention` transforms from
 * specs/behaviors/markdown-rendering.md.
 *
 * Module-level state is justified here over per-call threading: every
 * serializer currently routes through `renderMarkdown(source)` without
 * carrying an `app` or `FastifyInstance` reference, and a per-process
 * single binding matches the runtime's actual shape (one Fastify app,
 * one renderer config). Hot-reload preserves the state Maps in place so
 * the closure stays correct.
 */
let currentRender: (source: string) => RenderMarkdownResult = rawRenderMarkdown;

export function setRenderMarkdown(fn: (source: string) => RenderMarkdownResult): void {
  currentRender = fn;
}

/** Render a markdown source through the boot-installed renderer. */
export function renderMarkdown(source: string): RenderMarkdownResult {
  return currentRender(source);
}

/** PersonAvatar shape used in many nested contexts. */
export interface PersonAvatar {
  readonly slug: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
}

/** Tag shape used in nested contexts. */
export interface TagItem {
  readonly namespace: string;
  readonly slug: string;
  readonly title: string;
}

export function serializePersonAvatar(person: Person | undefined | null): PersonAvatar | null {
  if (!person) return null;
  return {
    slug: person.slug,
    fullName: person.fullName,
    avatarUrl: person.avatarKey ? `/api/attachments/${person.avatarKey}` : null,
  };
}

export function serializeTagItem(tag: Tag): TagItem {
  return {
    namespace: tag.namespace,
    slug: tag.slug,
    title: tag.title,
  };
}

/** Group tags by namespace. */
export function groupTagsByNamespace(
  tags: Tag[],
): { topic: TagItem[]; tech: TagItem[]; event: TagItem[] } {
  const topic: TagItem[] = [];
  const tech: TagItem[] = [];
  const event: TagItem[] = [];

  for (const tag of tags) {
    const item = serializeTagItem(tag);
    if (tag.namespace === 'topic') topic.push(item);
    else if (tag.namespace === 'tech') tech.push(item);
    else if (tag.namespace === 'event') event.push(item);
  }

  return { topic, tech, event };
}


/** Truncate a plain-text string at a word boundary. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const breakAt = lastSpace > maxLength * 0.8 ? lastSpace : maxLength;
  return text.slice(0, breakAt) + '…';
}
