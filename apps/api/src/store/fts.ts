/**
 * Full-text search engine backed by SQLite FTS5 (in-memory).
 *
 * On boot: all projects and people are inserted.
 * On mutation: the write-api calls invalidate() to upsert/delete a record.
 *
 * The interface is engine-agnostic so callers don't know about SQLite.
 */
import Database from 'better-sqlite3';
import type { InMemoryState } from './memory/state.js';

export interface FtsEngine {
  /** Search projects by query string. Returns slugs in relevance order. */
  searchProjects(q: string): string[];
  /** Search people by query string. Returns slugs in relevance order. */
  searchPeople(q: string): string[];
  /** Search help-wanted roles by query string. Returns IDs in relevance order. */
  searchHelpWanted(q: string): string[];
  /** Upsert a project row (call on mutation). */
  upsertProject(slug: string, title: string, summary: string, overview: string): void;
  /** Remove a project row (call on delete/soft-delete). */
  removeProject(slug: string): void;
  /** Upsert a person row. */
  upsertPerson(slug: string, fullName: string, bio: string): void;
  /** Remove a person row. */
  removePerson(slug: string): void;
  /** Upsert a help-wanted role row. */
  upsertHelpWanted(id: string, title: string, description: string): void;
  /** Remove a help-wanted role row. */
  removeHelpWanted(id: string): void;
}

export function buildFtsEngine(state: InMemoryState): FtsEngine {
  const db = new Database(':memory:');

  db.exec(`
    CREATE VIRTUAL TABLE projects_fts
      USING fts5(slug UNINDEXED, title, summary, overview, tokenize='porter ascii');

    CREATE VIRTUAL TABLE people_fts
      USING fts5(slug UNINDEXED, fullName, bio, tokenize='porter ascii');

    CREATE VIRTUAL TABLE help_wanted_fts
      USING fts5(id UNINDEXED, title, description, tokenize='porter ascii');
  `);

  const stmts = {
    upsertProject: db.prepare(
      `INSERT OR REPLACE INTO projects_fts(slug, title, summary, overview)
       VALUES (?, ?, ?, ?)`,
    ),
    removeProject: db.prepare(`DELETE FROM projects_fts WHERE slug = ?`),
    searchProjects: db.prepare(
      `SELECT slug FROM projects_fts
       WHERE projects_fts MATCH ?
       ORDER BY rank
       LIMIT 1000`,
    ),

    upsertPerson: db.prepare(
      `INSERT OR REPLACE INTO people_fts(slug, fullName, bio)
       VALUES (?, ?, ?)`,
    ),
    removePerson: db.prepare(`DELETE FROM people_fts WHERE slug = ?`),
    searchPeople: db.prepare(
      `SELECT slug FROM people_fts
       WHERE people_fts MATCH ?
       ORDER BY rank
       LIMIT 1000`,
    ),

    upsertHelpWanted: db.prepare(
      `INSERT OR REPLACE INTO help_wanted_fts(id, title, description)
       VALUES (?, ?, ?)`,
    ),
    removeHelpWanted: db.prepare(`DELETE FROM help_wanted_fts WHERE id = ?`),
    searchHelpWanted: db.prepare(
      `SELECT id FROM help_wanted_fts
       WHERE help_wanted_fts MATCH ?
       ORDER BY rank
       LIMIT 1000`,
    ),
  };

  // Bulk-insert all current records
  const insertAllProjects = db.transaction(() => {
    for (const project of state.projects.values()) {
      if (project.deletedAt) continue;
      stmts.upsertProject.run(
        project.slug,
        project.title,
        project.summary ?? '',
        project.overview ?? '',
      );
    }
  });

  const insertAllPeople = db.transaction(() => {
    for (const person of state.people.values()) {
      if (person.deletedAt) continue;
      stmts.upsertPerson.run(person.slug, person.fullName, person.bio ?? '');
    }
  });

  const insertAllHelpWanted = db.transaction(() => {
    for (const role of state.helpWantedRoles.values()) {
      stmts.upsertHelpWanted.run(role.id, role.title, role.description);
    }
  });

  insertAllProjects();
  insertAllPeople();
  insertAllHelpWanted();

  return {
    searchProjects(q: string): string[] {
      try {
        const rows = stmts.searchProjects.all(sanitizeFtsQuery(q)) as { slug: string }[];
        return rows.map((r) => r.slug);
      } catch {
        return [];
      }
    },
    searchPeople(q: string): string[] {
      try {
        const rows = stmts.searchPeople.all(sanitizeFtsQuery(q)) as { slug: string }[];
        return rows.map((r) => r.slug);
      } catch {
        return [];
      }
    },
    searchHelpWanted(q: string): string[] {
      try {
        const rows = stmts.searchHelpWanted.all(sanitizeFtsQuery(q)) as { id: string }[];
        return rows.map((r) => r.id);
      } catch {
        return [];
      }
    },
    upsertProject(slug, title, summary, overview) {
      stmts.upsertProject.run(slug, title, summary, overview);
    },
    removeProject(slug) {
      stmts.removeProject.run(slug);
    },
    upsertPerson(slug, fullName, bio) {
      stmts.upsertPerson.run(slug, fullName, bio);
    },
    removePerson(slug) {
      stmts.removePerson.run(slug);
    },
    upsertHelpWanted(id, title, description) {
      stmts.upsertHelpWanted.run(id, title, description);
    },
    removeHelpWanted(id) {
      stmts.removeHelpWanted.run(id);
    },
  };
}

/**
 * Sanitize a user query string so it doesn't cause SQLite FTS5 syntax errors.
 * Wraps each word in double-quotes to treat them as exact phrases, then ANDs them.
 */
function sanitizeFtsQuery(q: string): string {
  const words = q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`);
  return words.join(' ');
}
