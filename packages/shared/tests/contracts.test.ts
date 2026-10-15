import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHEET_CONTRACTS,
  SHEET_REFERENCES,
  buildContract,
  contractName,
  type ContractSheet,
} from '../src/contracts.js';

const PUBLISHED = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts');
const sheets = Object.keys(SHEET_CONTRACTS) as ContractSheet[];

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (typeof node === 'object' && node !== null) {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((n) => walk(n, visit));
  }
}

describe('schema contracts', () => {
  it.each(sheets)('%s: the published current version matches what the schema generates', async (sheet) => {
    const committed = JSON.parse(await readFile(join(PUBLISHED, `${contractName(sheet)}.json`), 'utf8'));
    expect(committed).toEqual(buildContract(sheet));
  });

  it.each(sheets)('%s: follows the contract rules', (sheet) => {
    const doc = buildContract(sheet);
    expect(doc.$id).toBe(`https://${contractName(sheet)}`);
    expect(doc.$schema).toBe('http://json-schema.org/draft-07/schema#');
    walk(doc, (n) => {
      expect(n.additionalProperties).not.toBe(false);
      expect(n.type).not.toBe('null');
      if (Array.isArray(n.type)) expect(n.type).not.toContain('null');
      if (Array.isArray(n.required)) expect(n.required).toEqual([...n.required].sort());
      // Reference declarations are stripped: gitsheets compiles contracts strictly.
      expect(typeof n.references, 'references keyword leaked into the contract').not.toBe('string');
    });
  });
});

describe('SHEET_REFERENCES', () => {
  it('is derived from the schemas\' reference declarations', () => {
    expect(
      SHEET_REFERENCES.map((r) => `${r.sheet}.${r.field} → ${r.target.sheet}.${r.target.field}`),
    ).toEqual([
      'project-memberships.projectSlug → projects.slug',
      'project-memberships.personSlug → people.slug',
      'project-updates.projectSlug → projects.slug',
      'project-buzz.projectSlug → projects.slug',
      'help-wanted-roles.projectSlug → projects.slug',
      'help-wanted-interest.personSlug → people.slug',
      'event-rsvps.eventSlug → events.slug',
      'event-rsvps.personSlug → people.slug',
      'person-evaluations.personSlug → people.slug',
    ]);
  });

  it('only targets sheets and fields that exist, and only from required fields', () => {
    for (const ref of SHEET_REFERENCES) {
      const target = SHEET_CONTRACTS[ref.target.sheet as ContractSheet];
      expect(target, ref.target.sheet).toBeDefined();
      expect(Object.keys(buildContract(ref.target.sheet as ContractSheet).properties as object)).toContain(
        ref.target.field,
      );
      expect(buildContract(ref.sheet).required as string[]).toContain(ref.field);
    }
  });
});
