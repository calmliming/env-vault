/**
 * 数据库单例：连接、迁移、以及给 IPC 用的只读信息。
 *
 * 全应用只开一个连接。node:sqlite 是同步 API，主进程本来就是单线程，
 * 多开连接只会在 WAL 检查点上互相等锁，没有任何收益。
 */

import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type SqlDatabase } from './driver'
import { getSchemaVersion, listTables, migrate } from './migrator'
import { LATEST_VERSION } from './migrations'
import type { AppliedMigration, DatabaseInfo } from '@shared/ipc'

let database: SqlDatabase | null = null
let databasePath = ''
let appliedThisLaunch: AppliedMigration[] = []

export function getDatabasePath(): string {
  return databasePath || join(app.getPath('userData'), 'envvault.db')
}

/**
 * 打开数据库并跑完迁移。必须在 app ready 之后调用（依赖 userData 路径）。
 * 重复调用返回同一个连接，不会重复迁移。
 */
export function initializeDatabase(): SqlDatabase {
  if (database) return database

  const userData = app.getPath('userData')
  mkdirSync(userData, { recursive: true })
  databasePath = join(userData, 'envvault.db')

  const db = openDatabase(databasePath)
  appliedThisLaunch = migrate(db)
  database = db
  return db
}

export function getDatabase(): SqlDatabase {
  if (!database) throw new Error('数据库尚未初始化')
  return database
}

export function getDatabaseInfo(): DatabaseInfo {
  const db = getDatabase()
  return {
    filePath: databasePath,
    schemaVersion: getSchemaVersion(db),
    latestVersion: LATEST_VERSION,
    appliedMigrations: appliedThisLaunch,
    tables: listTables(db)
  }
}

export function closeDatabase(): void {
  if (!database) return
  database.close()
  database = null
}
