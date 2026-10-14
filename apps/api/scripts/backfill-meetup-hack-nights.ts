/**
 * Seed the "Monthly Hack Nights" series from Meetup — plans/events-legacy-backfill.md.
 *
 * One-off, re-runnable. Reads a Next.js page-data capture of
 * meetup.com/code-for-philly/events (the JSON the events page requests;
 * its `pageProps.__APOLLO_STATE__` holds one `Event:<id>` entry per listed
 * event plus the `Venue:<id>` entries they reference). Every event on or
 * after `--since` becomes an `events` record in the series: the standing
 * "Code for Philly" prefix comes off the title, the description's
 * "**Agenda:**" block of `6:00-6:15pm - …` lines becomes agenda items and
 * leaves the text, the Meetup venue maps to ours, and `meetupUrl` keeps the
 * link while RSVPs still live there (specs/behaviors/events.md).
 *
 *   npx tsx scripts/backfill-meetup-hack-nights.ts <bare-gitdir> <events.json> \
 *     [--since 2026-09-01] [--branch events-backfill] [--parent refs/remotes/origin/published]
 *
 * The branch is created from `--parent` on first run (raw git, like the
 * importer); later runs commit on top of it, matching the series by slug
 * and events by day. The script never moves HEAD or pushes. The parent must
 * already carry the events sheet configs.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
import { MARKDOWN_UPSERT } from "../src/services/event.write.js";
import { openPublicStore } from "../src/store/public.js";

const exec = promisify(execFile);

interface MeetupVenue {
  name: string;
  address: string;
  city: string;
  state: string;
}

interface MeetupEvent {
  id: string;
  title: string;
  status: string;
  dateTime: string;
  endTime: string | null;
  description: string;
  eventUrl: string;
  createdTime: string;
  isOnline: boolean;
  venue: { __ref: string } | null;
}

const args = process.argv.slice(2);
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")),
);
const flag = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const [gitDir, jsonFile] = positional;
if (!gitDir || !jsonFile) {
  console.error(
    "usage: backfill-meetup-hack-nights.ts <bare-gitdir> <events.json> [--since YYYY-MM-DD] [--branch b] [--parent ref]",
  );
  process.exit(2);
}
const SINCE = flag("since", "2026-09-01");
const BRANCH = flag("branch", "events-backfill");
const PARENT = flag("parent", "refs/remotes/origin/published");
const AUTHOR = {
  name: "Code for Philly API",
  email: "api@users.noreply.codeforphilly.org",
};

const SERIES_SLUG = "monthly-hack-nights";
const SERIES_TITLE = "Monthly Hack Nights";
/** Standing description; curated by hand after the import (plans/events-legacy-backfill.md). */
const SERIES_DESCRIPTION = `Code for Philly meets on the second Tuesday of every month at Indy Hall to work on civic tech projects together. Newcomers are welcome: come meet the project teams, find one that fits your skills, and start contributing.`;

/** Our name and address for the Meetup venues these events used. */
const VENUES: Record<string, { venueName: string; venueAddress: string }> = {
  "Indy Hall Clubhouse at 709 N 2nd St": {
    venueName: "Indy Hall",
    venueAddress: "709 N 2nd St, 3rd Floor, Philadelphia, PA 19123",
  },
};

const iso = (s: string): string => new Date(s).toISOString();

/**
 * One agenda line as Meetup members wrote them: `6:00pm - Doors Open`,
 * `6:15-6:30pm - Announcements`, `6:30-8:30pm - Hack! (Work on projects)`.
 * The meridiem on the end applies to the start too.
 */
const AGENDA_LINE_RE =
  /^(\d{1,2})(?::(\d{2}))?(?:\s*-\s*(\d{1,2})(?::(\d{2}))?)?\s*(am|pm)\s*[-–—]\s*(.+?)\s*$/i;

/** Clock time on the event's own calendar day and UTC offset. */
function atClock(
  dateTime: string,
  hour: number,
  minute: number,
  meridiem: string,
): string {
  const date = dateTime.slice(0, 10);
  const offset = dateTime.slice(19) || "Z";
  let h = hour % 12;
  if (meridiem.toLowerCase() === "pm") h += 12;
  return iso(
    `${date}T${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`,
  );
}

/**
 * Split the "**Agenda:**" block out of a description. Returns the agenda
 * items and the description with the heading and its lines removed.
 */
function extractAgenda(
  description: string,
  dateTime: string,
): { agenda: EventAgendaItem[]; description: string } {
  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) =>
    /^\*{0,2}agenda:?\*{0,2}\s*$/i.test(l.trim()),
  );
  if (start === -1) return { agenda: [], description: description.trim() };
  const agenda: EventAgendaItem[] = [];
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lines[end]!.trim();
    if (line === "") continue;
    const m = AGENDA_LINE_RE.exec(line);
    if (!m) break;
    const [, h1, m1, h2, m2, meridiem, title] = m;
    const startsAt = atClock(dateTime, Number(h1), Number(m1 ?? 0), meridiem!);
    const endsAt = h2
      ? atClock(dateTime, Number(h2), Number(m2 ?? 0), meridiem!)
      : null;
    agenda.push({
      startsAt,
      endsAt: endsAt && endsAt > startsAt ? endsAt : null,
      title: title!.slice(0, 120),
      venueName: null,
      venueAddress: null,
      description: null,
    });
  }
  const rest = [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { agenda, description: rest };
}

