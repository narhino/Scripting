import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Lifecycle of a script: an agent uploads it (new) -> you record the voiceover
// (created) -> you publish the video (uploaded, which moves it to the archive).
export const STATUSES = ['new', 'created', 'uploaded'];
export const TODO_STATUSES = ['new', 'created'];
export const STATUS_LABELS = { new: 'New', created: 'Audio created', uploaded: 'Uploaded' };

const PACKAGING_FIELDS = [
  'titles',
  'chosen_title',
  'thumbnail_text',
  'thumbnail_concept',
  'thumbnail_urls',
  'description',
  'video_tags',
];
const PACKAGING_JSON_FIELDS = new Set(['titles', 'thumbnail_urls', 'video_tags']);
const SCRIPT_EDITABLE_FIELDS = ['title', 'body', 'channel', 'source', 'source_url', 'notes', 'tags', 'video_url'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scripts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id      TEXT UNIQUE,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  channel          TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT '',
  source_url       TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'created', 'uploaded')),
  video_url        TEXT NOT NULL DEFAULT '',
  word_count       INTEGER NOT NULL DEFAULT 0,
  seen_at          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  audio_created_at TEXT,
  uploaded_at      TEXT
);
CREATE INDEX IF NOT EXISTS scripts_status ON scripts (status, created_at);

