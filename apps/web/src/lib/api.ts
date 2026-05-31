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
  /** Public slack handle; renders as a DM link when present. */
  readonly slackHandle: string | null;
  /** Set for self + staff callers per specs/screens/person-detail.md. */
  readonly email: string | null;
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

export interface BlogPostResponse {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly author: PersonAvatar | null;
  readonly postedAt: string;
  readonly editedAt: string | null;
  readonly featuredImageKey: string | null;
  readonly featuredImageUrl: string | null;
  readonly body: string;
  readonly bodyHtml: string;
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
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined ?? {}),
  };
  // Send JSON content-type when we have a string/blob-less body and no explicit override
  if (
    init?.body !== undefined &&
    init.body !== null &&
    typeof init.body === 'string' &&
    headers['Content-Type'] === undefined &&
    headers['content-type'] === undefined
  ) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
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

export interface ProjectTagsInput {
  topic?: string[];
  tech?: string[];
  event?: string[];
}

export interface PersonTagsInput {
  topic?: string[];
  tech?: string[];
}

export interface CreateProjectInput {
  title: string;
  slug?: string;
  summary?: string | null;
  overview?: string | null;
  stage?: string;
  usersUrl?: string | null;
  developersUrl?: string | null;
  chatChannel?: string | null;
  tags?: ProjectTagsInput;
  featured?: boolean;
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export interface UpdatePersonInput {
  fullName?: string;
  firstName?: string | null;
  lastName?: string | null;
  bio?: string | null;
  slug?: string;
  email?: string;
  slackHandle?: string | null;
  tags?: PersonTagsInput;
}

export interface CreateUpdateInput {
  body: string;
}

export interface CreateBuzzInput {
  headline: string;
  url: string;
  publishedAt: string;
  summary?: string | null;
}

export interface CreateHelpWantedInput {
  title: string;
  description: string;
  commitmentHoursPerWeek?: number | null;
  tags?: { tech?: string[]; topic?: string[] };
}

export type UpdateHelpWantedInput = Partial<CreateHelpWantedInput>;

export interface AddMemberInput {
  personSlug: string;
  role?: string | null;
}

export interface UpdateMembershipInput {
  role?: string | null;
}

export interface ExpressInterestInput {
  message?: string | null;
}

export interface SessionListItem {
  jti: string;
  userAgent: string;
  ipAddress: string;
  issuedAt: string;
  expiresAt: string;
  current: boolean;
}

export interface NewsletterState {
  optedIn: boolean;
  optedInAt: string | null;
  optedOutAt: string | null;
}

export interface NewsletterResponse {
  personId: string;
  newsletter: NewsletterState | null;
}

export interface AccountClaimCandidate {
  readonly personId: string;
  readonly slug: string;
  readonly fullName: string;
  readonly memberOfCount: number;
  readonly lastActiveAt: string;
  readonly matchedVia: ReadonlyArray<'email' | 'username'>;
  readonly matchedEmail: string | null;
}

export interface AccountClaimCandidatesPayload {
  readonly ghLogin: string;
  readonly ghName: string | null;
  readonly candidates: AccountClaimCandidate[];
}

export interface AccountClaimSessionResult {
  readonly person: PersonDetail;
  readonly accountLevel: 'user' | 'staff' | 'administrator';
}

export interface AccountClaimQueueItem {
  readonly requestId: string;
  readonly type: 'pre-onboarding' | 'post-onboarding-merge';
  readonly claimedSlug: string;
  readonly claimedPersonId: string | null;
  readonly requesterGithubLogin: string;
  readonly requesterPersonId: string | null;
  readonly evidence: string;
  readonly submittedAt: string;
}

export interface AccountClaimDecision {
  readonly requestId: string;
  readonly status: 'open' | 'approved' | 'denied';
  readonly person?: PersonDetail | null;
}

export interface CreateTagInput {
  namespace: 'topic' | 'tech' | 'event';
  slug: string;
  title: string;
}

export interface UpdateTagInput {
  title?: string;
  mergeInto?: string;
}

export const api = {
  preview: (source: string): Promise<SuccessEnvelope<{ html: string }>> =>
    request(`/api/_preview`, {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),
  projects: {
    list: (params: ProjectListParams = {}): Promise<PaginatedEnvelope<ProjectListItem>> =>
      request(`/api/projects${buildQuery(params)}`),
    get: (slug: string): Promise<SuccessEnvelope<ProjectDetail>> =>
      request(`/api/projects/${encodeURIComponent(slug)}`),
    create: (input: CreateProjectInput): Promise<SuccessEnvelope<ProjectDetail>> =>
      request(`/api/projects`, { method: 'POST', body: JSON.stringify(input) }),
    update: (slug: string, input: UpdateProjectInput): Promise<SuccessEnvelope<ProjectDetail>> =>
      request(`/api/projects/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    delete: (slug: string): Promise<void> =>
      request(`/api/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
    restore: (slug: string): Promise<SuccessEnvelope<ProjectDetail>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/restore`, { method: 'POST' }),
    changeMaintainer: (slug: string, personSlug: string): Promise<SuccessEnvelope<ProjectDetail>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/change-maintainer`, {
        method: 'POST',
        body: JSON.stringify({ personSlug }),
      }),
    updates: (slug: string, params: { page?: number; perPage?: number } = {}): Promise<PaginatedEnvelope<ProjectUpdateResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/updates${buildQuery(params)}`),
    postUpdate: (slug: string, input: CreateUpdateInput): Promise<SuccessEnvelope<ProjectUpdateResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/updates`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    buzz: (slug: string, params: { page?: number; perPage?: number } = {}): Promise<PaginatedEnvelope<ProjectBuzzResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/buzz${buildQuery(params)}`),
    postBuzz: (slug: string, input: CreateBuzzInput): Promise<SuccessEnvelope<ProjectBuzzResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/buzz`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    helpWanted: (slug: string, params: { status?: string; page?: number; perPage?: number } = {}): Promise<PaginatedEnvelope<HelpWantedRoleResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/help-wanted${buildQuery(params)}`),
    postHelpWanted: (slug: string, input: CreateHelpWantedInput): Promise<SuccessEnvelope<HelpWantedRoleResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/help-wanted`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    addMember: (slug: string, input: AddMemberInput): Promise<SuccessEnvelope<ProjectMembershipResponse>> =>
      request(`/api/projects/${encodeURIComponent(slug)}/members`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    updateMember: (slug: string, personSlug: string, input: UpdateMembershipInput): Promise<SuccessEnvelope<ProjectMembershipResponse>> =>
      request(
        `/api/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(personSlug)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    removeMember: (slug: string, personSlug: string): Promise<void> =>
      request(
        `/api/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(personSlug)}`,
        { method: 'DELETE' },
      ),
  },
  helpWantedRole: {
    update: (
      projectSlug: string,
      roleId: string,
      input: UpdateHelpWantedInput,
    ): Promise<SuccessEnvelope<HelpWantedRoleResponse>> =>
      request(
        `/api/projects/${encodeURIComponent(projectSlug)}/help-wanted/${encodeURIComponent(roleId)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      ),
    expressInterest: (
      projectSlug: string,
      roleId: string,
      input: ExpressInterestInput,
    ): Promise<SuccessEnvelope<{ delivered: boolean }>> =>
      request(
        `/api/projects/${encodeURIComponent(projectSlug)}/help-wanted/${encodeURIComponent(roleId)}/express-interest`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    fill: (
      projectSlug: string,
      roleId: string,
      filledBySlug?: string | null,
    ): Promise<SuccessEnvelope<HelpWantedRoleResponse>> =>
      request(
        `/api/projects/${encodeURIComponent(projectSlug)}/help-wanted/${encodeURIComponent(roleId)}/fill`,
        { method: 'POST', body: JSON.stringify({ filledBySlug: filledBySlug ?? null }) },
      ),
    close: (
      projectSlug: string,
      roleId: string,
    ): Promise<SuccessEnvelope<HelpWantedRoleResponse>> =>
      request(
        `/api/projects/${encodeURIComponent(projectSlug)}/help-wanted/${encodeURIComponent(roleId)}/close`,
        { method: 'POST' },
      ),
    reopen: (
      projectSlug: string,
      roleId: string,
    ): Promise<SuccessEnvelope<HelpWantedRoleResponse>> =>
      request(
        `/api/projects/${encodeURIComponent(projectSlug)}/help-wanted/${encodeURIComponent(roleId)}/reopen`,
        { method: 'POST' },
      ),
  },
  people: {
    list: (params: PeopleListParams = {}): Promise<PaginatedEnvelope<PersonListItem>> =>
      request(`/api/people${buildQuery(params)}`),
    get: (slug: string): Promise<SuccessEnvelope<PersonDetail>> =>
      request(`/api/people/${encodeURIComponent(slug)}`),
    update: (slug: string, input: UpdatePersonInput): Promise<SuccessEnvelope<PersonDetail>> =>
      request(`/api/people/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    setNewsletter: (slug: string, optedIn: boolean): Promise<SuccessEnvelope<NewsletterResponse>> =>
      request(`/api/people/${encodeURIComponent(slug)}/newsletter`, {
        method: 'PATCH',
        body: JSON.stringify({ optedIn }),
      }),
  },
  tags: {
    list: (params: TagListParams = {}): Promise<PaginatedEnvelope<TagResponse>> =>
      request(`/api/tags${buildQuery(params)}`),
    get: (handle: string): Promise<SuccessEnvelope<TagResponse>> =>
      request(`/api/tags/${encodeURIComponent(handle)}`),
    create: (input: CreateTagInput): Promise<SuccessEnvelope<TagResponse>> =>
      request(`/api/tags`, { method: 'POST', body: JSON.stringify(input) }),
    update: (handle: string, input: UpdateTagInput): Promise<SuccessEnvelope<TagResponse>> =>
      request(`/api/tags/${encodeURIComponent(handle)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    delete: (handle: string): Promise<void> =>
      request(`/api/tags/${encodeURIComponent(handle)}`, { method: 'DELETE' }),
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
  blogPosts: {
    list: (params: FeedParams = {}): Promise<PaginatedEnvelope<BlogPostResponse>> =>
      request(`/api/blog-posts${buildQuery(params)}`),
    bySlug: (slug: string): Promise<SuccessEnvelope<BlogPostResponse>> =>
      request(`/api/blog-posts/${encodeURIComponent(slug)}`),
  },
  auth: {
    /**
     * Legacy password sign-in. Returns 200 on success; throws ApiError
     * with `code: "invalid_credentials"` on any failure. Per
     * specs/api/auth.md.
     */
    login: (
      usernameOrEmail: string,
      password: string,
    ): Promise<SuccessEnvelope<{ person: PersonDetail }>> =>
      request(`/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ usernameOrEmail, password }),
      }),
    /**
     * Request a password-reset link. Always resolves on 202 regardless
     * of whether an account matched — the server intentionally hides
     * that signal to prevent address enumeration.
     */
    passwordResetRequest: (
      usernameOrEmail: string,
    ): Promise<SuccessEnvelope<{ delivered: boolean }>> =>
      request(`/api/auth/password-reset/request`, {
        method: 'POST',
        body: JSON.stringify({ usernameOrEmail }),
      }),
    /**
     * Confirm a password reset with the token from email + a new password.
     * On success, mints a session and sets cookies (just like /login).
     * Throws ApiError with `code: "invalid_token"` if the token is
     * unknown, expired, or already used.
     */
    passwordResetConfirm: (
      token: string,
      password: string,
    ): Promise<SuccessEnvelope<{ person: PersonDetail }>> =>
      request(`/api/auth/password-reset/confirm`, {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      }),
    sessions: (): Promise<SuccessEnvelope<SessionListItem[]>> => request(`/api/auth/sessions`),
    revokeSession: (jti: string): Promise<void> =>
      request(`/api/auth/sessions/${encodeURIComponent(jti)}/revoke`, { method: 'POST' }),
  },
  accountClaim: {
    candidates: (): Promise<SuccessEnvelope<AccountClaimCandidatesPayload>> =>
      request(`/api/account-claim/candidates`),
    confirm: (personId: string): Promise<SuccessEnvelope<AccountClaimSessionResult>> =>
      request(`/api/account-claim/confirm`, {
        method: 'POST',
        body: JSON.stringify({ personId }),
      }),
    decline: (): Promise<SuccessEnvelope<AccountClaimSessionResult>> =>
      request(`/api/account-claim/decline`, { method: 'POST', body: '{}' }),
    byPassword: (
      slug: string,
      password: string,
    ): Promise<SuccessEnvelope<AccountClaimSessionResult>> =>
      request(`/api/account-claim/by-password`, {
        method: 'POST',
        body: JSON.stringify({ slug, password }),
      }),
    requestStaffReview: (
      claimedSlug: string,
      evidence: string,
    ): Promise<SuccessEnvelope<{ delivered: boolean }>> =>
      request(`/api/account-claim/request-staff-review`, {
        method: 'POST',
        body: JSON.stringify({ claimedSlug, evidence }),
      }),
    legacySearch: (
      q: string,
    ): Promise<SuccessEnvelope<{ candidates: AccountClaimCandidate[] }>> =>
      request(`/api/account-claim/legacy${buildQuery({ q })}`),
    legacyRequest: (
      claimedSlug: string,
      evidence: string,
    ): Promise<SuccessEnvelope<{ delivered: boolean }>> =>
      request(`/api/account-claim/legacy/request`, {
        method: 'POST',
        body: JSON.stringify({ claimedSlug, evidence }),
      }),
  },
  staffAccountClaim: {
    queue: (): Promise<SuccessEnvelope<AccountClaimQueueItem[]>> =>
      request(`/api/staff/account-claim/queue`),
    approve: (
      requestId: string,
      reason?: string,
    ): Promise<SuccessEnvelope<AccountClaimDecision>> =>
      request(`/api/staff/account-claim/${encodeURIComponent(requestId)}/approve`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    deny: (
      requestId: string,
      reason?: string,
    ): Promise<SuccessEnvelope<AccountClaimDecision>> =>
      request(`/api/staff/account-claim/${encodeURIComponent(requestId)}/deny`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
  },
};
