/**
 * Backfill the four laddr events — plans/events-legacy-backfill.md.
 *
 * One-off, re-runnable. Reads the laddr JSON captured in a directory
 * (`all.json` from `/events/*all?format=json` plus one
 * `segments-<handle>.json` per event). A laddr "event" was a whole program,
 * so each becomes an `event-series` record (slug = laddr handle) and its
 * segments become one `events` record per Philadelphia calendar day, with
 * that day's segments as the agenda (specs/behaviors/events.md#legacy-urls,
 * "One venue, one span, one event"). Laddr-hosted images referenced by a
 * program description are captured as attachments on the series; images
 * referenced by a segment go on that day's event. Everything commits through
 * gitsheets on a branch of the data repo for review.
 *
 *   npx tsx scripts/backfill-laddr-events.ts <bare-gitdir> <json-dir> \
 *     [--branch events-backfill] [--parent refs/remotes/origin/published] \
 *     [--host codeforphilly.live.k8s.phl.io]
 *
 * The branch is created from `--parent` on first run (raw git, like the
 * importer); later runs commit on top of it, matching series by slug and
 * events by (series, day) so re-running updates rather than duplicates.
 * Push it and open a PR into `published` — the script never moves HEAD or
 * pushes. The parent must already carry the events sheet configs.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { uuidv7 } from "uuidv7";
import {
  EventSchema,
  EventSeriesSchema,
  type Event,
  type EventAgendaItem,
  type EventSeries,
} from "@cfp/shared/schemas";

import { nyDateString } from "../src/lib/event-time.js";
import { MARKDOWN_UPSERT, partitionYear } from "../src/services/event.write.js";
import { openPublicStore } from "../src/store/public.js";

const exec = promisify(execFile);

interface LaddrEvent {
  ID: number;
  Handle: string;
  Title: string;
  Status: string;
  StartTime: number;
  EndTime: number | null;
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
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")),
);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const [gitDir, jsonDir] = positional;
if (!gitDir || !jsonDir) {
  console.error(
    "usage: backfill-laddr-events.ts <bare-gitdir> <json-dir> [--branch b] [--parent ref] [--host h]",
  );
  process.exit(2);
}
const BRANCH = flag("branch", "events-backfill");
const PARENT = flag("parent", "refs/remotes/origin/published");
const HOST = flag("host", "codeforphilly.live.k8s.phl.io");
const AUTHOR = {
  name: "Code for Philly API",
  email: "api@users.noreply.codeforphilly.org",
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();

/**
 * laddr stored CRLF line endings and its renderer accepted `###Heading`
 * with no space, which GFM shows literally; records keep LF and a space.
 */