CREATE TABLE IF NOT EXISTS packaging (
  script_id         INTEGER PRIMARY KEY REFERENCES scripts (id) ON DELETE CASCADE,
  titles            TEXT NOT NULL DEFAULT '[]',
  chosen_title      TEXT NOT NULL DEFAULT '',
  thumbnail_text    TEXT NOT NULL DEFAULT '',
  thumbnail_concept TEXT NOT NULL DEFAULT '',
  thumbnail_urls    TEXT NOT NULL DEFAULT '[]',
  description       TEXT NOT NULL DEFAULT '',
  video_tags        TEXT NOT NULL DEFAULT '[]',
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id INTEGER NOT NULL REFERENCES scripts (id) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  actor     TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_script ON events (script_id, id);
`;

export class NotFoundError extends Error {
  constructor(message = 'Script not found') {
    super(message);
    this.status = 404;
  }
}

const now = () => new Date().toISOString();
const countWords = (text) => (text.match(/\S+/g) || []).length;
const excerptOf = (text, max = 220) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
};
const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function toPackaging(row) {
  if (!row) return null;
  return {
    titles: JSON.parse(row.titles),
    chosen_title: row.chosen_title,
    thumbnail_text: row.thumbnail_text,
    thumbnail_concept: row.thumbnail_concept,
    thumbnail_urls: JSON.parse(row.thumbnail_urls),
    description: row.description,
    video_tags: JSON.parse(row.video_tags),
    updated_at: row.updated_at,
  };
}

function toScript(row, { full }) {
  const script = {
    id: row.id,
    external_id: row.external_id,
    title: row.title,
    channel: row.channel,
    source: row.source,
    source_url: row.source_url,
    notes: row.notes,
    tags: JSON.parse(row.tags),
    status: row.status,
    video_url: row.video_url,
    word_count: row.word_count,
    seen: row.seen_at !== null,
    seen_at: row.seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    audio_created_at: row.audio_created_at,
    uploaded_at: row.uploaded_at,
  };
  if (full) script.body = row.body;
  else script.excerpt = excerptOf(row.body);
  return script;
}

export function openStore(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  const emit = (type, script) => changes.emit('change', {
    type, id: script.id, title: script.title, status: script.status, seen: script.seen ?? script.seen_at !== null,
  });

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const stmt = {
    byId: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    byExternalId: db.prepare('SELECT * FROM scripts WHERE external_id = ?'),
    packaging: db.prepare('SELECT * FROM packaging WHERE script_id = ?'),
    events: db.prepare('SELECT type, detail, actor, at FROM events WHERE script_id = ? ORDER BY id DESC'),
    addEvent: db.prepare('INSERT INTO events (script_id, type, detail, actor, at) VALUES (?, ?, ?, ?, ?)'),
    insert: db.prepare(`
      INSERT INTO scripts (external_id, title, body, channel, source, source_url, notes, tags,
                           word_count, seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    markSeen: db.prepare('UPDATE scripts SET seen_at = ? WHERE id = ? AND seen_at IS NULL'),
    markAllSeen: db.prepare('UPDATE scripts SET seen_at = ? WHERE seen_at IS NULL'),
    delete: db.prepare('DELETE FROM scripts WHERE id = ?'),
    channels: db.prepare("SELECT DISTINCT channel FROM scripts WHERE channel <> '' ORDER BY channel COLLATE NOCASE"),
    counts: db.prepare(`
      SELECT
        SUM(status = 'new')                                AS new,
        SUM(status = 'created')                            AS created,
        SUM(status = 'uploaded')                           AS uploaded,
        SUM(seen_at IS NULL AND status <> 'uploaded')      AS unseen
      FROM scripts`),
  };

  const requireRow = (id) => {
    const row = stmt.byId.get(id);
    if (!row) throw new NotFoundError();
    return row;
  };
  const logEvent = (id, type, detail, actor = '') => stmt.addEvent.run(id, type, detail, actor, now());

  function writePackaging(id, patch) {
    const current = toPackaging(stmt.packaging.get(id)) || {
      titles: [], chosen_title: '', thumbnail_text: '', thumbnail_concept: '',
      thumbnail_urls: [], description: '', video_tags: [],
    };
    const touched = PACKAGING_FIELDS.filter((f) => patch[f] !== undefined);
    if (touched.length === 0) return [];
    const next = { ...current };
    for (const f of touched) next[f] = patch[f];
    // A chosen title should always be one of the options so the UI can show it as selected.
    if (next.chosen_title && !next.titles.includes(next.chosen_title)) next.titles = [next.chosen_title, ...next.titles];
    if (!next.chosen_title && next.titles.length > 0) next.chosen_title = next.titles[0];
    const values = PACKAGING_FIELDS.map((f) => (PACKAGING_JSON_FIELDS.has(f) ? JSON.stringify(next[f]) : next[f]));
    db.prepare(`
      INSERT INTO packaging (script_id, ${PACKAGING_FIELDS.join(', ')}, updated_at)
      VALUES (?, ${PACKAGING_FIELDS.map(() => '?').join(', ')}, ?)
      ON CONFLICT (script_id) DO UPDATE SET
        ${PACKAGING_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
        updated_at = excluded.updated_at`).run(id, ...values, now());
    return touched;
  }

  function getScript(id) {
    const row = requireRow(id);
    return {
      ...toScript(row, { full: true }),
      packaging: toPackaging(stmt.packaging.get(id)),
      events: stmt.events.all(id).map((e) => ({ ...e })),
    };
  }

  /** Accepts a numeric id or "ext:<external_id>" and returns the numeric id. */
  function resolveId(ref) {
    const text = String(ref);
    if (/^\d+$/.test(text)) return requireRow(Number(text)).id;
    if (text.startsWith('ext:')) {
      const row = stmt.byExternalId.get(text.slice(4));
      if (!row) throw new NotFoundError();
      return row.id;
    }
    throw new NotFoundError();
  }

  /**
   * Adds a script. If external_id matches an existing script, that script is revised in place
   * (and flagged unseen again) instead of creating a duplicate, so agents can safely retry.
   */
  function createScript(input, { actor = '', seen = false } = {}) {
    const result = transaction(() => {
      const existing = input.external_id ? stmt.byExternalId.get(input.external_id) : undefined;
      if (existing) {
        const patch = {};
        for (const f of ['title', 'body', 'channel', 'source', 'source_url', 'notes', 'tags']) {
          if (input[f] !== undefined) patch[f] = input[f];
        }
        applyScriptPatch(existing.id, patch);
        db.prepare('UPDATE scripts SET seen_at = NULL WHERE id = ?').run(existing.id);
        if (input.packaging) writePackaging(existing.id, input.packaging);
        logEvent(existing.id, 'revised', 'New version received', actor || input.source || '');
        return { id: existing.id, created: false };
      }
      const ts = now();
      const { lastInsertRowid } = stmt.insert.run(
        input.external_id ?? null,
        input.title,
        input.body,
        input.channel ?? '',
        input.source ?? '',
        input.source_url ?? '',
        input.notes ?? '',
        JSON.stringify(input.tags ?? []),
        countWords(input.body),
        seen ? ts : null,
        ts,
        ts,
      );
      const id = Number(lastInsertRowid);
      if (input.packaging) writePackaging(id, input.packaging);
      const who = actor || input.source || 'an agent';
      logEvent(id, 'received', input.packaging ? `Script + packaging received from ${who}` : `Script received from ${who}`, actor || input.source || '');
      return { id, created: true };
    });
    const script = getScript(result.id);
    emit(result.created ? 'created' : 'revised', script);
    return { script, created: result.created };
  }

  function applyScriptPatch(id, patch) {
    const fields = SCRIPT_EDITABLE_FIELDS.filter((f) => patch[f] !== undefined);
    if (fields.length === 0) return [];
    const sets = fields.map((f) => `${f} = ?`);
    const values = fields.map((f) => (f === 'tags' ? JSON.stringify(patch[f]) : patch[f]));
    if (patch.body !== undefined) {
      sets.push('word_count = ?');
      values.push(countWords(patch.body));
    }
    sets.push('updated_at = ?');
    values.push(now());
    db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return fields;
  }

  function updateScript(id, patch, { actor = '' } = {}) {
    requireRow(id);
    transaction(() => {
      const fields = applyScriptPatch(id, patch);
      if (fields.length) logEvent(id, 'edited', `Edited ${fields.join(', ').replaceAll('_', ' ')}`, actor);
    });
    const script = getScript(id);
    emit('updated', script);
    return script;
  }

  function setStatus(id, status, { video_url, actor = '' } = {}) {
    const row = requireRow(id);
    const ts = now();
    transaction(() => {
      // Timestamps follow the status: moving forward stamps the step, moving back clears later steps.
      const audioAt = status === 'new' ? null : row.audio_created_at ?? ts;
      const uploadedAt = status === 'uploaded' ? (row.status === 'uploaded' ? row.uploaded_at : ts) : null;
      db.prepare(`
        UPDATE scripts
        SET status = ?, audio_created_at = ?, uploaded_at = ?, video_url = ?, seen_at = COALESCE(seen_at, ?), updated_at = ?
        WHERE id = ?`).run(
        status,
        audioAt,
        uploadedAt,
        video_url ?? row.video_url,
        ts,
        ts,
        id,
      );
      if (row.status !== status) {
        logEvent(id, 'status', `${STATUS_LABELS[row.status]} → ${STATUS_LABELS[status]}`, actor);
      }
      if (video_url && video_url !== row.video_url) logEvent(id, 'edited', 'Video link added', actor);
    });
    const script = getScript(id);
    emit('status', script);
    return script;
  }

  function upsertPackaging(id, patch, { actor = '' } = {}) {
    requireRow(id);
    transaction(() => {
      const touched = writePackaging(id, patch);
      if (touched.length) {
        db.prepare('UPDATE scripts SET updated_at = ? WHERE id = ?').run(now(), id);
        logEvent(id, 'packaging', `Packaging updated (${touched.join(', ').replaceAll('_', ' ')})`, actor);
      }
    });
    const script = getScript(id);
    emit('packaging', script);
    return script;
  }

  function markSeen(id) {
    requireRow(id);
    const { changes: n } = stmt.markSeen.run(now(), id);
    if (n) emit('seen', toScript(stmt.byId.get(id), { full: false }));
  }

  function markAllSeen() {
    const { changes: n } = stmt.markAllSeen.run(now());
    if (n) changes.emit('change', { type: 'seen' });
    return Number(n);
  }

  function deleteScript(id) {
    const row = requireRow(id);
    stmt.delete.run(id);
    emit('deleted', row);
  }

  function listScripts({ view = 'todo', status, channel, q, limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];
    const statuses = status ? [status] : view === 'archive' ? ['uploaded'] : view === 'all' ? STATUSES : TODO_STATUSES;
    where.push(`s.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
    if (channel) {
      where.push('s.channel = ?');
      params.push(channel);
    }
    if (q && q.trim()) {
      const like = `%${escapeLike(q.trim())}%`;
      const cols = ['s.title', 's.body', 's.channel', 's.source', 's.notes', 's.tags', 'p.titles', 'p.description'];
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...cols.map(() => like));
    }
    const order = view === 'archive' ? 's.uploaded_at DESC, s.id DESC' : 's.created_at DESC, s.id DESC';
    const rows = db.prepare(`
      SELECT s.*, p.script_id AS p_script_id, p.titles AS p_titles, p.chosen_title AS p_chosen_title,
             p.thumbnail_text AS p_thumbnail_text, p.thumbnail_concept AS p_thumbnail_concept,
             p.thumbnail_urls AS p_thumbnail_urls, p.description AS p_description,
             p.video_tags AS p_video_tags, p.updated_at AS p_updated_at
      FROM scripts s LEFT JOIN packaging p ON p.script_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return rows.map((row) => ({
      ...toScript(row, { full: false }),
      packaging: row.p_script_id === null ? null : toPackaging({
        titles: row.p_titles,
        chosen_title: row.p_chosen_title,
        thumbnail_text: row.p_thumbnail_text,
        thumbnail_concept: row.p_thumbnail_concept,
        thumbnail_urls: row.p_thumbnail_urls,
        description: row.p_description,
        video_tags: row.p_video_tags,
        updated_at: row.p_updated_at,
      }),
    }));
  }

  function meta() {
    const c = stmt.counts.get();
    return {
      counts: {
        new: c.new ?? 0,
        created: c.created ?? 0,
        uploaded: c.uploaded ?? 0,
        todo: (c.new ?? 0) + (c.created ?? 0),
        unseen: c.unseen ?? 0,
      },
      channels: stmt.channels.all().map((r) => r.channel),
    };
  }

  return {
    changes,
    createScript,
    getScript,
    resolveId,
    listScripts,
    updateScript,
    setStatus,
    upsertPackaging,
    markSeen,
    markAllSeen,
    deleteScript,
    meta,
    close: () => db.close(),
  };
}
