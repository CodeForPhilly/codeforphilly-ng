/**
 * Rename cascade — specs/behaviors/slug-handles.md: when a project, person or
 * event changes slug, every record that references the old slug is rewritten
 * in the same commit. The set of referencing sheets and fields comes from the
 * references the schemas declare (`SHEET_REFERENCES`, derived in
 * @cfp/shared), not from a hand-kept list.
 *
 * The referencing field is part of each such record's path, so the record
 * moves: its attachments are carried across (gitsheets' delete removes them)
 * and any on-record attachment key or attachment link pointing under its old
 * path is rewritten to the new one.
 */
import { SHEET_REFERENCES, type ContractSheet, type SheetReference } from '@cfp/shared';
import type {
  EventRsvp,
  HelpWantedInterestExpression,
  HelpWantedRole,
  PersonEvaluation,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
} from '@cfp/shared/schemas';
import type { BlobHandle } from 'gitsheets';
import type { z } from 'zod';

import type { InMemoryState } from '../store/memory/state.js';
import { PUBLIC_SHEET_SCHEMAS } from '../store/public.js';
import type { StateApply } from '../store/state-apply.js';
import type { DualStoreTx } from '../store/store.js';
import { restoreAttachments, takeAttachments } from './slug-rename.js';

/** How the cascade reads and re-indexes one referencing sheet's records. */
interface ReferencingSheet<T> {
  /** Every record of the sheet in memory. */
  readonly records: (state: InMemoryState) => Iterable<T>;
  readonly remove: (stateApply: StateApply, record: T) => void;
  readonly upsert: (stateApply: StateApply, record: T) => void;
}

function sheet<T>(adapter: ReferencingSheet<T>): ReferencingSheet<T> {
  return adapter;
}

/**
 * In-memory storage of every sheet that can hold a reference. Which sheets
 * and fields reference what is not decided here — that is SHEET_REFERENCES;
 * a declared reference from a sheet missing below fails loudly.
 */
const REFERENCING_SHEETS: Partial<Record<ContractSheet, ReferencingSheet<never>>> = {
  'project-memberships': sheet<ProjectMembership>({
    records: (s) => s.projectMemberships.values(),
    remove: (a, r) => a.removeMembership(r),
    upsert: (a, r) => a.upsertMembership(r),
  }),
  'project-updates': sheet<ProjectUpdate>({
    records: (s) => s.projectUpdates.values(),
    remove: (a, r) => a.removeProjectUpdate(r),
    upsert: (a, r) => a.upsertProjectUpdate(r),
  }),
  'project-buzz': sheet<ProjectBuzz>({
    records: (s) => s.projectBuzz.values(),
    remove: (a, r) => a.removeProjectBuzz(r),
    upsert: (a, r) => a.upsertProjectBuzz(r),
  }),
  'help-wanted-roles': sheet<HelpWantedRole>({
    records: (s) => s.helpWantedRoles.values(),
    remove: (a, r) => a.removeHelpWantedRole(r),
    upsert: (a, r) => a.upsertHelpWantedRole(r),
  }),
  'help-wanted-interest': sheet<HelpWantedInterestExpression>({
    records: (s) => s.helpWantedInterest.values(),
    remove: (a, r) => a.removeInterest(r),
    upsert: (a, r) => a.upsertInterest(r),
  }),
  'event-rsvps': sheet<EventRsvp>({
    records: (s) => s.eventRsvps.values(),
    remove: (a, r) => a.removeEventRsvp(r),
    upsert: (a, r) => a.upsertEventRsvp(r),
  }),
  'person-evaluations': sheet<PersonEvaluation>({
    records: (s) => s.personEvaluations.values(),
    remove: (a, r) => a.removePersonEvaluation(r),
    upsert: (a, r) => a.upsertPersonEvaluation(r),
  }),
} as unknown as Partial<Record<ContractSheet, ReferencingSheet<never>>>;

/** The sheets that hold a reference to `target` — exported for tests. */
export function referencingSheets(target: string): SheetReference<ContractSheet>[] {
  return SHEET_REFERENCES.filter((r) => r.target.sheet === target && r.target.field === 'slug');
}

