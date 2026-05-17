/**
 * Tests for .github/workflows/snapshot.yml
 *
 * Validates the snapshot workflow's YAML is parseable and contains the
 * load-bearing pieces. Catches typos / accidental removal of steps that
 * the cutover-prep plan explicitly required (schedule cron, scrub-data
 * invocation, force-push to snapshot remote, dated tag).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const WORKFLOW = resolve(__dirname, '../../../.github/workflows/snapshot.yml');

interface WorkflowShape {
  on?: {
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
  jobs?: Record<string, { steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }> }>;
}

describe('snapshot.yml workflow', () => {
  it('parses as valid YAML', async () => {
    const raw = await readFile(WORKFLOW, 'utf8');
    expect(() => parseYaml(raw)).not.toThrow();
  });

  it('has weekly schedule and workflow_dispatch triggers', async () => {
    const raw = await readFile(WORKFLOW, 'utf8');
    const doc = parseYaml(raw) as WorkflowShape;
    expect(doc.on?.schedule).toBeDefined();
    expect(doc.on?.schedule).toBeInstanceOf(Array);
    expect(doc.on?.schedule?.[0]?.cron).toMatch(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/);
    expect(doc.on?.workflow_dispatch).toBeDefined();
  });

  it('invokes script:scrub-data and pushes a dated tag', async () => {
    const raw = await readFile(WORKFLOW, 'utf8');
    const doc = parseYaml(raw) as WorkflowShape;
    const steps = doc.jobs?.['snapshot']?.steps ?? [];
    const allRunBlocks = steps
      .map((s) => s.run ?? '')
      .join('\n');
    expect(allRunBlocks).toContain('script:scrub-data');
    expect(allRunBlocks).toContain('codeforphilly-data-snapshot');
    expect(allRunBlocks).toMatch(/snapshot-.*-scrubbed/);
    expect(allRunBlocks).toMatch(/git push --force/);
  });

  it('uses the actions versions that the rest of CI uses', async () => {
    const raw = await readFile(WORKFLOW, 'utf8');
    const doc = parseYaml(raw) as WorkflowShape;
    const steps = doc.jobs?.['snapshot']?.steps ?? [];
    const uses = steps.map((s) => s.uses).filter(Boolean);
    expect(uses).toContain('actions/checkout@v6');
    expect(uses).toContain('asdf-vm/actions/install@v4');
  });
});
