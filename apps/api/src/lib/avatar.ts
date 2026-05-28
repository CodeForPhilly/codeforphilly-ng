/**
 * Avatar image processing.
 *
 * Center-crops the input to a square (preserving the shorter edge), then
 * emits two JPEG outputs:
 *
 *   - `original`: full-resolution square JPEG q85
 *   - `thumbnail`: 128×128 square JPEG q80
 *
 * Both are JPEG regardless of input format (PNG/WebP/JPEG); the served
 * paths (`avatar.jpg`, `avatar-128.jpg`) match `specs/api/people.md`'s
 * declared storage locations and decouple consumer behavior from
 * upload format. PNG-with-alpha loses transparency (sharp's default
 * flatten); acceptable trade-off for an avatar surface.
 *
 * EXIF rotation is respected (`.rotate()` reorients per metadata) so
 * phone-shot portraits don't land sideways.
 */
import sharp from 'sharp';

export interface ProcessedAvatar {
  readonly original: Buffer;
  readonly thumbnail: Buffer;
}

export const AVATAR_ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/**
 * Process an uploaded avatar buffer into (original-square, 128 thumbnail)
 * JPEG outputs. Throws if the buffer isn't a decodable image with usable
 * dimensions — caller translates to 422.
 */
export async function processAvatar(buffer: Buffer): Promise<ProcessedAvatar> {
  // .rotate() applies EXIF orientation before any subsequent ops, so
  // .extract() works on visually-correct pixels.
  const oriented = sharp(buffer).rotate();
  const meta = await oriented.metadata();
  if (!meta.width || !meta.height) {
    throw new Error('image dimensions unreadable');
  }

  const side = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - side) / 2);
  const top = Math.floor((meta.height - side) / 2);

  // Two independent pipelines from the same source buffer — sharp() is a
  // builder and a single instance can't be reused across two .toBuffer()
  // calls without re-creating from the source.
  const original = await sharp(buffer)
    .rotate()
    .extract({ left, top, width: side, height: side })
    .jpeg({ quality: 85 })
    .toBuffer();

  const thumbnail = await sharp(buffer)
    .rotate()
    .extract({ left, top, width: side, height: side })
    .resize(128, 128, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();

  return { original, thumbnail };
}
