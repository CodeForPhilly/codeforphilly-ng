/**
 * Versioned gitsheets schema contracts this project's sheets implement —
 * specs/behaviors/spam-exclusion.md.
 *
 * The canonical (TOML) copy lives in codeforphilly-data's `empty` branch at
 * `.gitsheets/contracts/<name>.toml`; consumers open the sheet against the
 * document below, and a test checks the two hash identically. Published
 * versions are immutable: a shape change is a new name (`…/v2`).
 */

export const PERSON_EVALUATIONS_CONTRACT_NAME = 'codeforphilly.org/person-evaluations/v1';

export const PERSON_EVALUATIONS_CONTRACT_V1 =
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://codeforphilly.org/person-evaluations/v1",
  "title": "Person evaluation",
  "description": "One spam verdict about one person from one evaluator. Machine evaluators (heuristic, LLM, github-probe) write these in the private codeforphilly-spam-detection repo; staff votes are written to codeforphilly-data by the site with evaluator = \"human-<voterSlug>\". Records are interchangeable at prune time.",
  "type": "object",
  "required": ["evaluatedAt", "evaluator", "flags", "personSlug", "verdict"],
  "properties": {
    "personSlug": { "type": "string", "minLength": 1, "description": "Slug of the evaluated person." },
    "evaluator": { "type": "string", "minLength": 1, "description": "Model/run id (e.g. haiku-2026-05) or human-<voterSlug>." },
    "verdict": { "type": "string", "enum": ["spam", "legit", "uncertain"] },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1, "description": "0-1. LLM and probe evaluators; 1 on human votes; absent on heuristic records." },
    "score": { "type": "integer", "description": "Heuristic evaluators only: rule points, unbounded." },
    "flags": { "type": "array", "items": { "type": "string" }, "description": "Short reason tags." },
    "reasoning": { "type": "string", "description": "Free-text justification. Optional on human votes." },
    "evaluatedAt": { "type": "string", "format": "date-time", "description": "ISO 8601 UTC." }
  }
} as const;
