/**
 * Typed API fetcher.
 *
 * Calls the read API and unwraps the standard response envelope per
 * specs/api/conventions.md. Errors throw an ApiError carrying the status,
 * code, message, and field-level error map.
 */

export interface ResponseMeta {
  readonly timestamp: string;
}

export interface PaginationMeta extends ResponseMeta {
  readonly page: number;
  readonly perPage: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly facets?: Facets;
}

export interface Facets {
  readonly byTopic?: FacetEntry[];
  readonly byTech?: FacetEntry[];
  readonly byEvent?: FacetEntry[];
  readonly byStage?: FacetEntry[];
}

export interface FacetEntry {
  readonly handle?: string;
  readonly title?: string;
  readonly slug?: string;
  readonly namespace?: string;
  readonly stage?: string;
  readonly count: number;
}

export interface SuccessEnvelope<T> {
  readonly success: true;
  readonly data: T;
  readonly metadata: ResponseMeta;
}

export interface PaginatedEnvelope<T> {
  readonly success: true;
  readonly data: T[];
  readonly metadata: PaginationMeta;
}

export interface ErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly traceId?: string;
    readonly fields?: Record<string, string>;
  };
  readonly metadata: ResponseMeta;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly traceId?: string;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>, traceId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.traceId = traceId;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }
}

export interface PersonAvatar {
  readonly slug: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
}

export interface TagItem {
  readonly namespace: string;
  readonly slug: string;
  readonly title: string;
}

export interface ProjectListItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly stage: string;
  readonly overviewExcerpt: string;
  readonly maintainer: PersonAvatar | null;
  readonly memberCount: number;
  readonly members: PersonAvatar[];
  readonly links: {
    readonly usersUrl: string | null;
    readonly developersUrl: string | null;
    readonly chatChannel: string | null;
  };
  readonly openHelpWantedCount: number;
  readonly tags: TagItem[];
  readonly featuredImageUrl?: string | null;
  readonly updatedAt: string;
}

export interface ProjectMembershipResponse {
  readonly id: string;
  readonly projectSlug: string;
  readonly person: PersonAvatar;
  readonly role: string | null;
  readonly isMaintainer: boolean;
  readonly joinedAt: string;
}

export interface ProjectPermissions {
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
  readonly canPostUpdate: boolean;
  readonly canLogBuzz: boolean;
  readonly canPostHelpWanted: boolean;
  readonly canDelete: boolean;
}

export interface HelpWantedRoleSummary {
  readonly id: string;
  readonly title: string;
  readonly commitmentHoursPerWeek: number | null;
  readonly status: string;
  readonly tags: { topic: TagItem[]; tech: TagItem[] };
}

