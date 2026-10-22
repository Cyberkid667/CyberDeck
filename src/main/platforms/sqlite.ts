// Lecture d'une base SQLite d'un lanceur (itch.io, Amazon Games) avec le module
// node:sqlite intégré à Electron (Node 24) : pas de module natif à ajouter.
// La base est copiée (avec ses fichiers -wal et -shm) puis ouverte en lecture
// seule : le lanceur peut la garder ouverte pendant ce temps.
import fs from 'node:fs'
import path from 'node:path'

type Row = Record<string, unknown>

interface SqliteModule {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): Row[] }
    close(): void
  }
}

function sqliteModule(): SqliteModule | null {
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    const mod = get?.('node:sqlite') as SqliteModule | undefined
    return mod?.DatabaseSync ? mod : null
  } catch {
    return null
  }
}

export const sqliteAvailable = (): boolean => sqliteModule() !== null

/**
 * Copie la base dans tempDir, exécute les requêtes, supprime la copie.
 * Renvoie null si SQLite n'est pas disponible ; lève une erreur si la base est illisible.
 */
export function withSqliteCopy<T>(dbFile: string, tempDir: string, run: (query: (sql: string) => Row[]) => T): T | null {
  const mod = sqliteModule()
  if (!mod) return null
  const dir = fs.mkdtempSync(path.join(tempDir, 'ct-sqlite-'))
  const copy = path.join(dir, path.basename(dbFile))
  try {
    fs.copyFileSync(dbFile, copy)
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, copy + suffix)
    // La copie doit pouvoir rejouer son journal -wal : on l'ouvre en écriture,
    // mais c'est une copie jetable dans le dossier temporaire.
    const db = new mod.DatabaseSync(copy)
    try {
      return run((sql) => db.prepare(sql).all())
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Colonnes d'une table (vide si la table n'existe pas). */
export function tableColumns(query: (sql: string) => Row[], table: string): Set<string> {
  try {
    return new Set(query(`PRAGMA table_info(${JSON.stringify(table)})`).map((r) => String(r.name)))
  } catch {
    return new Set()
  }
}
