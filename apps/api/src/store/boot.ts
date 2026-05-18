import type { Repository } from 'gitsheets';
import { FilesystemPrivateStore } from './private/filesystem.js';
import { S3PrivateStore } from './private/s3.js';
import { openPublicStore } from './public.js';
import { wireSheetIndices } from './sheet-indices.js';
import { Store } from './store.js';

/** Subset of process.env needed to boot both stores. */
export interface Env {
  readonly CFP_DATA_REPO_PATH: string;
  readonly STORAGE_BACKEND: 'filesystem' | 's3';

  // Filesystem backend
  readonly CFP_PRIVATE_STORAGE_PATH?: string;

  // S3 backend
  readonly S3_ENDPOINT?: string;
  readonly S3_BUCKET?: string;
  readonly S3_ACCESS_KEY_ID?: string;
  readonly S3_SECRET_ACCESS_KEY?: string;
  readonly S3_REGION?: string;
}

/**
 * Boot both stores and return a combined Store + the underlying public-repo
 * handle. The repo handle is consumed by the push-daemon plugin to push
 * commits to origin; everything else only needs `store`.
 *
 * Fails loudly (throws) if either store is unreachable. The API must not
 * serve traffic until this resolves — private profiles are required for login.
 *
 * Boot order per specs/behaviors/private-storage.md:
 *   1. Public gitsheets data
 *   2. Private store data
 *   3. (FTS index is built by the caller from the loaded public data)
 */
export async function bootStores(env: Env): Promise<{ store: Store; publicRepo: Repository }> {
  const { store: publicStore, repo: publicRepo } = await openPublicStore(env.CFP_DATA_REPO_PATH).catch((err) => {
    throw new Error(`Failed to open public gitsheets store at ${env.CFP_DATA_REPO_PATH}: ${String(err)}`, { cause: err });
  });

  // Secondary in-memory indices on each sheet — used for slug uniqueness +
  // reverse lookups during write-api mutations.
  await wireSheetIndices(publicStore);

  const privateStore = buildPrivateStore(env);

  await privateStore.load().catch((err) => {
    throw new Error(`Failed to load private store (${env.STORAGE_BACKEND}): ${String(err)}`, { cause: err });
  });

  return { store: new Store(publicStore, privateStore), publicRepo };
}

function buildPrivateStore(env: Env): FilesystemPrivateStore | S3PrivateStore {
  if (env.STORAGE_BACKEND === 's3') {
    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_REGION'] as const;
    for (const key of required) {
      if (!env[key]) throw new Error(`S3 backend requires env var ${key}`);
    }
    return new S3PrivateStore({
      S3_ENDPOINT: env.S3_ENDPOINT!,
      S3_BUCKET: env.S3_BUCKET!,
      S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID!,
      S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY!,
      S3_REGION: env.S3_REGION!,
    });
  }

  if (!env.CFP_PRIVATE_STORAGE_PATH) {
    throw new Error('Filesystem backend requires CFP_PRIVATE_STORAGE_PATH');
  }
  return new FilesystemPrivateStore({ CFP_PRIVATE_STORAGE_PATH: env.CFP_PRIVATE_STORAGE_PATH });
}