const lf = (text: string): string =>
  text.replace(/\r\n?/g, "\n").replace(/^(#{1,6})(?=[^#\s])/gm, "$1 ");

/** laddr venue placeholders that were never filled in. */
const VENUE_PLACEHOLDER_RE = /to be announced|\bTBA\b|\bTBD\b/i;

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

async function captureMedia(
  mediaId: number,
  cache: Map<number, Captured>,
): Promise<Captured> {
  const hit = cache.get(mediaId);
  if (hit) return hit;
  const res = await fetch(`https://${HOST}/media/${mediaId}/original`, {
    headers: { "user-agent": "codeforphilly-ng backfill-laddr-events" },
  });
  if (!res.ok) throw new Error(`media ${mediaId}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  const ext = type.includes("png")
    ? "png"
    : type.includes("gif")
      ? "gif"
      : type.includes("webp")
        ? "webp"
        : type.includes("svg")
          ? "svg"
          : "jpg";
  const captured = {
    filename: `media-${mediaId}.${ext}`,
    bytes: Buffer.from(await res.arrayBuffer()),
  };
  cache.set(mediaId, captured);
  return captured;
}

/**
 * Rewrite laddr media URLs in `text` to attachment URLs under `base`
 * (`/api/attachments/<sheet>/<record path>`), collecting the bytes.
 */
async function rewriteMedia(
  text: string,
  base: string,
  cache: Map<number, Captured>,
  collected: Map<string, Buffer>,
): Promise<string> {
  const ids = [...text.matchAll(MEDIA_RE)].map((m) => Number(m[1]));
  for (const id of new Set(ids)) {
    const c = await captureMedia(id, cache);
    collected.set(c.filename, c.bytes);
  }
  return text.replace(
    MEDIA_RE,
    (_full, idStr: string) => `${base}/${cache.get(Number(idStr))!.filename}`,
  );
}

function venueOf(
  s: LaddrSegment,
  warn: (m: string) => void,
): { venueName: string | null; venueAddress: string | null } {
  if (s.LocationName && VENUE_PLACEHOLDER_RE.test(s.LocationName)) {
    warn(
      `segment ${s.Handle}: venue "${s.LocationName}" is a placeholder; dropped`,
    );
    return { venueName: null, venueAddress: null };
  }
  return { venueName: s.LocationName, venueAddress: s.LocationAddress };
}

/** A segment as an agenda item. An implausible end (before the start, or more than a day later) is dropped. */
function agendaItem(
  s: LaddrSegment,
  warn: (m: string) => void,
): EventAgendaItem {
  const startsAt = iso(s.StartTime);
  let endsAt: string | null = s.EndTime ? iso(s.EndTime) : null;
  if (endsAt) {
    const span = Date.parse(endsAt) - Date.parse(startsAt);
    if (span <= 0) {
      warn(`segment ${s.Handle}: EndTime precedes StartTime; dropped`);
      endsAt = null;
    } else if (span > DAY) {
      warn(
        `segment ${s.Handle}: EndTime is ${Math.round(span / DAY)} days after StartTime; dropped`,
      );
      endsAt = null;
    }
  }
  let description =
    [s.Summary, s.Description]
      .filter((x): x is string => !!x && x.trim() !== "")
      .map(lf)
      .join("\n\n") || null;
  if (description && description.length > 2_000) {
    warn(
      `segment ${s.Handle}: description ${description.length} chars; truncated to 2,000`,
    );
    description = `${description.slice(0, 1_990).trimEnd()}…`;
  }
  return {
    startsAt,
    endsAt,
    title: s.Title.slice(0, 120),
    ...venueOf(s, warn),
    description,
  };
}

interface DayPlan {
  readonly date: string;
  readonly segments: LaddrSegment[];
}

/** Group segments by Philadelphia calendar day, in start order (stable within a day). */
function daysOf(segments: LaddrSegment[]): DayPlan[] {
  const sorted = segments
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.StartTime - b.s.StartTime || a.i - b.i)
    .map(({ s }) => s);
  const byDay = new Map<string, LaddrSegment[]>();
  for (const s of sorted) {
    const date = nyDateString(iso(s.StartTime));
    byDay.set(date, [...(byDay.get(date) ?? []), s]);
  }
  return [...byDay.entries()].map(([date, segs]) => ({ date, segments: segs }));
}

interface Translated<T> {
  readonly record: T;
  readonly attachments: Map<string, Buffer>;
}

async function main(): Promise<void> {
  const warnings: string[] = [];
  const all = JSON.parse(
    await readFile(join(jsonDir!, "all.json"), "utf8"),
  ) as { data: LaddrEvent[] };
  const programs = all.data.filter((e) => e.Status === "published");

  const { store, repo } = await openPublicStore(gitDir!);

  // Create the branch from the parent on first run; later runs advance it.
  const ref = `refs/heads/${BRANCH}`;
  if ((await repo.resolveRef(ref)) === null) {
    const start = await repo.resolveRef(PARENT);
    if (start === null)
      throw new Error(
        `cannot create ${ref}: ${PARENT} does not resolve in ${gitDir}`,
      );
    await exec("git", ["update-ref", ref, start, ""], { cwd: gitDir! });
  }

  // Read what the branch already holds inside a no-op transaction parented on it.
  let existingSeries: EventSeries[] = [];
  let existingEvents: Event[] = [];
  await store.transact(
    { parent: ref, message: "read", author: AUTHOR },
    async (tx) => {
      existingSeries = await tx["event-series"].queryAll();
      existingEvents = await tx.events.queryAll();
    },
  );

  const mediaCache = new Map<number, Captured>();
  const seriesOut: Translated<EventSeries>[] = [];
  const eventsOut: Translated<Event>[] = [];
  const summary: Array<{
    series: string;
    days: Array<{
      slug: string;
      title: string;
      startsAt: string;
      endsAt: string;
      venue: string | null;
      agenda: number;
    }>;
  }> = [];

  for (const p of programs) {
    const warn = (m: string): void => {
      warnings.push(`${p.Handle}: ${m}`);
    };
    const slug = p.Handle.toLowerCase();
    const segments = (
      JSON.parse(
        await readFile(join(jsonDir!, `segments-${p.Handle}.json`), "utf8"),
      ) as { data: LaddrSegment[] }
    ).data;

    // --- the program as a series -------------------------------------------
    const seriesAttachments = new Map<string, Buffer>();
    const description = p.Description
      ? await rewriteMedia(
          lf(p.Description),
          `/api/attachments/event-series/${slug}`,
          mediaCache,
          seriesAttachments,
        )
      : null;
    const existing = existingSeries.find((s) => s.slug === slug);
    const series: EventSeries = EventSeriesSchema.parse({
      ...existing,
      id: existing?.id ?? uuidv7(),
      slug,
      title: p.Title.slice(0, 120),
      description,
      createdAt: existing?.createdAt ?? iso(p.Created),
      updatedAt: p.Modified ? iso(p.Modified) : iso(p.Created),
    });
    seriesOut.push({ record: series, attachments: seriesAttachments });

    // --- each day of segments as an event ----------------------------------
    const existingDays = new Map(
      existingEvents
        .filter((e) => e.seriesId === series.id)
        .map((e) => [nyDateString(e.startsAt), e]),
    );
    const days: (typeof summary)[number]["days"] = [];
    for (const day of daysOf(segments)) {
      const eventSlug = `${day.date}-${slug}`;
      const first = day.segments[0]!;
      const items = day.segments.map((s) => agendaItem(s, warn));
      const startsAt = items[0]!.startsAt;
      // The day runs from its first start to its last end. An item with no
      // end ("Doors close", "Dinner is served") marks a moment, not a span,
      // so it only extends the day to its own start; a day with nothing
      // after its first start lasts an hour.
      const endsAt = items
        .map((it) => it.endsAt ?? it.startsAt)
        .concat(new Date(Date.parse(startsAt) + HOUR).toISOString())
        .reduce((max, end) => (end > max ? end : max));
      const venueSeg = day.segments.find(
        (s) => s.LocationName && !VENUE_PLACEHOLDER_RE.test(s.LocationName),
      );
      const venue = venueSeg
        ? venueOf(venueSeg, () => undefined)
        : { venueName: null, venueAddress: null };
      const existingDay = existingDays.get(day.date);
      const year = partitionYear(startsAt);
      const eventAttachments = new Map<string, Buffer>();
      for (const it of items) {
        // An agenda venue is an override (a room, a nearby spot); laddr
        // repeated the day's venue on every segment, which is no override.
        if (
          it.venueName === venue.venueName &&
          it.venueAddress === venue.venueAddress
        ) {
          it.venueName = null;
          it.venueAddress = null;
        }
        if (it.description) {
          it.description = await rewriteMedia(
            it.description,
            `/api/attachments/events/${year}/${eventSlug}`,
            mediaCache,
            eventAttachments,
          );
        }
      }
      const record: Event = EventSchema.parse({
        ...existingDay,
        id: existingDay?.id ?? uuidv7(),
        slug: eventSlug,
        title: first.Title.slice(0, 200),
        description: null,
        startsAt,
        endsAt,
        ...venue,
        seriesId: series.id,
        agenda: items,
        status: "scheduled",
        icsSequence: existingDay?.icsSequence ?? 0,
        createdAt: existingDay?.createdAt ?? iso(p.Created),
        updatedAt: p.Modified ? iso(p.Modified) : iso(p.Created),
      });
      eventsOut.push({ record, attachments: eventAttachments });
      days.push({
        slug: eventSlug,
        title: record.title,
        startsAt,
        endsAt,
        venue: venue.venueName,
        agenda: items.length,
      });
    }
    summary.push({ series: slug, days });
  }

  const result = await store.transact(
    {
      parent: ref,
      branch: ref,
      message: `events: backfill ${seriesOut.length} laddr programs as series (${eventsOut.length} events)`,
      author: AUTHOR,
      trailers: { Action: "events.backfill-laddr", "Source-Host": HOST },
    },
    async (tx) => {
      for (const { record, attachments } of seriesOut) {
        if (attachments.size > 0)
          await tx["event-series"].setAttachments(
            record,
            Object.fromEntries(attachments),
          );
        await tx["event-series"].upsert(record, MARKDOWN_UPSERT);
      }
      for (const { record, attachments } of eventsOut) {
        if (attachments.size > 0)
          await tx.events.setAttachments(
            record,
            Object.fromEntries(attachments),
          );
        await tx.events.upsert(record, MARKDOWN_UPSERT);
      }
    },
  );

  console.log(
    JSON.stringify(
      {
        branch: ref,
        parent: PARENT,
        commit: result.commitHash,
        series: seriesOut.map((s) => ({
          slug: s.record.slug,
          existing: existingSeries.some((e) => e.id === s.record.id),
          attachments: [...s.attachments.keys()],
        })),
        programs: summary,
        warnings,
      },
      null,
      2,
    ),
  );
}

await main();
