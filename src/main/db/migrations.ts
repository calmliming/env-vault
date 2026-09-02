/**
 * 数据库迁移定义。
 *
 * 规则：
 * - `version` 从 1 开始连续递增，一经发布不可修改、不可删除、不可重排。
 *   要改 schema 就追加下一条，因为用户机器上的库只会往前走。
 * - 每条迁移必须能在一个事务里跑完（migrator 会包事务）。
 * - 表结构对应开发计划 §4「数据模型」。
 */

import type { SqlDatabase } from './driver'

export interface Migration {
  version: number
  name: string
  up(db: SqlDatabase): void
}

/**
 * 001：初始 schema。
 *
 * 几处刻意的设计：
 * - 值一律存 `encrypted_value` / `encrypted_api_key`，明文不落库（§7）。
 * - `config_entries.original_format` 保存原始行文本，写回时用来还原引号、
 *   空格和注释关联，避免同步一个变量把整个文件格式打乱（§4.2）。
 * - `activity_log` 只存元数据，没有任何可以放明文值的列（§5.5）。
 * - `projects.absolute_path` 唯一：同一个目录不允许重复接入，否则文件监听
 *   会对同一份 `.env*` 触发两条互相打架的同步链路。
 */
const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  up(db) {
    db.exec(`
      CREATE TABLE projects (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT    NOT NULL,
        absolute_path  TEXT    NOT NULL UNIQUE,
        git_root       TEXT,
        tags           TEXT    NOT NULL DEFAULT '[]',
        created_at     INTEGER NOT NULL,
        last_opened_at INTEGER
      );

      CREATE TABLE env_files (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment     TEXT    NOT NULL,
        absolute_path   TEXT    NOT NULL,
        file_hash       TEXT,
        parser_version  INTEGER NOT NULL DEFAULT 1,
        last_scanned_at INTEGER,
        UNIQUE (project_id, absolute_path)
      );
      CREATE INDEX idx_env_files_project ON env_files(project_id);

      CREATE TABLE model_credentials (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_name     TEXT    NOT NULL,
        credential_name   TEXT    NOT NULL,
        endpoint          TEXT    NOT NULL,
        encrypted_api_key BLOB    NOT NULL,
        fingerprint       TEXT    NOT NULL,
        last_four         TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'unverified',
        tags              TEXT    NOT NULL DEFAULT '[]',
        notes             TEXT,
        created_at        INTEGER NOT NULL,
        last_validated_at INTEGER
      );
      CREATE INDEX idx_credentials_fingerprint ON model_credentials(fingerprint);

      CREATE TABLE credential_bindings (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id     INTEGER NOT NULL REFERENCES model_credentials(id) ON DELETE CASCADE,
        project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        environment       TEXT    NOT NULL,
        endpoint_variable TEXT,
        key_variable      TEXT    NOT NULL,
        last_synced_hash  TEXT,
        sync_mode         TEXT    NOT NULL DEFAULT 'manual',
        created_at        INTEGER NOT NULL,
        UNIQUE (project_id, environment, key_variable)
      );
      CREATE INDEX idx_bindings_credential ON credential_bindings(credential_id);
      CREATE INDEX idx_bindings_project ON credential_bindings(project_id);

      CREATE TABLE config_entries (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        env_file_id           INTEGER NOT NULL REFERENCES env_files(id) ON DELETE CASCADE,
        key                   TEXT    NOT NULL,
        encrypted_value       BLOB,
        value_type            TEXT    NOT NULL DEFAULT 'text',
        sensitivity           TEXT    NOT NULL DEFAULT 'normal',
        source_line           INTEGER,
        original_format       TEXT,
        credential_binding_id INTEGER REFERENCES credential_bindings(id) ON DELETE SET NULL,
        updated_at            INTEGER NOT NULL,
        UNIQUE (env_file_id, key)
      );
      CREATE INDEX idx_entries_file ON config_entries(env_file_id);
      CREATE INDEX idx_entries_key ON config_entries(key);

      CREATE TABLE activity_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        action      TEXT    NOT NULL,
        project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        environment TEXT,
        target_kind TEXT,
        target_ref  TEXT,
        detail      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
    `)
  }
}

/**
 * 002：`config_entries` 允许同一文件里出现重复 key。
 *
 * 001 的唯一约束是 `(env_file_id, key)`，但解析器**有意保留**文件里重复出现的 key
 * （见 `env/document.ts` 的取舍 2：去重等于替用户决定哪一条生效，
 * 而那取决于加载它的运行时）。约束和解析器直接冲突，导入真实文件会插入失败。
 *
 * SQLite 改不了已有表的约束，只能重建。这里按标准的
 * 「建新表 → 搬数据 → 删旧表 → 改名」四步走，整体在 migrator 的事务里。
 *
 * ⚠️ 重建期间必须关掉外键检查：`config_entries.credential_binding_id` 指向
 * `credential_bindings`，而 `DROP TABLE` 会让指向旧表的引用短暂失效。
 * `PRAGMA foreign_keys` 在事务里改不生效，所以用 `legacy_alter_table` 之外的办法 ——
 * 这里靠的是新表先建好、数据搬完再删旧表，引用方向上不会出现悬空。
 */
