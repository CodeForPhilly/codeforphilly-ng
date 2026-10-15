/**
 * Rename helpers — specs/behaviors/slug-handles.md: a rename changes the
 * handle and nothing else about the entity, so the record's attachments
 * move with it and any key or link pointing under its old path is
 * rewritten.
 *
 * The move itself is gitsheets' rename-on-upsert (≥ 2.8): upserting a
 * record annotated with its *current* path, when its fields now render a
 * different path, moves the record file and its attachment folder in one
 * step.
 */
import { RECORD_PATH_KEY } from 'gitsheets';

interface MovableSheet<T, O> {
  pathForRecord(record: T): Promise<string>;
  upsert(record: T, opts?: O): Promise<unknown>;
}

/**
 * Write `updated` in place of `existing`, moving the record (and its
 * attachments) when its path changed. The old path is rendered from
 * `existing` rather than read from its path annotation, which a record
 * re-parsed through Zod no longer carries.
 */
export async function upsertMoved<T extends object, O = never>(
  sheet: MovableSheet<T, O>,
  existing: T,
  updated: T,
  opts?: O,
): Promise<void> {
  const oldPath = await sheet.pathForRecord(existing);
  await sheet.upsert(Object.assign({ ...updated }, { [RECORD_PATH_KEY]: oldPath }) as T, opts);
}

/**
 * Rewrite an on-record attachment key (`<root>/<oldSlug>/<name>`) to the
 * renamed record's path. Keys pointing anywhere else are returned unchanged.
 */
export function rekeyAttachment(
  key: string | null | undefined,
  root: string,
  oldSlug: string,
  newSlug: string,
): string | null | undefined {
  const prefix = `${root}/${oldSlug}/`;
  return key?.startsWith(prefix) ? `${root}/${newSlug}/${key.slice(prefix.length)}` : key;
}

/**
 * Rewrite attachment links inside markdown
 * (`/api/attachments/<root>/<old record path>/<name>`) to the renamed
 * record's path. Events and series carry their images in their description
 * rather than in a key field.
 */
export function relinkAttachments<T extends string | null | undefined>(
  text: T,
  root: string,
  oldPath: string,
  newPath: string,
): T {
  if (!text) return text;
  return text
    .split(`/api/attachments/${root}/${oldPath}/`)
    .join(`/api/attachments/${root}/${newPath}/`) as T;
}
