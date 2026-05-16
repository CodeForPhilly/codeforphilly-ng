/**
 * Generate JSON Schema files from Zod schemas for all public gitsheets sheets.
 *
 * Output: .gitsheets/schemas/<Entity>.schema.json (relative to repo root).
 * Run: npm run generate-schemas -w packages/shared
 *
 * The generated files are committed to the repo and must stay in sync with the
 * Zod source. CI runs this script and fails if any file differs from what's
 * committed (checked via `git diff --exit-code`).
 *
 * Uses Zod v4's built-in `toJSONSchema` (draft/2020-12). gitsheets' ajv
 * instance uses ajv@8 which supports draft-07 and 2020-12 via ajv-formats.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toJSONSchema } from 'zod';

import {
  HelpWantedInterestExpressionSchema,
  HelpWantedRoleSchema,
  PersonSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  RevocationSchema,
  SlugHistorySchema,
  TagAssignmentSchema,
  TagSchema,
} from '../src/schemas/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const outDir = resolve(repoRoot, '.gitsheets', 'schemas');

const schemas = [
  { name: 'Person', schema: PersonSchema },
  { name: 'Project', schema: ProjectSchema },
  { name: 'ProjectMembership', schema: ProjectMembershipSchema },
  { name: 'ProjectUpdate', schema: ProjectUpdateSchema },
  { name: 'ProjectBuzz', schema: ProjectBuzzSchema },
  { name: 'HelpWantedRole', schema: HelpWantedRoleSchema },
  { name: 'HelpWantedInterestExpression', schema: HelpWantedInterestExpressionSchema },
  { name: 'Tag', schema: TagSchema },
  { name: 'TagAssignment', schema: TagAssignmentSchema },
  { name: 'SlugHistory', schema: SlugHistorySchema },
  { name: 'Revocation', schema: RevocationSchema },
] as const;

await mkdir(outDir, { recursive: true });

for (const { name, schema } of schemas) {
  const jsonSchema = toJSONSchema(schema, { io: 'output' });

  // Strip the $schema field: gitsheets uses ajv@8 in draft-07 mode, which
  // rejects the "https://json-schema.org/draft/2020-12/schema" $schema URI.
  // The schemas themselves only use constructs compatible with both drafts
  // (anyOf, type, pattern, minLength, format, additionalProperties).
  const { $schema: _stripped, ...rest } = jsonSchema as Record<string, unknown>;
  const output = {
    ...rest,
    title: name,
  };

  const outPath = resolve(outDir, `${name}.schema.json`);
  await writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`  wrote ${outPath}`);
}

console.log(`Generated ${schemas.length} JSON schemas.`);
