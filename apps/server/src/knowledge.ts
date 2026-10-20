import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError } from './errors.js';

type Row = Record<string, unknown>;
import type { KnowledgeNote, KnowledgeSearchHit } from '@personal-agent/contracts';
export type { KnowledgeNote, KnowledgeSearchHit } from '@personal-agent/contracts';
export interface CreateKnowledgeInput { title: string; body: string; source?: string | null }
export interface ReviseKnowledgeInput extends CreateKnowledgeInput { expectedRevision: number }

const noNul = (text: string) => !text.includes('\0');
const Title = z.string().trim().min(1).max(100).refine(noNul);
const Body = z.string().min(1).max(32000).refine(text => text.trim().length > 0 && noNul(text));
const Source = z.string().max(2000).refine(noNul).nullable().optional();
const CreateInput = z.object({ title: Title, body: Body, source: Source }).strict();
const ReviseInput = CreateInput.extend({ expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
const Id = z.uuid();
const Query = z.string().trim().max(2000).refine(noNul);
const Limit = z.number().int().min(1).max(100);
const stamp = () => new Date().toISOString();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError('invalid_input', '资料输入格式不正确，请检查长度、版本号和检索参数。', 400);
  return result.data;
}
function noteFrom(row: Row): KnowledgeNote {
  return {
    id: String(row.id), title: String(row.title), body: String(row.body),
    source: row.source === null ? null : String(row.source), revision: Number(row.revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
function searchHit(note: KnowledgeNote, query: string): KnowledgeSearchHit {
  const foldedQuery = query.toLowerCase();
  const fields = ['body', 'title', 'source'] as const;
  const matchedField = fields.find(field => (note[field] ?? '').toLowerCase().includes(foldedQuery)) ?? 'body';
  const text = note[matchedField] ?? '';
  const match = Math.max(0, text.toLowerCase().indexOf(foldedQuery));
  let start = Math.max(0, match - 60);
  let end = Math.min(text.length, start + 240);
  // Keep the excerpt exact without cutting an emoji's UTF-16 surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end++;
  return {
    id: note.id, title: note.title, source: note.source, revision: note.revision,
    snippet: text.slice(start, end), matchedField, start, end,
  };
}

/**
 * User-supplied reference material only. No URL is fetched and no file is read.
 * Callers must quote body/source as untrusted data, never insert it as system or
 * developer instructions. A hit cites a revision plus exact excerpt offsets.
 * Use a separate database file (normally knowledge.sqlite), never the task DB.
 */
export class KnowledgeStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
      this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (version > 1) throw new Error('资料库版本高于当前程序，请升级程序。');
      if (version === 0) this.db.exec(`BEGIN;
        CREATE TABLE notes(
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT,
          revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE note_revisions(
          note_id TEXT NOT NULL REFERENCES notes(id), revision INTEGER NOT NULL,
          title TEXT NOT NULL, body TEXT NOT NULL, source TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(note_id, revision)
        );
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          title, body, source, content='notes', content_rowid='rowid', tokenize='trigram'
        );
        CREATE TRIGGER notes_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid,title,body,source) VALUES(new.rowid,new.title,new.body,new.source);
        END;
        CREATE TRIGGER notes_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts,rowid,title,body,source) VALUES('delete',old.rowid,old.title,old.body,old.source);
          INSERT INTO notes_fts(rowid,title,body,source) VALUES(new.rowid,new.title,new.body,new.source);
        END;
        PRAGMA user_version=1;
        COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void { this.db.close(); }
  private tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private saveRevision(note: KnowledgeNote): void {
    this.db.prepare(`INSERT INTO note_revisions
      (note_id,revision,title,body,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(note.id, note.revision, note.title, note.body, note.source, note.createdAt, note.updatedAt);
  }
  create(input: CreateKnowledgeInput): KnowledgeNote {
    const values = parse(CreateInput, input);
    return this.tx(() => {
      const timestamp = stamp();
      const note: KnowledgeNote = {
        id: randomUUID(), title: values.title, body: values.body, source: values.source ?? null,
        revision: 1, createdAt: timestamp, updatedAt: timestamp,
      };
      this.db.prepare('INSERT INTO notes(id,title,body,source,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(note.id, note.title, note.body, note.source, note.revision, note.createdAt, note.updatedAt);
      this.saveRevision(note);
      return note;
    });
  }
  get(id: string): KnowledgeNote {
    parse(Id, id);
    const row = this.db.prepare('SELECT * FROM notes WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new DomainError('not_found', '找不到这份资料。', 404);
    return noteFrom(row);
  }
  list(): KnowledgeNote[] {
    return (this.db.prepare('SELECT * FROM notes ORDER BY updated_at DESC,rowid DESC').all() as Row[]).map(noteFrom);
  }
  revise(id: string, input: ReviseKnowledgeInput): KnowledgeNote {
    parse(Id, id);
    const values = parse(ReviseInput, input);
    return this.tx(() => {
      const current = this.get(id);
      if (current.revision !== values.expectedRevision) {
        throw new DomainError('revision_conflict', '资料已被更新，请读取最新版本后再保存。', 409);
      }
      const note: KnowledgeNote = {
        ...current, title: values.title, body: values.body,
        source: values.source === undefined ? current.source : values.source,
        revision: current.revision + 1, updatedAt: stamp(),
      };
      this.db.prepare('UPDATE notes SET title=?,body=?,source=?,revision=?,updated_at=? WHERE id=?')
        .run(note.title, note.body, note.source, note.revision, note.updatedAt, id);
      this.saveRevision(note);
      return note;
    });
  }
  /** Newest first. Each entry is a complete immutable snapshot with the same note id. */
  listRevisions(id: string): KnowledgeNote[] {
    this.get(id);
    return (this.db.prepare(`SELECT note_id AS id,title,body,source,revision,created_at,updated_at
      FROM note_revisions WHERE note_id=? ORDER BY revision DESC`).all(id) as Row[]).map(noteFrom);
  }
  search(query: string, limit = 10): KnowledgeSearchHit[] {
    const text = parse(Query, query);
    const count = parse(Limit, limit);
    if (!text) return [];
    let rows: Row[];
    if (Array.from(text).length >= 3) {
      // Quote the entire user query as one literal FTS phrase, including quotes.
      const phrase = `"${text.replaceAll('"', '""')}"`;
      rows = this.db.prepare(`SELECT n.* FROM notes_fts JOIN notes n ON n.rowid=notes_fts.rowid
        WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts,3.0,1.0,0.5),n.updated_at DESC,n.rowid DESC LIMIT ?`)
        .all(phrase, count) as Row[];
    } else {
      // Trigrams cannot match one/two characters. Escape LIKE wildcards literally.
      const pattern = `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      rows = this.db.prepare(`SELECT * FROM notes
        WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC,rowid DESC LIMIT ?`).all(pattern, pattern, pattern, count) as Row[];
    }
    return rows.map(row => searchHit(noteFrom(row), text));
  }
}