/**
 * Backfill the four laddr events — plans/events-legacy-backfill.md.
 *
 * One-off, re-runnable. Reads the laddr JSON captured in a directory
 * (`all.json` from `/events/*all?format=json` plus one
 * `segments-<handle>.json` per event), translates each published event into
 * an `events` record with its segments as agenda items, groups the
 * Launchpads under a "Launchpad" series, captures every laddr-hosted image
 * the descriptions reference as an attachment on the event (links
 * rewritten), and commits the lot through gitsheets on a branch of the data
 * repo for review. Re-running updates the same records (matched by
 * `legacyId`) rather than duplicating them.
 *
 *   npx tsx scripts/backfill-laddr-events.ts <bare-gitdir> <json-dir> \
 *     [--branch events-backfill] [--parent refs/remotes/origin/published] \
 *     [--host codeforphilly.live.k8s.phl.io]
 *
 * The branch is created from `--parent` on first run (raw git, like the
 * importer); later runs commit on top of it. Push it and open a PR into
 * `published` — the script never moves HEAD or pushes.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { uuidv7 } from 'uuidv7';
import {
  EventSchema,
  EventSeriesSchema,
  type Event,
  type EventAgendaItem,
  type EventSeries,
} from '@cfp/shared/schemas';

import { openPublicStore } from '../src/store/public.js';

const exec = promisify(execFile);

interface LaddrEvent {
  ID: number;
  Handle: string;
  Title: string;
  Status: string;
  StartTime: number;
  EndTime: number | null;
  LocationName: string | null;
  LocationAddress: string | null;
  Description: string | null;
  Created: number;
  Modified: number | null;
}

interface LaddrSegment {
  ID: number;
  Handle: string;
  Title: string;
  StartTime: number;
  EndTime: number | null;
  LocationName: string | null;
  LocationAddress: string | null;
  Summary: string | null;
  Description: string | null;
}

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const [gitDir, jsonDir] = positional;
if (!gitDir || !jsonDir) {
  console.error(
    'usage: backfill-laddr-events.ts <bare-gitdir> <json-dir> [--branch b] [--parent ref] [--host h]',
  );
  process.exit(2);
}
const BRANCH = flag('branch', 'events-backfill');
const PARENT = flag('parent', 'refs/remotes/origin/published');
const HOST = flag('host', 'codeforphilly.live.k8s.phl.io');
const AUTHOR = { name: 'Code for Philly API', email: 'api@users.noreply.codeforphilly.org' };

const HOUR = 60 * 60 * 1000;
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();
/**
 * laddr stored CRLF line endings and its renderer accepted `###Heading`
 * with no space, which GFM shows literally; records keep LF and a space.
 */