async function main(): Promise<void> {
  const warnings: string[] = [];
  const page = JSON.parse(await readFile(jsonFile!, "utf8")) as {
    pageProps: { __APOLLO_STATE__: Record<string, unknown> };
  };
  const state = page.pageProps.__APOLLO_STATE__;
  const venues = new Map<string, MeetupVenue>(
    Object.entries(state)
      .filter(([k]) => k.startsWith("Venue:"))
      .map(([k, v]) => [k, v as MeetupVenue]),
  );
  const meetupEvents = Object.entries(state)
    .filter(([k]) => k.startsWith("Event:"))
    .map(([, v]) => v as MeetupEvent)
    .filter((e) => e.dateTime.slice(0, 10) >= SINCE)
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));
  if (meetupEvents.length === 0)
    throw new Error(`no Meetup events on or after ${SINCE}`);

  const { store, repo } = await openPublicStore(gitDir!);
  const ref = `refs/heads/${BRANCH}`;
  if ((await repo.resolveRef(ref)) === null) {
    const start = await repo.resolveRef(PARENT);
    if (start === null)
      throw new Error(
        `cannot create ${ref}: ${PARENT} does not resolve in ${gitDir}`,
      );
    await exec("git", ["update-ref", ref, start, ""], { cwd: gitDir! });
  }

  let existingSeries: EventSeries[] = [];
  let existingEvents: Event[] = [];
  await store.transact(
    { parent: ref, message: "read", author: AUTHOR },
    async (tx) => {
      existingSeries = await tx["event-series"].queryAll();
      existingEvents = await tx.events.queryAll();
    },
  );

  const now = new Date().toISOString();
  const existing = existingSeries.find((s) => s.slug === SERIES_SLUG);
  const series: EventSeries = EventSeriesSchema.parse({
    ...existing,
    id: existing?.id ?? uuidv7(),
    slug: SERIES_SLUG,
    title: SERIES_TITLE,
    // Hand-curated text on the branch wins over the seed on re-runs.
    description: existing?.description || SERIES_DESCRIPTION,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  });
  const existingDays = new Map(
    existingEvents
      .filter((e) => e.seriesId === series.id)
      .map((e) => [nyDateString(e.startsAt), e]),
  );
  const usedSlugs = new Set(
    existingEvents.filter((e) => e.seriesId !== series.id).map((e) => e.slug),
  );

  const stale: Event[] = [];
  const records: Event[] = [];
  for (const m of meetupEvents) {
    if (m.status !== "ACTIVE" && m.status !== "PAST") {
      warnings.push(`${m.id} ${m.title}: status ${m.status}; skipped`);
      continue;
    }
    const startsAt = iso(m.dateTime);
    const day = nyDateString(startsAt);
    const slug = `${day}-hack-night`;
    if (usedSlugs.has(slug))
      throw new Error(`slug ${slug} is taken outside the series`);
    const venue = m.venue ? venues.get(m.venue.__ref) : undefined;
    const mapped = venue ? VENUES[venue.name] : undefined;
    if (venue && !mapped)
      warnings.push(
        `${m.id}: venue "${venue.name}" has no mapping; used as-is`,
      );
    const { agenda, description } = extractAgenda(m.description, m.dateTime);
    let endsAt = m.endTime
      ? iso(m.endTime)
      : new Date(Date.parse(startsAt) + 2 * 60 * 60 * 1000).toISOString();
    const lastAgendaEnd = agenda
      .map((a) => a.endsAt ?? a.startsAt)
      .sort()
      .at(-1);
    if (lastAgendaEnd && lastAgendaEnd > endsAt) {
      warnings.push(
        `${m.id}: Meetup ends ${endsAt} but the agenda runs to ${lastAgendaEnd}; end extended`,
      );
      endsAt = lastAgendaEnd;
    }
    const prior = existingDays.get(day);
    if (prior && prior.slug !== slug) {
      warnings.push(`${prior.slug} is now ${slug}; old record removed`);
      stale.push(prior);
    }
    records.push(
      EventSchema.parse({
        ...prior,
        id: prior?.id ?? uuidv7(),
        slug,
        title: m.title.replace(/^code for philly\s+/i, "").slice(0, 200),
        description: description || null,
        startsAt,
        endsAt,
        venueName: mapped?.venueName ?? venue?.name ?? null,
        venueAddress:
          mapped?.venueAddress ??
          (venue ? `${venue.address}, ${venue.city}, ${venue.state}` : null),
        onlineUrl: null,
        meetupUrl: m.eventUrl,
        seriesId: series.id,
        agenda,
        status: "scheduled",
        icsSequence: prior?.icsSequence ?? 0,
        createdAt: prior?.createdAt ?? iso(m.createdTime),
        updatedAt: prior?.updatedAt ?? now,
      }),
    );
  }

  const result = await store.transact(
    {
      parent: ref,
      branch: ref,
      message: `events: seed ${SERIES_TITLE} from Meetup (${records.length} events)`,
      author: AUTHOR,
      trailers: {
        Action: "events.backfill-meetup",
        "Source-Host": "www.meetup.com",
      },
    },
    async (tx) => {
      await tx["event-series"].upsert(series, MARKDOWN_UPSERT);
      for (const old of stale) await tx.events.delete(old);
      for (const record of records)
        await tx.events.upsert(record, MARKDOWN_UPSERT);
    },
  );

  console.log(
    JSON.stringify(
      {
        branch: ref,
        commit: result.commitHash,
        series: { slug: series.slug, existing: existing !== undefined },
        events: records.map((r) => ({
          slug: r.slug,
          title: r.title,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          venue: r.venueName,
          agenda: r.agenda?.map(
            (a) =>
              `${a.startsAt.slice(11, 16)}${a.endsAt ? `-${a.endsAt.slice(11, 16)}` : ""} ${a.title}`,
          ),
          description: r.description?.length ?? 0,
          meetupUrl: r.meetupUrl,
        })),
        warnings,
      },
      null,
      2,
    ),
  );
}

await main();
