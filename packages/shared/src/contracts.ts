/**
 * Versioned gitsheets schema contracts for every public sheet —
 * specs/behaviors/storage.md → "Schema contracts".
 *
 * The Zod schema is the source of record shape; `buildContract()` turns its
 * input side (what a writer may store: defaulted fields optional, with the
 * default declared so gitsheets fills it on write) into
 * the published, language-neutral contract document. The documents are
 * committed (published) at `contracts/codeforphilly.org/<sheet>/v<N>.json`,
 * the data repo adopts them from there, and the API opens each sheet against
 * `buildContract(sheet)` at boot.
 *
 * Published versions are immutable. When a schema change alters a sheet's
 * document, CI (`check-contracts`) fails: bump that sheet's `version` here,
 * which publishes a new `v<N+1>` file beside the old one.
 */
import { toJSONSchema, type z } from 'zod';

import {
  BlogPostSchema,
  EventRsvpSchema,
  EventSchema,
  HelpWantedInterestExpressionSchema,
  HelpWantedRoleSchema,
  PersonEvaluationSchema,
  PersonSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  RevocationSchema,
  SlugHistorySchema,
  TagAssignmentSchema,
  TagSchema,
} from './schemas/index.js';

export const CONTRACT_HOST = 'codeforphilly.org';

interface SheetContract {
  readonly schema: z.ZodType;
  /** Current published version. Bump when the generated document changes. */
  readonly version: number;
  readonly title: string;
}

export const SHEET_CONTRACTS = {
  people: { schema: PersonSchema, version: 1, title: 'Person' },
  projects: { schema: ProjectSchema, version: 1, title: 'Project' },
  'project-memberships': { schema: ProjectMembershipSchema, version: 1, title: 'Project membership' },
  'project-updates': { schema: ProjectUpdateSchema, version: 1, title: 'Project update' },
  'project-buzz': { schema: ProjectBuzzSchema, version: 1, title: 'Project buzz' },
  'blog-posts': { schema: BlogPostSchema, version: 1, title: 'Blog post' },
  'help-wanted-roles': { schema: HelpWantedRoleSchema, version: 1, title: 'Help-wanted role' },
  'help-wanted-interest': {
    schema: HelpWantedInterestExpressionSchema,
    version: 1,
    title: 'Help-wanted interest expression',
  },
  tags: { schema: TagSchema, version: 1, title: 'Tag' },
  'tag-assignments': { schema: TagAssignmentSchema, version: 1, title: 'Tag assignment' },
  'slug-history': { schema: SlugHistorySchema, version: 1, title: 'Slug history' },
  revocations: { schema: RevocationSchema, version: 1, title: 'Session revocation' },
  events: { schema: EventSchema, version: 1, title: 'Event' },
  'event-rsvps': { schema: EventRsvpSchema, version: 1, title: 'Event RSVP' },
  // v1 was hand-authored before contracts were generated; v2 is the first
  // generated version (it adds the evaluatedAt datetime pattern).
  'person-evaluations': { schema: PersonEvaluationSchema, version: 2, title: 'Person evaluation' },
} as const satisfies Record<string, SheetContract>;

export type ContractSheet = keyof typeof SHEET_CONTRACTS;

/** `codeforphilly.org/<sheet>/v<N>` — the contract name sheet configs declare. */
export function contractName(sheet: ContractSheet): string {
  return `${CONTRACT_HOST}/${sheet}/v${SHEET_CONTRACTS[sheet].version}`;
}

/** Zod's integer default bounds (±MAX_SAFE_INTEGER): noise, not a constraint. */
const SAFE_INT = 9007199254740991;

function isNullBranch(node: unknown): boolean {
  return typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'null';
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

/**
 * Normalize one JSON Schema node to the contract rules: open for extension,
 * no null-bearing keywords, no default integer bounds, sorted `required`.
 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (typeof node !== 'object' || node === null) return node;

  let out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' && (value === false || isEmptyObject(value))) continue;
    if ((key === 'minimum' && value === -SAFE_INT) || (key === 'maximum' && value === SAFE_INT)) {
      continue;
    }
    out[key] = normalize(value);
  }

  // `.nullable()` → anyOf [T, { type: 'null' }]. TOML has no null, so the
  // field is just T (and stays optional).
  if (Array.isArray(out.anyOf)) {
    const branches = (out.anyOf as unknown[]).filter((b) => !isNullBranch(b));
    const rest = Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'anyOf'));
    out =
      branches.length === 1
        ? { ...rest, ...(branches[0] as Record<string, unknown>) }
        : { ...rest, anyOf: branches };
  }
  if (Array.isArray(out.required)) out.required = [...(out.required as string[])].sort();
  return out;
}

/** The published contract document for a sheet's current version. */
export function buildContract(sheet: ContractSheet): Record<string, unknown> {
  const { schema, title } = SHEET_CONTRACTS[sheet];
  const generated = normalize(toJSONSchema(schema, { io: 'input' })) as Record<string, unknown>;
  const body = Object.fromEntries(Object.entries(generated).filter(([k]) => k !== '$schema'));
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://${contractName(sheet)}`,
    title,
    ...body,
  };
}
