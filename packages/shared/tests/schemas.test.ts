import { describe, expect, it } from 'vitest';

import {
  BlogPostSchema,
  HelpWantedInterestExpressionSchema,
  HelpWantedRoleSchema,
  LegacyPasswordCredentialSchema,
  PersonSchema,
  PrivateProfileSchema,
  ProjectBuzzSchema,
  ProjectMembershipSchema,
  ProjectSchema,
  ProjectUpdateSchema,
  RevocationSchema,
  SlugHistorySchema,
  TagAssignmentSchema,
  TagSchema,
} from '../src/schemas/index.js';

// Shared fixtures
const now = '2026-05-16T00:00:00Z';
const uuid = '01951a3c-0000-7000-8000-000000000001';
const uuid2 = '01951a3c-0000-7000-8000-000000000002';

describe('PersonSchema', () => {
  it('accepts a valid person', () => {
    const result = PersonSchema.safeParse({
      id: uuid,
      slug: 'janedoe',
      fullName: 'Jane Doe',
      accountLevel: 'user',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing fullName', () => {
    const result = PersonSchema.safeParse({
      id: uuid,
      slug: 'janedoe',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid slug (uppercase)', () => {
    const result = PersonSchema.safeParse({
      id: uuid,
      slug: 'Jane-Doe',
      fullName: 'Jane Doe',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid githubLogin (starts with hyphen)', () => {
    const result = PersonSchema.safeParse({
      id: uuid,
      slug: 'janedoe',
      fullName: 'Jane Doe',
      githubLogin: '-janedoe',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional nullable fields as absent', () => {
    const result = PersonSchema.safeParse({
      id: uuid,
      slug: 'janedoe',
      fullName: 'Jane Doe',
      bio: null,
      firstName: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });
});

describe('ProjectSchema', () => {
  it('accepts a valid project', () => {
    const result = ProjectSchema.safeParse({
      id: uuid,
      slug: 'my-project',
      title: 'My Project',
      stage: 'bootstrapping',
      featured: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects featured project without summary and featuredImageKey', () => {
    const result = ProjectSchema.safeParse({
      id: uuid,
      slug: 'my-project',
      title: 'My Project',
      stage: 'bootstrapping',
      featured: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('accepts featured project with required fields', () => {
    const result = ProjectSchema.safeParse({
      id: uuid,
      slug: 'my-project',
      title: 'My Project',
      stage: 'bootstrapping',
      featured: true,
      summary: 'Short tagline',
      featuredImageKey: 'projects/my-project/hero.jpg',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid slug (too short)', () => {
    const result = ProjectSchema.safeParse({
      id: uuid,
      slug: 'a',
      title: 'A',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('ProjectMembershipSchema', () => {
  it('accepts a valid membership', () => {
    const result = ProjectMembershipSchema.safeParse({
      id: uuid,
      projectId: uuid,
      personId: uuid2,
      isMaintainer: false,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing projectId', () => {
    const result = ProjectMembershipSchema.safeParse({
      id: uuid,
      personId: uuid2,
      isMaintainer: false,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('ProjectUpdateSchema', () => {
  it('accepts a valid update', () => {
    const result = ProjectUpdateSchema.safeParse({
      id: uuid,
      projectId: uuid,
      body: '# Hello\n\nSome update text.',
      number: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty body', () => {
    const result = ProjectUpdateSchema.safeParse({
      id: uuid,
      projectId: uuid,
      body: '',
      number: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('BlogPostSchema', () => {
  const baseBlogPost = {
    id: uuid,
    slug: 'civic-tech-roundup-2026',
    title: 'Civic Tech Roundup, May 2026',
    postedAt: now,
    body: '# Hello\n\nA blog post body.',
    createdAt: now,
    updatedAt: now,
  };

  it('accepts a minimal valid post', () => {
    const result = BlogPostSchema.safeParse(baseBlogPost);
    expect(result.success).toBe(true);
  });

  it('accepts an empty body (drafts arriving from the importer)', () => {
    const result = BlogPostSchema.safeParse({ ...baseBlogPost, body: '' });
    expect(result.success).toBe(true);
  });

  it('accepts full optional fields', () => {
    const result = BlogPostSchema.safeParse({
      ...baseBlogPost,
      legacyId: 42,
      summary: 'A short blurb.',
      authorId: uuid2,
      editedAt: now,
      featuredImageKey: 'blog-posts/civic-tech-roundup-2026/cover.jpg',
      deletedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty title', () => {
    const result = BlogPostSchema.safeParse({ ...baseBlogPost, title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long title', () => {
    const result = BlogPostSchema.safeParse({
      ...baseBlogPost,
      title: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long summary', () => {
    const result = BlogPostSchema.safeParse({
      ...baseBlogPost,
      summary: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe('ProjectBuzzSchema', () => {
  it('accepts a valid buzz item', () => {
    const result = ProjectBuzzSchema.safeParse({
      id: uuid,
      projectId: uuid,
      slug: 'great-article',
      headline: 'Great Article',
      url: 'https://example.com/great-article',
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('accepts http:// urls (legacy press links)', () => {
    const result = ProjectBuzzSchema.safeParse({
      id: uuid,
      projectId: uuid,
      slug: 'great-article',
      headline: 'Great Article',
      url: 'http://example.com/great-article',
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed urls', () => {
    const result = ProjectBuzzSchema.safeParse({
      id: uuid,
      projectId: uuid,
      slug: 'great-article',
      headline: 'Great Article',
      url: 'not a url',
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('TagSchema', () => {
  it('accepts a valid tag', () => {
    const result = TagSchema.safeParse({
      id: uuid,
      namespace: 'topic',
      slug: 'transit',
      title: 'Transit',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid namespace', () => {
    const result = TagSchema.safeParse({
      id: uuid,
      namespace: 'random',
      slug: 'transit',
      title: 'Transit',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('TagAssignmentSchema', () => {
  it('accepts a valid tag assignment', () => {
    const result = TagAssignmentSchema.safeParse({
      id: uuid,
      tagId: uuid,
      taggableType: 'project',
      taggableId: uuid2,
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid taggableType', () => {
    const result = TagAssignmentSchema.safeParse({
      id: uuid,
      tagId: uuid,
      taggableType: 'organization',
      taggableId: uuid2,
      createdAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('HelpWantedRoleSchema', () => {
  it('accepts a valid role', () => {
    const result = HelpWantedRoleSchema.safeParse({
      id: uuid,
      projectId: uuid,
      postedById: uuid2,
      title: 'Backend Developer',
      description: 'We need a backend developer.',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects title exceeding 120 chars', () => {
    const result = HelpWantedRoleSchema.safeParse({
      id: uuid,
      projectId: uuid,
      postedById: uuid2,
      title: 'x'.repeat(121),
      description: 'Description.',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('HelpWantedInterestExpressionSchema', () => {
  it('accepts a valid interest expression', () => {
    const result = HelpWantedInterestExpressionSchema.safeParse({
      id: uuid,
      roleId: uuid,
      personId: uuid2,
      createdAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects message exceeding 2000 chars', () => {
    const result = HelpWantedInterestExpressionSchema.safeParse({
      id: uuid,
      roleId: uuid,
      personId: uuid2,
      message: 'x'.repeat(2001),
      createdAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('SlugHistorySchema', () => {
  it('accepts a valid slug history entry', () => {
    const result = SlugHistorySchema.safeParse({
      id: uuid,
      entityType: 'project',
      oldSlug: 'old-slug',
      newSlug: 'new-slug',
      entityId: uuid2,
      changedAt: now,
      expiresAt: '2026-08-14T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid entityType', () => {
    const result = SlugHistorySchema.safeParse({
      id: uuid,
      entityType: 'comment',
      oldSlug: 'old-slug',
      newSlug: 'new-slug',
      entityId: uuid2,
      changedAt: now,
      expiresAt: '2026-08-14T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('RevocationSchema', () => {
  it('accepts a valid revocation', () => {
    const result = RevocationSchema.safeParse({
      jti: 'some-jwt-id-abc123',
      personId: uuid,
      revokedAt: now,
      expiresAt: '2026-06-16T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing jti', () => {
    const result = RevocationSchema.safeParse({
      personId: uuid,
      revokedAt: now,
      expiresAt: '2026-06-16T00:00:00Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('PrivateProfileSchema', () => {
  it('accepts a valid private profile', () => {
    const result = PrivateProfileSchema.safeParse({
      personId: uuid,
      email: 'Jane@Example.COM',
      emailRefreshedAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(true);
    // email is lowercased by the schema transform
    if (result.success) {
      expect(result.data.email).toBe('jane@example.com');
    }
  });

  it('rejects invalid email', () => {
    const result = PrivateProfileSchema.safeParse({
      personId: uuid,
      email: 'not-an-email',
      emailRefreshedAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid unsubscribeToken', () => {
    const result = PrivateProfileSchema.safeParse({
      personId: uuid,
      email: 'jane@example.com',
      emailRefreshedAt: now,
      newsletter: { optedIn: true, unsubscribeToken: 'too-short' },
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('LegacyPasswordCredentialSchema', () => {
  it('accepts a valid legacy credential', () => {
    const result = LegacyPasswordCredentialSchema.safeParse({
      personId: uuid,
      passwordHash: '$2y$10$someHashHere',
      importedAt: now,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing passwordHash', () => {
    const result = LegacyPasswordCredentialSchema.safeParse({
      personId: uuid,
      importedAt: now,
    });
    expect(result.success).toBe(false);
  });
});
