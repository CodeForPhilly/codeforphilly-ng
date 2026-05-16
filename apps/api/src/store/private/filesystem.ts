import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BasePrivateStore } from './base.js';

/** Environment variables consumed by FilesystemPrivateStore. */
export interface FilesystemPrivateStoreEnv {
  readonly CFP_PRIVATE_STORAGE_PATH: string;
}

/**
 * Filesystem-backed PrivateStore for development and ephemeral use.
 *
 * Writes are atomic via temp-file-then-rename (no half-written-file hazard).
 * Configured via CFP_PRIVATE_STORAGE_PATH.
 */
export class FilesystemPrivateStore extends BasePrivateStore {
  readonly #dir: string;

  constructor(env: FilesystemPrivateStoreEnv) {
    super();
    this.#dir = env.CFP_PRIVATE_STORAGE_PATH;
  }

  protected override async readRaw(key: string): Promise<string | null> {
    try {
      return await readFile(join(this.#dir, key), 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  }

  protected override async writeRaw(key: string, content: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const path = join(this.#dir, key);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  }
}
