/**
 * SQLite 驱动适配层。
 *
 * ⚠️ 与开发计划 §3.1 的偏差，落地时实测决定的：
 * 计划写的是 `better-sqlite3`，但本机装不上 —— Node 24 的 ABI 没有预编译包，
 * 回落到源码编译又要求 Visual Studio 构建工具（`gyp ERR! Could not find any
 * Visual Studio installation`）。于是先用 Electron 自带的 `node:sqlite`：
 * 同样是同步 SQLite，零原生依赖、随 Electron 一起分发、不需要 electron-rebuild。
 *
 * 两者的 API 形状几乎一致（`exec` / `prepare` / `run` / `get` / `all`），
 * 所以差异全部收敛在这个文件里。将来要换回 better-sqlite3（或换 libsql），
 * 只需重写 `openDatabase`，上层的 migrator 和 repository 一行都不用动。
 *
 * 版本前提：Electron 44 带的是 Node 24.19，`node:sqlite` 在那里已经稳定、不再打
 * ExperimentalWarning（Node 22 上它还是实验特性）。所以降级 Electron 大版本
 * 有可能让这个模块退回实验态甚至消失 —— 这层适配就是为那种情况准备的。
 */

import { DatabaseSync } from 'node:sqlite'

export type SqlParam = string | number | bigint | null | Uint8Array

export interface SqlRunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

export interface SqlStatement {
  run(...params: SqlParam[]): SqlRunResult
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[]
}

export interface SqlDatabase {
  /** 执行不带参数、可能包含多条语句的 SQL。 */
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  /**
   * 在一个事务里跑 fn。fn 抛异常则整体回滚并把异常继续往外抛。
   * node:sqlite 没有 better-sqlite3 那种 `db.transaction()` 包装器，这里自己实现。
   */
  transaction<T>(fn: () => T): T
  close(): void
}

/**
 * 打开（必要时创建）一个数据库文件。
 *
 * PRAGMA 的选择：
 * - `journal_mode = WAL`：写文件时不阻塞读，配合后续的文件监听/同步流程。
 * - `synchronous = NORMAL`：WAL 下的常规取舍，掉电最多丢最近一次事务，
 *   而我们的真源是用户磁盘上的 `.env*` 文件，不是这个索引库。
 * - `foreign_keys = ON`：级联删除项目时要连带清掉 env_files / config_entries。
 * - `busy_timeout`：主进程是唯一写入方，但 WAL 检查点仍可能短暂占锁。
 */
export function openDatabase(filePath: string): SqlDatabase {
  const db = new DatabaseSync(filePath)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  const wrapStatement = (sql: string): SqlStatement => {
    const stmt = db.prepare(sql)
    return {
      run: (...params) => {
        const result = stmt.run(...params)
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
      },
      get: <T,>(...params: SqlParam[]) => stmt.get(...params) as T | undefined,
      all: <T,>(...params: SqlParam[]) => stmt.all(...params) as T[]
    }
  }

  return {
    exec: (sql) => db.exec(sql),
    prepare: wrapStatement,
    transaction: <T,>(fn: () => T): T => {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        // ROLLBACK 本身失败不能盖掉真正的原因，所以吞掉它的异常。
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务可能已被 SQLite 自动回滚 */
        }
        throw error
      }
    },
    close: () => db.close()
  }
}
