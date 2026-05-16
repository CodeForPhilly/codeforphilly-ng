/**
 * Shared serialization helpers used across entity serializers.
 */
import { renderMarkdown } from '@cfp/shared';
import type { Person, Tag } from '@cfp/shared/schemas';

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

/** Render markdown to HTML + an excerpt. Returns empty string for null/empty source. */
export function renderField(source: string | null | undefined): { html: string; excerpt: string } {
  if (!source) return { html: '', excerpt: '' };
  const { html, excerpt } = renderMarkdown(source);
  return { html, excerpt };
}

/** Truncate a plain-text string at a word boundary. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const breakAt = lastSpace > maxLength * 0.8 ? lastSpace : maxLength;
  return text.slice(0, breakAt) + '…';
}
