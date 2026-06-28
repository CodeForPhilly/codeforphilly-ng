/**
 * JSON fetcher for laddr's `?format=json` endpoints.
 *
 * Wraps `fetch` with:
 *   - Pagination via `limit` + `offset` (laddr returns `{ total, limit, offset, data }`)
 *   - A small polite delay between requests
 *   - Per-endpoint Zod schemas validating the raw response body (laddr's JSON
 *     output is template-rendered, not a documented contract, so we validate
 *     the shape before passing to translators)
 *   - Optional truncation via `limit` (caller's, not laddr's) for dev loops
 *
 * Endpoints discovered against codeforphilly.org (2026-05-18):
 *
 *   /tags?format=json                  — flat list, 1017 records
 *   /people?format=json                — flat list, ~31k records
 *   /projects?format=json              — flat list, 268 records
 *                                        Use `include=Tags,Memberships` to
 *                                        embed tag + membership joins.
 *   /project-updates?format=json       — flat list, 517 records
 *   /project-buzz?format=json          — flat list, 113 records
 *   /blog?format=json                  — laddr's BlogRequestHandler list endpoint
 *
 * There are no `/project-memberships` or `/tag-assignments` list endpoints;
 * those come from the project-list `include` parameter (memberships) and
 * per-record `include=Tags` expansion (tag assignments on both projects and
 * people).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Raw laddr JSON shapes
// ---------------------------------------------------------------------------

/** Common envelope laddr returns for list endpoints. */
const ListEnvelopeSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    success: z.literal(true),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    // `offset` is either the integer offset or `false` for the first page
    // (laddr's quirky default rendering when no offset query is provided)
    offset: z.union([z.number().int().nonnegative(), z.literal(false)]),
    data: z.array(item),
  });

/**
 * The fields we actually use from each row are tightly typed below; everything
 * else is permitted via `passthrough()` so a laddr template tweak adding a new
 * unrelated field doesn't break the import.
 */

export const RawTagSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    Title: z.string().nullable().optional(),
    Handle: z.string(),
    Description: z.string().nullable().optional(),
    Created: z.number().int().nullable().optional(),
    CreatorID: z.number().int().nullable().optional(),
  })
  .passthrough();
export type RawTag = z.infer<typeof RawTagSchema>;

export const RawPersonSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    Username: z.string().nullable().optional(),
    FirstName: z.string().nullable().optional(),
    LastName: z.string().nullable().optional(),
    PreferredName: z.string().nullable().optional(),
    Location: z.string().nullable().optional(),
    About: z.string().nullable().optional(),
    AccountLevel: z.string().nullable().optional(),
    Newsletter: z.union([z.boolean(), z.number(), z.string()]).nullable().optional(),
    Twitter: z.string().nullable().optional(),
    /** Emergence Media ID of the person's photo; fetch at `/media/<id>`. */
    PrimaryPhotoID: z.number().int().nullable().optional(),
    Created: z.number().int().nullable().optional(),
    Modified: z.number().int().nullable().optional(),
    /** Present when `?include=Tags` */
    Tags: z.array(RawTagSchema).optional(),
  })
  .passthrough();
export type RawPerson = z.infer<typeof RawPersonSchema>;

export const RawMembershipSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    ProjectID: z.number().int().positive(),
    MemberID: z.number().int().positive(),
    Role: z.string().nullable().optional(),
    Created: z.number().int().nullable().optional(),
  })
  .passthrough();
export type RawMembership = z.infer<typeof RawMembershipSchema>;

export const RawProjectSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    Title: z.string().nullable().optional(),
    Handle: z.string(),
    MaintainerID: z.number().int().nullable().optional(),
    UsersUrl: z.string().nullable().optional(),
    DevelopersUrl: z.string().nullable().optional(),
    README: z.string().nullable().optional(),
    Stage: z.string().nullable().optional(),
    ChatChannel: z.string().nullable().optional(),
    NextUpdate: z.number().int().nullable().optional(),
    Created: z.number().int().nullable().optional(),
    Modified: z.number().int().nullable().optional(),
    /** Present when `?include=Tags` */
    Tags: z.array(RawTagSchema).optional(),
    /** Present when `?include=Memberships` */
    Memberships: z.array(RawMembershipSchema).optional(),
  })
  .passthrough();
export type RawProject = z.infer<typeof RawProjectSchema>;

export const RawProjectUpdateSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    ProjectID: z.number().int().positive(),
    CreatorID: z.number().int().nullable().optional(),
    Number: z.number().int().positive(),
    Body: z.string().nullable().optional(),
    Created: z.number().int().nullable().optional(),
    Modified: z.number().int().nullable().optional(),
  })
  .passthrough();
export type RawProjectUpdate = z.infer<typeof RawProjectUpdateSchema>;

export const RawProjectBuzzSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    ProjectID: z.number().int().positive(),
    CreatorID: z.number().int().nullable().optional(),
    Handle: z.string().nullable().optional(),
    Headline: z.string().nullable().optional(),
    URL: z.string().nullable().optional(),
    Published: z.number().int().nullable().optional(),
    Summary: z.string().nullable().optional(),
    ImageID: z.number().int().nullable().optional(),
    Created: z.number().int().nullable().optional(),
    Modified: z.number().int().nullable().optional(),
  })
  .passthrough();