const lf = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(/^(#{1,6})(?=[^#\s])/gm, '$1 ');

/**
 * Laddr media links in these descriptions are both absolute
 * (`https://codeforphilly.org/thumbnail/…`) and site-relative
 * (`/thumbnail/1242/200x200`). The MediaID is the capture group; bytes are
 * always fetched from `/media/<id>/original`.
 */
const MEDIA_RE =
  /(?:https?:\/\/codeforphilly\.org)?\/(?:thumbnail|media\/open|media|sitedata)\/(\d+)(?:\/[^"'<\s)]*)?/g;

interface Captured {
  readonly filename: string;
  readonly bytes: Buffer;
}

async function captureMedia(mediaId: number, cache: Map<number, Captured>): Promise<Captured> {
  const hit = cache.get(mediaId);
  if (hit) return hit;
  const res = await fetch(`https://${HOST}/media/${mediaId}/original`, {
    headers: { 'user-agent': 'codeforphilly-ng backfill-laddr-events' },
  });
  if (!res.ok) throw new Error(`media ${mediaId}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  const ext = type.includes('png')
    ? 'png'
    : type.includes('gif')
      ? 'gif'
      : type.includes('webp')
        ? 'webp'
        : type.includes('svg')
          ? 'svg'
          : 'jpg';
  const captured = { filename: `media-${mediaId}.${ext}`, bytes: Buffer.from(await res.arrayBuffer()) };
  cache.set(mediaId, captured);
  return captured;
}

/** Rewrite laddr media URLs in `text` to this event's attachment URLs, collecting the bytes. */
async function rewriteMedia(
  text: string,
  slug: string,
  cache: Map<number, Captured>,
  collected: Map<string, Buffer>,
): Promise<string> {
  const ids = [...text.matchAll(MEDIA_RE)].map((m) => Number(m[1]));
  for (const id of new Set(ids)) {
    const c = await captureMedia(id, cache);
    collected.set(c.filename, c.bytes);
  }
  return text.replace(MEDIA_RE, (_full, idStr: string) => {
    const c = cache.get(Number(idStr))!;
    return `/api/attachments/events/${slug}/${c.filename}`;
  });
}

function agendaFrom(segments: LaddrSegment[], warn: (s: string) => void): EventAgendaItem[] {
  return segments
    .map((s) => {
      const startsAt = iso(s.StartTime);
      let endsAt: string | null = s.EndTime ? iso(s.EndTime) : null;
      if (endsAt && new Date(endsAt) <= new Date(startsAt)) {
        warn(`segment ${s.Handle}: EndTime precedes StartTime; dropped`);
        endsAt = null;
      }
      let description =
        [s.Summary, s.Description].filter((x): x is string => !!x && x.trim() !== '').map(lf).join('\n\n') || null;
      if (description && description.length > 2_000) {
        warn(`segment ${s.Handle}: description ${description.length} chars; truncated to 2,000`);
        description = `${description.slice(0, 1_990).trimEnd()}…`;
      }
      return {
        startsAt,
        endsAt,
        title: s.Title.slice(0, 120),
        venueName: s.LocationName,
        venueAddress: s.LocationAddress,
        description,
      };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

async function main(): Promise<void> {
  const warnings: string[] = [];
  const warn = (s: string): void => {
    warnings.push(s);
  };
  const all = JSON.parse(await readFile(join(jsonDir!, 'all.json'), 'utf8')) as { data: LaddrEvent[] };
  const events = all.data.filter((e) => e.Status === 'published');

  const { store, repo } = await openPublicStore(gitDir!);

  // Create the branch from the parent on first run; later runs advance it.
  const ref = `refs/heads/${BRANCH}`;
  if ((await repo.resolveRef(ref)) === null) {
    const start = await repo.resolveRef(PARENT);
    if (start === null) throw new Error(`cannot create ${ref}: ${PARENT} does not resolve in ${gitDir}`);
    await exec('git', ['update-ref', ref, start, ''], { cwd: gitDir! });
  }

  // Read what the branch already holds inside a no-op transaction parented on it.
  let existingSeries: EventSeries[] = [];
  let existingEvents: Event[] = [];
  await store.transact({ parent: ref, message: 'read', author: AUTHOR }, async (tx) => {
    existingSeries = await tx['event-series'].queryAll();
    existingEvents = await tx.events.queryAll();
  });
  const byLegacy = new Map(
    existingEvents.filter((e) => typeof e.legacyId === 'number').map((e) => [e.legacyId as number, e]),
  );

  const now = new Date().toISOString();
  let launchpad = existingSeries.find((s) => s.slug === 'launchpad');
  const newSeries = !launchpad;
  launchpad ??= EventSeriesSchema.parse({
    id: uuidv7(),
    slug: 'launchpad',
    title: 'Launchpad',
    description:
      "Code for Philly's multi-week civic hackathon: teams form around a theme, build over several weeks of hack nights, and demo at a showcase.",
    createdAt: now,
    updatedAt: now,
  });
  const series = launchpad;

  const mediaCache = new Map<number, Captured>();
  const translated: Array<{ record: Event; attachments: Map<string, Buffer> }> = [];
  for (const e of events) {
    const slug = e.Handle.toLowerCase();
    const segments = (
      JSON.parse(await readFile(join(jsonDir!, `segments-${e.Handle}.json`), 'utf8')) as { data: LaddrSegment[] }
    ).data;
    const attachments = new Map<string, Buffer>();
    const description = e.Description ? await rewriteMedia(lf(e.Description), slug, mediaCache, attachments) : null;
    const agenda = agendaFrom(segments, (s) => warn(`${slug}: ${s}`));
    for (const item of agenda) {
      if (item.description) item.description = await rewriteMedia(item.description, slug, mediaCache, attachments);
    }
    const startsAt = iso(e.StartTime);
    // The event must cover every agenda item (specs/data-model.md#agenda-items).
    // launchpad-2018's last segment starts after laddr's EndTime, so stretch
    // the end to the last item's end (or start + 1h) when needed.
    let endsAt = e.EndTime ? iso(e.EndTime) : iso(e.StartTime + 3 * 3600);
    for (const item of agenda) {
      const itemEnd = item.endsAt ?? new Date(new Date(item.startsAt).getTime() + HOUR).toISOString();
      if (itemEnd > endsAt) {
        warn(`${slug}: endsAt stretched from ${endsAt} to cover the item at ${item.startsAt}`);
        endsAt = itemEnd;
      }
    }
    const existing = byLegacy.get(e.ID);
    const record: Event = EventSchema.parse({
      id: existing?.id ?? uuidv7(),
      legacyId: e.ID,
      slug,
      title: e.Title.slice(0, 200),
      description,
      startsAt,
      endsAt,
      venueName: e.LocationName,
      venueAddress: e.LocationAddress,
      seriesId: /launchpad/i.test(e.Handle) ? series.id : null,
      agenda,
      status: 'scheduled',
      icsSequence: existing?.icsSequence ?? 0,
      createdAt: iso(e.Created),
      updatedAt: e.Modified ? iso(e.Modified) : iso(e.Created),
    });
    translated.push({ record, attachments });
  }

  const result = await store.transact(
    {
      parent: ref,
      branch: ref,
      message: `events: backfill ${translated.length} laddr events${newSeries ? ' + Launchpad series' : ''}`,
      author: AUTHOR,
      trailers: { Action: 'events.backfill-laddr', 'Source-Host': HOST },
    },
    async (tx) => {
      if (newSeries) await tx['event-series'].upsert(series);
      for (const { record, attachments } of translated) {
        if (attachments.size > 0) {
          await tx.events.setAttachments(record, Object.fromEntries(attachments));
        }
        await tx.events.upsert(record);
      }
    },
  );

  console.log(
    JSON.stringify(
      {
        branch: ref,
        parent: PARENT,
        commit: result.commitHash,
        series: newSeries ? 'created' : 'existing',
        events: translated.map((t) => ({
          slug: t.record.slug,
          startsAt: t.record.startsAt,
          endsAt: t.record.endsAt,
          agenda: t.record.agenda?.length ?? 0,
          attachments: [...t.attachments.keys()],
        })),
        warnings,
      },
      null,
      2,
    ),
  );
}

await main();
