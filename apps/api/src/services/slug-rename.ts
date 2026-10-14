/**
 * Keep a record's attachments across a slug rename.
 *
 * A rename deletes the record at its old path and upserts it at the new one.
 * gitsheets' delete also removes the record's attachment folder, so without
 * this the attachments (avatars, featured images) are lost and the on-record
 * key points at a path that no longer exists. specs/behaviors/slug-handles.md:
 * a rename changes the handle and nothing else about the entity.
 *
 * Interim until gitsheets can move a record together with its attachments
 * (plans/slug-rename-attachments.md).
 */
import type { BlobHandle } from 'gitsheets';

interface AttachmentSheet<T> {
  getAttachments(record: T | string): Promise<Record<string, BlobHandle> | null>;
  setAttachments(record: T | string, attachments: Record<string, BlobHandle>): Promise<void>;
}

/** Read the record's attachments before its old path is deleted. */
export async function takeAttachments<T>(
  sheet: AttachmentSheet<T>,
  record: T,
): Promise<Record<string, BlobHandle> | null> {
  const attachments = await sheet.getAttachments(record);
  return attachments && Object.keys(attachments).length > 0 ? attachments : null;
}

/** Re-attach to the record at its new path (blobs are reused by hash). */
export async function restoreAttachments<T>(
  sheet: AttachmentSheet<T>,
  record: T,
  attachments: Record<string, BlobHandle> | null,
): Promise<void> {
  if (attachments) await sheet.setAttachments(record, attachments);
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
