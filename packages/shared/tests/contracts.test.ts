import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHEET_CONTRACTS, buildContract, contractName, type ContractSheet } from '../src/contracts.js';

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
    });
  });
});
