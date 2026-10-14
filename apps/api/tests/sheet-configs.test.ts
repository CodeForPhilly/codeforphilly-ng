/**
 * Every sheet config's path template must render for any record its schema
 * accepts — i.e. each `${{ field }}` must be a required key of the sheet's
 * Zod schema. A template naming a field the schema lacks throws
 * `path_render_failed` on every upsert, which is how slug-history broke in
 * production (plans/slug-history-config.md).
 *
 * Runs against the vendored canonical configs in `apps/api/gitsheets/`, the
 * same files the test data repos are seeded from.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalContractHash } from 'gitsheets';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { SHEET_CONTRACTS, contractName, type ContractSheet } from '@cfp/shared';

import { PUBLIC_SHEET_SCHEMAS } from '../src/store/public.js';
import { SHEET_CONFIG_DIR } from './helpers/sheet-configs.js';

/** This repo's published contract documents (repo-root `contracts/`). */
const PUBLISHED_CONTRACTS_DIR = join(SHEET_CONFIG_DIR, '..', '..', '..', 'contracts');

/**
 * Fields that exist only to render a sheet's path: the schemas don't declare
 * them, and the write services add them before upsert (`withProjectPath`,
 * `withInterestPath`, `withMembershipPath` and friends). Anything else a
 * template names must be a required schema field.
 */
const WRITE_INJECTED_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'project-memberships': ['projectSlug', 'personSlug'],
  'project-updates': ['projectSlug'],
  'project-buzz': ['projectSlug'],
  'help-wanted-roles': ['projectSlug'],
  'help-wanted-interest': ['personSlug'],
  'event-rsvps': ['eventSlug', 'personSlug'],
};

function templateFields(config: string): string[] {
  const path = /^path\s*=\s*['"](.*)['"]\s*$/m.exec(config)?.[1];
  if (!path) throw new Error('sheet config has no path template');
  return [...path.matchAll(/\$\{\{\s*([A-Za-z0-9_]+)(?:\s*:[^}]*)?\s*\}\}/g)].map((m) => m[1] as string);
}

function requiredKeys(schema: z.ZodType): Set<string> {
  const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) throw new Error('sheet schema is not an object schema');
  return new Set(
    Object.entries(shape)
      .filter(([, field]) => !field.safeParse(undefined).success)
      .map(([key]) => key),
  );
}

describe('sheet configs', () => {
  it('covers exactly the sheets the store opens', async () => {
    const files = (await readdir(SHEET_CONFIG_DIR)).filter((f) => f.endsWith('.toml'));
    expect(files.map((f) => f.replace(/\.toml$/, '')).sort()).toEqual(
      Object.keys(PUBLIC_SHEET_SCHEMAS).sort(),
    );
  });

  for (const [sheet, schema] of Object.entries(PUBLIC_SHEET_SCHEMAS)) {
    it(`${sheet}: path template only uses required schema fields`, async () => {
      const config = await readFile(join(SHEET_CONFIG_DIR, `${sheet}.toml`), 'utf8');
      const required = requiredKeys(schema as z.ZodType);
      const injected = WRITE_INJECTED_PATH_FIELDS[sheet] ?? [];
      const missing = templateFields(config).filter((f) => !required.has(f) && !injected.includes(f));
      expect(missing, `template fields ${sheet}'s records may lack`).toEqual([]);
    });
  }

  it('publishes a contract for exactly the sheets the store opens', () => {
    expect(Object.keys(SHEET_CONTRACTS).sort()).toEqual(Object.keys(PUBLIC_SHEET_SCHEMAS).sort());
  });

  it('mirrors only contracts this repo published, byte-identical to the published document', async () => {
    const dir = join(SHEET_CONFIG_DIR, 'contracts');
    // Contracts live in `<host>/<path>.toml` subdirectories; top-level files
    // (`sources.toml`) are gitsheets' provenance sidecar.
    const mirrored = (await readdir(dir, { recursive: true })).filter(
      (f) => f.endsWith('.toml') && f.includes('/'),
    );
    for (const file of mirrored) {
      const name = file.replace(/\.toml$/, '');
      const published = await readFile(join(PUBLISHED_CONTRACTS_DIR, `${name}.json`), 'utf8');
      const vendored = await readFile(join(dir, file), 'utf8');
      expect(canonicalContractHash(vendored, { format: 'toml' }), name).toBe(
        canonicalContractHash(published, { format: 'json' }),
      );
    }
  });

  it('every sheet config declares exactly the contract version this build publishes', async () => {
    for (const sheet of Object.keys(PUBLIC_SHEET_SCHEMAS) as ContractSheet[]) {
      const config = await readFile(join(SHEET_CONFIG_DIR, `${sheet}.toml`), 'utf8');
      const declared = /^implements\s*=\s*\[(.*)\]/m.exec(config)?.[1] ?? '';
      const names = [...declared.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
      expect(names, sheet).toEqual([contractName(sheet)]);
    }
  });
});

