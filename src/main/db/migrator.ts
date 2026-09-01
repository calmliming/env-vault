/**
 * 迁移执行器。
 *
 * 用 SQLite 内置的 `PRAGMA user_version` 当版本游标，而不是自建 schema_migrations 表：
 * user_version 是数据库头里的一个整数，读写都不需要先有表存在，因此
 * 「空文件 → 第一条迁移」这个最容易出错的路径上没有先有鸡还是先有蛋的问题。
 *
 * 每条迁移单独包一个事务并在同一个事务里推进 user_version，
 * 所以中途失败不会留下「表建了一半、版本号却已经前进」的库。
 */

import type { SqlDatabase } from './driver'
import { MIGRATIONS, LATEST_VERSION, type Migration } from './migrations'
import type { AppliedMigration } from '@shared/ipc'

export function getSchemaVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get<{ user_version: number }>()
  return row?.user_version ?? 0
}

/**
 * 把数据库推进到最新版本，返回本次实际执行的迁移。
 * 已经是最新时返回空数组，不会做任何写入。
 */
export function migrate(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): AppliedMigration[] {
  const current = getSchemaVersion(db)

  if (current > LATEST_VERSION) {
    // 用户用新版本 App 建过库，又降级回旧版本。继续跑只会写坏数据，直接停。
    throw new Error(
      `数据库版本 ${current} 高于当前程序支持的 ${LATEST_VERSION}，请升级 EnvVault 后再打开。`
    )
  }

  const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version)
  const applied: AppliedMigration[] = []

  for (const migration of pending) {
    const startedAt = Date.now()
    db.transaction(() => {
      migration.up(db)
      // user_version 不接受参数绑定，只能拼字符串；version 来自代码常量而非外部输入。
      db.exec(`PRAGMA user_version = ${migration.version}`)
    })
    applied.push({
      version: migration.version,
      name: migration.name,
      durationMs: Date.now() - startedAt
    })
  }

  return applied
}

export function listTables(db: SqlDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all<{ name: string }>()
    .map((row) => row.name)
}
