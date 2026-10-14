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

import { PERSON_EVALUATIONS_CONTRACT_NAME, PERSON_EVALUATIONS_CONTRACT_V1 } from '@cfp/shared';

import { PUBLIC_SHEET_SCHEMAS } from '../src/store/public.js';
import { SHEET_CONFIG_DIR } from './helpers/sheet-configs.js';

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

  it('vendors the person-evaluations contract byte-identical to the shared document', async () => {
    const vendored = await readFile(
      join(SHEET_CONFIG_DIR, 'contracts', `${PERSON_EVALUATIONS_CONTRACT_NAME}.toml`),
      'utf8',
    );
    expect(canonicalContractHash(vendored, { format: 'toml' })).toBe(
      canonicalContractHash(PERSON_EVALUATIONS_CONTRACT_V1),
    );
    const config = await readFile(join(SHEET_CONFIG_DIR, 'person-evaluations.toml'), 'utf8');
    expect(config).toContain(`implements = ["${PERSON_EVALUATIONS_CONTRACT_NAME}"]`);
  });
});