export interface ProjectDetail {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly overview: string | null;
  readonly overviewHtml: string;
  readonly stage: string;
  readonly stageProgress: number;
  readonly maintainer: PersonAvatar | null;
  readonly memberships: ProjectMembershipResponse[];
  readonly openHelpWantedRoles: HelpWantedRoleSummary[];
  readonly tags: { topic: TagItem[]; tech: TagItem[]; event: TagItem[] };
  readonly links: {
    readonly usersUrl: string | null;
    readonly developersUrl: string | null;
    readonly chatChannel: string | null;
  };
  readonly counts: {
    readonly updates: number;
    readonly buzz: number;
    readonly members: number;
  };
  readonly permissions: ProjectPermissions;
  readonly featured: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersonListItem {
  readonly slug: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly bioExcerpt: string;
  readonly memberOfCount: number;
  readonly tags: TagItem[];
  readonly createdAt: string;
}

export interface PersonMembershipSummary {
  readonly project: { readonly slug: string; readonly title: string; readonly stage: string };
  readonly role: string | null;
  readonly isMaintainer: boolean;
  readonly joinedAt: string;
}

export interface ProjectUpdateSummary {
  readonly id: string;
  readonly number: number;
  readonly project: { readonly slug: string; readonly title: string };
  readonly bodyHtml: string;
  readonly createdAt: string;
}

export interface PersonPermissions {
  readonly canEdit: boolean;
  readonly canChangeAccountLevel: boolean;
}

export interface PersonDetail {
  readonly id: string;
  readonly slug: string;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly avatarUrl: string | null;
  readonly bio: string | null;
  readonly bioHtml: string;
  readonly accountLevel: string;
  readonly tags: { topic: TagItem[]; tech: TagItem[] };
  readonly memberships: PersonMembershipSummary[];
  readonly recentUpdates: ProjectUpdateSummary[];
  readonly permissions: PersonPermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TagResponse {
  readonly id: string;
  readonly handle: string;
  readonly namespace: string;
  readonly slug: string;
  readonly title: string;
  readonly projectCount: number;
  readonly personCount: number;
  readonly helpWantedCount: number;
}

export interface HelpWantedPermissions {
  readonly canEdit: boolean;
  readonly canExpressInterest: boolean;
  readonly alreadyExpressedInterest: boolean;
  readonly canFill: boolean;
  readonly canClose: boolean;
}

export interface HelpWantedRoleResponse {
  readonly id: string;
  readonly project: { readonly slug: string; readonly title: string };
  readonly postedBy: PersonAvatar | null;
  readonly title: string;
  readonly description: string;
  readonly descriptionHtml: string;
  readonly commitmentHoursPerWeek: number | null;
  readonly status: string;
  readonly filledBy: PersonAvatar | null;
  readonly filledAt: string | null;
  readonly closedAt: string | null;
  readonly tags: { topic: TagItem[]; tech: TagItem[] };
  readonly interestCount: number;
  readonly permissions: HelpWantedPermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdatePermissions {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface ProjectUpdateResponse {
  readonly id: string;
  readonly number: number;
  readonly project: { readonly slug: string; readonly title: string };
  readonly author: PersonAvatar | null;
  readonly body: string;
  readonly bodyHtml: string;
  readonly permissions: UpdatePermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BuzzPermissions {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface ProjectBuzzResponse {
  readonly id: string;
  readonly slug: string;
  readonly project: { readonly slug: string; readonly title: string };
  readonly postedBy: PersonAvatar | null;
  readonly headline: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly summary: string | null;
  readonly summaryHtml: string;
  readonly imageUrl: string | null;
  readonly permissions: BuzzPermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function buildQuery(params: object): string {
  const usp = new URLSearchParams();
  for (const [key, val] of Object.entries(params as Record<string, unknown>)) {
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val)) {
      for (const v of val) {
        if (v !== undefined && v !== null && v !== '') usp.append(key, String(v));
      }
    } else {
      usp.append(key, String(val));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  // 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, 'invalid_response', `Non-JSON response (${res.status})`);
  }

  if (!res.ok) {
    const err = body as ErrorEnvelope;
    const code = err?.error?.code ?? 'unknown_error';
    const message = err?.error?.message ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, code, message, err?.error?.fields, err?.error?.traceId);
  }

  return body as T;
}

export interface ProjectListParams {
  q?: string;
  stage?: string;
  stageIn?: string;
  tag?: string[];
  maintainer?: string;
  memberSlug?: string;
  helpWanted?: boolean;
  featured?: boolean;
  includeDeleted?: boolean;
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface PeopleListParams {
  q?: string;
  tag?: string[];
  accountLevel?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface TagListParams {
  namespace?: string;
  q?: string;
  taggableType?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface HelpWantedListParams {
  status?: string;
  tag?: string[];
  commitmentMax?: number;
  q?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface FeedParams {
  page?: number;
  perPage?: number;
  since?: string;
  tag?: string[];
}

export const api = {
  projects: {
    list: (params: ProjectListParams = {}): Promise<PaginatedEnvelope<ProjectListItem>> =>
      request(`/api/projects${buildQuery(params)}`),
    get: (slug: string): Promise<SuccessEnvelope<ProjectDetail>> =>
      request(`/api/projects/${encodeURIComponent(slug)}`),
    updates: (slug: string, params: { page?: number; perPage?: number } = {}): Promise<PaginatedEnvelope<ProjectUpdateResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/updates${buildQuery(params)}`),
    buzz: (slug: string, params: { page?: number; perPage?: number } = {}): Promise<PaginatedEnvelope<ProjectBuzzResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/buzz${buildQuery(params)}`),
    helpWanted: (slug: string, params: { status?: string; page?: number; perPage?: number } = {}): Promise<PaginatedEnvelope<HelpWantedRoleResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/help-wanted${buildQuery(params)}`),
  },
  people: {
    list: (params: PeopleListParams = {}): Promise<PaginatedEnvelope<PersonListItem>> =>
      request(`/api/people${buildQuery(params)}`),
    get: (slug: string): Promise<SuccessEnvelope<PersonDetail>> =>
      request(`/api/people/${encodeURIComponent(slug)}`),
  },
  tags: {
    list: (params: TagListParams = {}): Promise<PaginatedEnvelope<TagResponse>> =>
      request(`/api/tags${buildQuery(params)}`),
    get: (handle: string): Promise<SuccessEnvelope<TagResponse>> =>
      request(`/api/tags/${encodeURIComponent(handle)}`),
  },
  helpWanted: {
    list: (params: HelpWantedListParams = {}): Promise<PaginatedEnvelope<HelpWantedRoleResponse>> =>
      request(`/api/help-wanted${buildQuery(params)}`),
  },
  projectUpdates: {
    feed: (params: FeedParams = {}): Promise<PaginatedEnvelope<ProjectUpdateResponse>> =>
      request(`/api/project-updates${buildQuery(params)}`),
  },
  projectBuzz: {
    feed: (params: FeedParams = {}): Promise<PaginatedEnvelope<ProjectBuzzResponse>> =>
      request(`/api/project-buzz${buildQuery(params)}`),
  },
};
