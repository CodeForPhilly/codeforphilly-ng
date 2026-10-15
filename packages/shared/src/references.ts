/**
 * Declared references between sheets — specs/data-model.md → "References".
 *
 * A field that references another record by its handle declares the target
 * on its Zod schema with `.meta({ references: '<sheet>.<field>' })` (use
 * {@link references} so the target is type-checked). {@link SHEET_REFERENCES}
 * is derived from those declarations, so the set of records a rename must
 * rewrite (specs/behaviors/slug-handles.md) is computed from the schemas,
 * not remembered in a hand-kept list.
 *
 * The `references` keyword is not part of the published contracts:
 * `buildContract()` strips it, since gitsheets compiles contracts strictly.
 */
import type { z } from 'zod';

/** The metadata keyword a referencing field carries. */
export const REFERENCES_META_KEY = 'references';

/** A reference target: `<sheet>.<field>`, e.g. `projects.slug`. */
export type ReferenceTarget = `${string}.${string}`;

/** Metadata to pass to `.meta()` on a field that references `target`. */
export function references(target: ReferenceTarget): { [REFERENCES_META_KEY]: ReferenceTarget } {
  return { [REFERENCES_META_KEY]: target };
}

export interface SheetReference<S extends string = string> {
  /** The referencing sheet. */
  readonly sheet: S;
  /** The referencing field on that sheet's records. */
  readonly field: string;
  /** What the field holds: `target.field` of a `target.sheet` record. */
  readonly target: { readonly sheet: string; readonly field: string };
}

/** The declared `references` target of one field schema, if any. */
export function referenceTargetOf(field: z.ZodType): { sheet: string; field: string } | null {
  const value = field.meta()?.[REFERENCES_META_KEY];
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) {
    throw new Error(`invalid reference target '${value}' (expected <sheet>.<field>)`);
  }
  return { sheet: value.slice(0, dot), field: value.slice(dot + 1) };
}

/**
 * Every declared reference across `schemas` (sheet → object schema), in
 * sheet then field declaration order.
 */
export function collectReferences<S extends string>(
  schemas: Readonly<Record<S, z.ZodType>>,
): SheetReference<S>[] {
  const out: SheetReference<S>[] = [];
  for (const [sheet, schema] of Object.entries(schemas) as [S, z.ZodType][]) {
    const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
    if (!shape) continue;
    for (const [field, fieldSchema] of Object.entries(shape)) {
      const target = referenceTargetOf(fieldSchema);
      if (target) out.push({ sheet, field, target });
    }
  }
  return out;
}