/** Whether every declared reference has in-memory storage the cascade can walk. */
export function unsupportedReferences(): SheetReference<ContractSheet>[] {
  return SHEET_REFERENCES.filter((r) => !REFERENCING_SHEETS[r.sheet]);
}

/** The minimal tx-sheet surface the cascade writes through. */
interface TxSheet {
  pathForRecord(record: unknown): Promise<string>;
  delete(record: unknown): Promise<void>;
  upsert(record: unknown): Promise<unknown>;
  getAttachments(record: unknown): Promise<Record<string, BlobHandle> | null>;
  setAttachments(record: unknown, attachments: Record<string, BlobHandle>): Promise<void>;
}

/**
 * Rewrite attachment keys (`<sheet>/<old path>/<name>`) and attachment links
 * inside text (`/api/attachments/<sheet>/<old path>/…`) on a moved record.
 */
function rekeyMovedRecord(
  record: Record<string, unknown>,
  sheetName: string,
  oldPath: string,
  newPath: string,
): Record<string, unknown> {
  const keyPrefix = `${sheetName}/${oldPath}/`;
  const linkOld = `/api/attachments/${keyPrefix}`;
  const linkNew = `/api/attachments/${sheetName}/${newPath}/`;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      out[field] = value;
      continue;
    }
    let v = value.startsWith(keyPrefix) ? `${sheetName}/${newPath}/${value.slice(keyPrefix.length)}` : value;
    if (v.includes(linkOld)) v = v.split(linkOld).join(linkNew);
    out[field] = v;
  }
  return out;
}

export interface RenameCascade {
  /** The renamed record's sheet: `projects`, `people` or `events`. */
  readonly target: string;
  readonly oldSlug: string;
  readonly newSlug: string;
  /**
   * Other fields to set on every referencing record of a given sheet — an
   * event that moves across a year boundary moves its RSVPs' `year` with it.
   */
  readonly also?: Partial<Record<ContractSheet, Record<string, unknown>>>;
}

/**
 * Rewrite every record that references `target.<slug> = oldSlug` to hold
 * `newSlug` (plus any `also` fields), moving it to its new path inside `tx`,
 * and queue the matching in-memory updates on `stateApply`. Returns the number
 * of records rewritten.
 */
export async function cascadeRename(
  tx: DualStoreTx,
  state: InMemoryState,
  stateApply: StateApply,
  rename: RenameCascade,
): Promise<number> {
  let rewritten = 0;
  for (const ref of referencingSheets(rename.target)) {
    const adapter = REFERENCING_SHEETS[ref.sheet] as ReferencingSheet<Record<string, unknown>> | undefined;
    if (!adapter) {
      throw new Error(`no in-memory storage registered for references from ${ref.sheet}.${ref.field}`);
    }
    const also = rename.also?.[ref.sheet] ?? {};
    const schema = PUBLIC_SHEET_SCHEMAS[ref.sheet] as unknown as z.ZodType<Record<string, unknown>>;
    const txSheet = tx.public[ref.sheet] as unknown as TxSheet;

    // Snapshot first: the state isn't touched until the commit lands, but
    // keep the iteration independent of anything queued meanwhile.
    const matches = [...adapter.records(state)].filter((r) => r[ref.field] === rename.oldSlug);
    for (const record of matches) {
      const moved = schema.parse({ ...record, ...also, [ref.field]: rename.newSlug });
      const oldPath = await txSheet.pathForRecord(record);
      const newPath = await txSheet.pathForRecord(moved);
      if (oldPath === newPath && Object.keys(also).every((k) => record[k] === moved[k])) continue;
      const updated = schema.parse(rekeyMovedRecord(moved, ref.sheet, oldPath, newPath));

      const attachments = await takeAttachments(txSheet, record);
      await txSheet.delete(record);
      await txSheet.upsert(updated);
      await restoreAttachments(txSheet, updated, attachments);

      adapter.remove(stateApply, record);
      adapter.upsert(stateApply, updated);
      rewritten++;
    }
  }
  return rewritten;
}
