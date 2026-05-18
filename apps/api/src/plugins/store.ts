/**
 * Store plugin.
 *
 * Decorates fastify.store with the booted dual-store instance.
 * Called after @fastify/env so fastify.config is available.
 *
 * Per the plan's plugin ordering: registered after env, cors, cookie, trace-id,
 * and the logger/error-handler setup.
 */
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Repository } from 'gitsheets';
import { bootStores } from '../store/boot.js';
import type { Store } from '../store/store.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: Store;
    /** Underlying gitsheets repo for the public data store — used by the push-daemon plugin. */
    publicRepo: Repository;
  }
}

async function storePlugin(fastify: FastifyInstance): Promise<void> {
  const { store, publicRepo } = await bootStores({
    CFP_DATA_REPO_PATH: fastify.config.CFP_DATA_REPO_PATH,
    STORAGE_BACKEND: fastify.config.STORAGE_BACKEND,
    CFP_PRIVATE_STORAGE_PATH: fastify.config.CFP_PRIVATE_STORAGE_PATH,
    S3_ENDPOINT: fastify.config.S3_ENDPOINT,
    S3_BUCKET: fastify.config.S3_BUCKET,
    S3_ACCESS_KEY_ID: fastify.config.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: fastify.config.S3_SECRET_ACCESS_KEY,
    S3_REGION: fastify.config.S3_REGION,
  });

  fastify.decorate('store', store);
  fastify.decorate('publicRepo', publicRepo);
}

export default fp(storePlugin, {
  name: 'store',
  fastify: '5.x',
  dependencies: ['@fastify/env'],
});