const migration002: Migration = {
  version: 2,
  name: 'allow-duplicate-keys',
  up(db) {
    db.exec(`
      CREATE TABLE config_entries_new (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        env_file_id           INTEGER NOT NULL REFERENCES env_files(id) ON DELETE CASCADE,
        key                   TEXT    NOT NULL,
        occurrence            INTEGER NOT NULL DEFAULT 0,
        encrypted_value       BLOB,
        value_type            TEXT    NOT NULL DEFAULT 'text',
        sensitivity           TEXT    NOT NULL DEFAULT 'normal',
        source_line           INTEGER,
        original_format       TEXT,
        credential_binding_id INTEGER REFERENCES credential_bindings(id) ON DELETE SET NULL,
        updated_at            INTEGER NOT NULL,
        UNIQUE (env_file_id, key, occurrence)
      );

      INSERT INTO config_entries_new
        (id, env_file_id, key, occurrence, encrypted_value, value_type, sensitivity,
         source_line, original_format, credential_binding_id, updated_at)
      SELECT
         id, env_file_id, key, 0, encrypted_value, value_type, sensitivity,
         source_line, original_format, credential_binding_id, updated_at
      FROM config_entries;

      DROP TABLE config_entries;
      ALTER TABLE config_entries_new RENAME TO config_entries;

      CREATE INDEX idx_entries_file ON config_entries(env_file_id);
      CREATE INDEX idx_entries_key ON config_entries(key);
    `)
  }
}

/**
 * 003：记住用户在导入时**取消勾选**的文件。
 *
 * 起因是验收脚本抓到的一个真 bug：重扫会「自动纳管新发现的文件」，
 * 而它判断「新」的依据只是「不在 env_files 里」—— 于是用户在导入时特意
 * 去掉勾选的 `.env.example` 会在下一次重扫时被收进来，
 * 等于替用户推翻他自己刚做的决定。
 *
 * 排除项是**项目级**的：同一个路径只可能属于一个项目，所以主键就是 (project_id, path)。
 * 用户想把某个排除项加回来时删掉这一行即可（阶段 2 的文件管理界面会用到）。
 */
const migration003: Migration = {
  version: 3,
  name: 'remember-excluded-files',
  up(db) {
    db.exec(`
      CREATE TABLE project_exclusions (
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        absolute_path TEXT    NOT NULL,
        excluded_at   INTEGER NOT NULL,
        PRIMARY KEY (project_id, absolute_path)
      );
    `)
  }
}

/**
 * 004：清掉已经落库的 `original_format` 明文。
 *
 * 🔴 001 起 `original_format` 存的是**完整原始行**（`insertEntries` 写的是
 * `node.raw`），而这一列是普通 TEXT，不加密。于是每一条
 * `OPENAI_API_KEY=sk-proj-...` 的明文都躺在库里 —— 加密边界（HANDOFF §6）
 * 一直漏在这一列上。
 *
 * 之所以没被发现：验收里那条「🔴 明文不落库」只翻了 `encrypted_value` 一列，
 * 它够不着 `original_format`。断言绿的，漏洞在的。这正是 PHASE-2 §5 那条
 * 教训的第二次出现，所以配套的断言改成了扫**整行**而不是某一列。
 *
 * 修法两步：扫描侧改成只产出「格式骨架」（`document.formatSkeleton`，
 * 值换成占位符，引号/空白/注释都还在），这里把存量记录清空。
 * 清空而不是就地改写，是因为这一列从来没有被任何代码读过 ——
 * 写回走的是重新解析磁盘文件那条路，从不依赖它。留着旧值只是继续留着明文。
 */
const migration004: Migration = {
  version: 4,
  name: 'redact-original-format',
  up(db) {
    db.exec(`UPDATE config_entries SET original_format = NULL;`)
  }
}

/**
 * 005：凭据的版本历史（开发计划 §9 阶段 4「凭据版本、轮换、停用」）。
 *
 * 🔴 **这张表里没有 `encrypted_api_key`，这是刻意的。**
 *
 * 留着旧密钥是纯粹的负债：轮换的全部意义就是让旧的那把作废，
 * 而一个"能翻出所有历史 Key 的数据库"把每一次轮换都变成了在扩大攻击面 ——
 * 用户越是勤于轮换，泄漏一次库文件的后果就越严重。这是完全反过来的激励。
 *
 * 只存指纹和末四位。它们回答了历史记录唯一该回答的问题：
 * **「我什么时候换的、换掉的是哪一把」**——
 * 指纹足以在别处（另一个项目、一份旧备份）认出残留的旧 Key，
 * 而从指纹反推不回 Key 本身（它是 HMAC，见 PHASE-3 §4）。
 *
 * `revoked_at` 只在**轮换**时写：这一代被下一代取代。
 * 用户按「停用」改的是 `model_credentials.status`，**不动版本行** ——
 * 那把 Key 还是那把 Key，只是这条凭据被搁置了。
 * 两件事混进一列，之后就再也分不开了。
 *
 * 存量凭据补一条 v1：不补的话老数据的历史是空的，
 * 界面上会显示成"从没轮换过"，而那不准确 —— 它只是没被记录过。
 */
const migration005: Migration = {
  version: 5,
  name: 'credential-versions',
  up(db) {
    db.exec(`
      CREATE TABLE credential_versions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id INTEGER NOT NULL REFERENCES model_credentials(id) ON DELETE CASCADE,
        version       INTEGER NOT NULL,
        fingerprint   TEXT    NOT NULL,
        last_four     TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        revoked_at    INTEGER,
        UNIQUE (credential_id, version)
      );
      CREATE INDEX idx_credential_versions ON credential_versions(credential_id);

      INSERT INTO credential_versions
        (credential_id, version, fingerprint, last_four, created_at, revoked_at)
      SELECT id, 1, fingerprint, last_four, created_at, NULL FROM model_credentials;
    `)
  }
}

export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