export type RawProjectBuzz = z.infer<typeof RawProjectBuzzSchema>;

/**
 * One item in a blog post's body. Laddr's `Emergence\CMS\AbstractContent`
 * stores body as an ordered list of typed items rather than a single
 * markdown string. Three item classes appear in production: Markdown
 * (raw markdown), Media (image reference), Embed (raw HTML — iframes etc.).
 *
 * Surfaced only when the request asks `?include=*`.
 */
export const RawBlogPostItemSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    Order: z.number().int().optional(),
    // Markdown items: Data is a string. Media items: Data is an object
    // ({ MediaID, Caption }). Embed items: Data is a string (raw HTML).
    Data: z.unknown().optional(),
  })
  .passthrough();
export type RawBlogPostItem = z.infer<typeof RawBlogPostItemSchema>;

/**
 * Blog post — laddr's `BlogPost` class. The field set is best-effort
 * against laddr's `BlogRequestHandler` template output; unknown fields
 * pass through.
 *
 *   ID, Class, Handle (slug), Title, Summary,
 *   AuthorID, Published (epoch), Modified (epoch), Created (epoch)
 *
 * Body is *not* a top-level field in laddr's JSON. The body content
 * lives in `items` (only surfaced when the request uses `?include=*`)
 * as an ordered list of typed content blocks.
 */
export const RawBlogPostSchema = z
  .object({
    ID: z.number().int().positive(),
    Class: z.string(),
    Handle: z.string().nullable().optional(),
    Title: z.string().nullable().optional(),
    Summary: z.string().nullable().optional(),
    AuthorID: z.number().int().nullable().optional(),
    Published: z.number().int().nullable().optional(),
    Created: z.number().int().nullable().optional(),
    Modified: z.number().int().nullable().optional(),
    /** Present when the request asks `?include=*`. */
    items: z.array(RawBlogPostItemSchema).optional(),
  })
  .passthrough();
export type RawBlogPost = z.infer<typeof RawBlogPostSchema>;

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

export interface FetchOptions {
  /** Source host (no scheme, no trailing slash), e.g. `codeforphilly.org`. */
  readonly host: string;
  /** Used in `User-Agent`; defaults to `cfp-importer/dev`. */
  readonly userAgent?: string;
  /** Per-page record count; default 200. */
  readonly pageSize?: number;
  /** Caller-imposed cap on rows fetched per resource (truncates pagination). */
  readonly limit?: number;
  /** Milliseconds to sleep between page fetches. Default 250. */
  readonly delayMs?: number;
  /** Optional override for `fetch` (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Optional logger; defaults to console-silent. */
  readonly log?: (msg: string) => void;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_USER_AGENT = 'cfp-importer/dev';

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((res) => setTimeout(res, ms));
}

interface PageRequest {
  readonly host: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly userAgent: string;
  readonly fetchImpl: typeof fetch;
}

async function fetchJsonPage(req: PageRequest): Promise<unknown> {
  const url = new URL(`https://${req.host}${req.path}`);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);

  const res = await req.fetchImpl(url.toString(), {
    headers: { 'User-Agent': req.userAgent, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GET ${url.toString()} → ${res.status} ${res.statusText}\n${body.slice(0, 500)}`,
    );
  }
  return res.json();
}

/**
 * Fetch every record from a paginated list endpoint, yielding each row.
 *
 * Pages until either:
 *   - The cumulative row count reaches `opts.limit` (when set)
 *   - The cumulative row count reaches the server's reported `total`
 *   - A response returns zero rows (defensive fallback)
 *
 * Validates each page's envelope and each row against the provided schema.
 */
export async function* fetchAllPages<T>(
  path: string,
  schema: z.ZodTypeAny,
  query: Record<string, string>,
  opts: FetchOptions,
): AsyncGenerator<T> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const limit = opts.limit ?? Infinity;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const log = opts.log ?? (() => {});

  let offset = 0;
  let yielded = 0;

  while (yielded < limit) {
    const body = await fetchJsonPage({
      host: opts.host,
      path,
      query: { ...query, limit: String(pageSize), offset: String(offset) },
      userAgent,
      fetchImpl,
    });
    const envelope = ListEnvelopeSchema(schema).parse(body);
    log(
      `[fetch] ${path} offset=${offset} got=${envelope.data.length} total=${envelope.total}`,
    );

    if (envelope.data.length === 0) return;

    for (const row of envelope.data) {
      if (yielded >= limit) return;
      yield row as T;
      yielded++;
    }

    offset += envelope.data.length;
    if (offset >= envelope.total) return;
    await sleep(delayMs);
  }
}

/**
 * Fetch the count from the first page of a list endpoint without iterating.
 * Used in `--dry-run` to size the work without holding all records.
 */
export async function fetchTotal(
  path: string,
  opts: FetchOptions,
): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const body = await fetchJsonPage({
    host: opts.host,
    path,
    query: { limit: '1', offset: '0' },
    userAgent,
    fetchImpl,
  });
  // Parse with a permissive shape — we only need `total`.
  const totalSchema = z
    .object({ success: z.literal(true), total: z.number().int().nonnegative() })
    .passthrough();
  return totalSchema.parse(body).total;
}
