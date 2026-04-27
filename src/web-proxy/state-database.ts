import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { WebProxyState } from './types'

export interface PersistedRendererState {
  accounts?: Record<string, unknown>
  groups?: Record<string, unknown>
  tags?: Record<string, unknown>
  [key: string]: unknown
}

interface RendererStateRecord {
  data: PersistedRendererState | null
  updatedAt: number | null
}

export class StateDatabase {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS proxy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS renderer_root (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        meta_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS renderer_accounts (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS renderer_groups (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS renderer_tags (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  loadProxyState(legacyFilePath?: string): Partial<WebProxyState> | null {
    const row = this.db
      .prepare('SELECT json FROM proxy_state WHERE id = 1')
      .get() as { json: string } | undefined

    if (row?.json) {
      return JSON.parse(row.json) as Partial<WebProxyState>
    }

    const legacy = this.readLegacyJson<Partial<WebProxyState> | null>(legacyFilePath, null)
    if (legacy) {
      this.saveProxyState(legacy as WebProxyState)
    }
    return legacy
  }

  saveProxyState(state: WebProxyState): void {
    const now = Date.now()
    this.db
      .prepare(
        `
          INSERT INTO proxy_state (id, json, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            json = excluded.json,
            updated_at = excluded.updated_at
        `
      )
      .run(JSON.stringify(state), now)
  }

  loadRendererState(legacyFilePath?: string): RendererStateRecord {
    const hasRendererRows =
      this.readTable('renderer_accounts').length > 0 ||
      this.readTable('renderer_groups').length > 0 ||
      this.readTable('renderer_tags').length > 0 ||
      Boolean(
        this.db
          .prepare('SELECT 1 FROM renderer_root WHERE id = 1')
          .get()
      )

    if (!hasRendererRows) {
      const legacy = this.readLegacyJson<PersistedRendererState | null>(legacyFilePath, null)
      if (legacy) {
        this.saveRendererState(legacy)
      } else {
        return { data: null, updatedAt: null }
      }
    }

    const root = this.db
      .prepare('SELECT meta_json, updated_at FROM renderer_root WHERE id = 1')
      .get() as { meta_json: string; updated_at: number } | undefined

    const meta = root?.meta_json ? (JSON.parse(root.meta_json) as PersistedRendererState) : {}
    const accounts = this.readTable('renderer_accounts')
    const groups = this.readTable('renderer_groups')
    const tags = this.readTable('renderer_tags')

    const data: PersistedRendererState = { ...meta }
    if (accounts.length > 0) {
      data.accounts = Object.fromEntries(accounts.map((item) => [item.id, JSON.parse(item.json) as unknown]))
    }
    if (groups.length > 0) {
      data.groups = Object.fromEntries(groups.map((item) => [item.id, JSON.parse(item.json) as unknown]))
    }
    if (tags.length > 0) {
      data.tags = Object.fromEntries(tags.map((item) => [item.id, JSON.parse(item.json) as unknown]))
    }

    const updatedAt = root?.updated_at ?? this.getLatestTableUpdate([
      'renderer_accounts',
      'renderer_groups',
      'renderer_tags'
    ])

    return {
      data,
      updatedAt
    }
  }

  saveRendererState(state: PersistedRendererState): void {
    const now = Date.now()
    const accounts = this.normalizeRecordMap(state.accounts)
    const groups = this.normalizeRecordMap(state.groups)
    const tags = this.normalizeRecordMap(state.tags)
    const meta = this.extractMeta(state)

    this.db.exec('BEGIN')
    try {
      this.db
        .prepare(
          `
            INSERT INTO renderer_root (id, meta_json, updated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              meta_json = excluded.meta_json,
              updated_at = excluded.updated_at
          `
        )
        .run(JSON.stringify(meta), now)

      this.replaceTable('renderer_accounts', accounts, now)
      this.replaceTable('renderer_groups', groups, now)
      this.replaceTable('renderer_tags', tags, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private replaceTable(table: 'renderer_accounts' | 'renderer_groups' | 'renderer_tags', records: Record<string, unknown>, now: number): void {
    this.db.prepare(`DELETE FROM ${table}`).run()
    const insert = this.db.prepare(`INSERT INTO ${table} (id, json, updated_at) VALUES (?, ?, ?)`)
    for (const [id, value] of Object.entries(records)) {
      insert.run(id, JSON.stringify(value), now)
    }
  }

  private readTable(table: 'renderer_accounts' | 'renderer_groups' | 'renderer_tags'): Array<{ id: string; json: string }> {
    return this.db.prepare(`SELECT id, json FROM ${table} ORDER BY id`).all() as Array<{ id: string; json: string }>
  }

  private normalizeRecordMap(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }
    return value as Record<string, unknown>
  }

  private extractMeta(state: PersistedRendererState): PersistedRendererState {
    const { accounts: _accounts, groups: _groups, tags: _tags, ...meta } = state
    return meta
  }

  private getLatestTableUpdate(tables: Array<'renderer_accounts' | 'renderer_groups' | 'renderer_tags'>): number | null {
    let latest: number | null = null
    for (const table of tables) {
      const row = this.db
        .prepare(`SELECT MAX(updated_at) AS updated_at FROM ${table}`)
        .get() as { updated_at: number | null } | undefined
      if (row?.updated_at != null) {
        latest = latest == null ? row.updated_at : Math.max(latest, row.updated_at)
      }
    }
    return latest
  }

  private readLegacyJson<T>(targetPath: string | undefined, fallback: T): T {
    try {
      if (!targetPath || !fs.existsSync(targetPath)) {
        return fallback
      }
      return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as T
    } catch {
      return fallback
    }
  }
}
