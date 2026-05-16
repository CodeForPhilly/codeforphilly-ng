import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BasePrivateStore } from './base.js';

/** Environment variables consumed by S3PrivateStore. */
export interface S3PrivateStoreEnv {
  readonly S3_ENDPOINT: string;
  readonly S3_BUCKET: string;
  readonly S3_ACCESS_KEY_ID: string;
  readonly S3_SECRET_ACCESS_KEY: string;
  readonly S3_REGION: string;
}

/**
 * S3-compatible bucket-backed PrivateStore for production.
 *
 * PUTs are single-object, atomic from the bucket's perspective.
 * Bucket versioning must be enabled in production for recovery.
 *
 * Configured via S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, S3_REGION.
 */
export class S3PrivateStore extends BasePrivateStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #keyPrefix: string;

  constructor(env: S3PrivateStoreEnv, keyPrefix = '') {
    super();
    this.#client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      // Force path-style for S3-compatible endpoints (MinIO, etc.)
      forcePathStyle: true,
    });
    this.#bucket = env.S3_BUCKET;
    this.#keyPrefix = keyPrefix;
  }

  protected override async readRaw(key: string): Promise<string | null> {
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: this.#keyPrefix + key }),
      );
      if (!response.Body) return null;
      return await response.Body.transformToString('utf-8');
    } catch (err) {
      if (isNoSuchKeyError(err)) return null;
      throw err;
    }
  }

  protected override async writeRaw(key: string, content: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#keyPrefix + key,
        Body: content,
        ContentType: 'application/x-ndjson',
      }),
    );
  }
}

function isNoSuchKeyError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return e['name'] === 'NoSuchKey' || e['Code'] === 'NoSuchKey' || e['$metadata'] != null && (e['Code'] === 'NoSuchKey');
}
