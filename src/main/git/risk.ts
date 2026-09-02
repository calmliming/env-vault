/**
 * 风险分级：把「Git 暴露程度」和「文件里有多敏感的值」合成一个结论。
 *
 * ## 🔴 两条产品判断，它们决定这个功能有没有用
 *
 * **一、不喊狼来了。** 一个在每个项目上都把 `.env.example` 标红的安全页，
 * 用户看两次就再也不看了 —— 之后真出事那次他也不会看。所以「被跟踪」
 * 本身不是罪：一个不含任何敏感值的模板文件进仓库是完全正常的做法。
 * 定罪的是「被跟踪 **且** 里面有东西」。
 *
 * **二、`unknown` 不是 `ok`。** git 不可用、或者项目不在仓库里时，
 * 我们**什么都没查出来**。那时候显示一个绿色的「通过」是彻头彻尾的谎话，
 * 而用户会拿着这个谎话去决定要不要提交。
 *
 * ## 目录约定
 *
 * 和 `env/`、`providers/` 一样：import 带 `.ts` 后缀、不用 `@shared/*` 别名、
 * 不用构造函数参数属性 —— 这张表要能被 `node --test` 逐条跑。
 */

import type { RiskLevel } from '../../shared/security-types.ts'

export interface RiskInput {
  /** 项目内相对路径，只用来拼提示文案。 */
  relativePath: string
  /** `.env.example` 这类模板。 */
  isTemplate: boolean
  /**
   * 文件当前还在磁盘上。
   * 已纳管但被删掉的文件仍然要出现在报告里 —— 「本地没了」不等于「仓库里没了」。
   */
  onDisk: boolean
  /** null 表示没查出来（git 不可用，或不在仓库里）。 */
  tracked: boolean | null
  ignored: boolean | null
  /** 🔴 只有计数。值一个都不进这一层。 */
  highCount: number
  sensitiveCount: number
}

export interface RiskVerdict {
  level: RiskLevel
  /** 为什么是这个等级。 */
  reason: string
  /** 该怎么办。没有可执行动作时是 null。 */
  remedy: string | null
}

/** `git rm --cached` 之后旧版本仍在历史里 —— 这句话必须跟着一起说。 */
function untrackRemedy(relativePath: string): string {
  return `执行 git rm --cached "${relativePath}" 并提交，让它脱离跟踪。注意：这不会删掉已经进入提交历史的旧版本，泄漏过的 Key 仍然要作废重发。`
}

function describeContents(high: number, sensitive: number): string {
  if (high > 0 && sensitive > 0) return `含 ${high} 个高危值、${sensitive} 个疑似敏感值`
  if (high > 0) return `含 ${high} 个高危值`
  if (sensitive > 0) return `含 ${sensitive} 个疑似敏感值`
  return '没有检测到敏感值'
}

/**
 * 判定表。**顺序就是严重程度**，从上往下第一个命中的就是结论。
 */
export function gradeRisk(input: RiskInput): RiskVerdict {
  const { relativePath, isTemplate, onDisk, tracked, ignored, highCount, sensitiveCount } = input
  const hasSecrets = highCount > 0 || sensitiveCount > 0
  const contents = describeContents(highCount, sensitiveCount)

  // 1. 没查出来。绝不能掉进下面任何一个分支去装作查过了。
  if (tracked === null || ignored === null) {
    return {
      level: 'unknown',
      reason: `无法确定这个文件的 Git 状态，${contents}。`,
      remedy: null
    }
  }

  // 2. 磁盘上没有、Git 里也没有 —— 无处可泄漏。
  //
  // 这一条是看着界面截图补的：一个已经从磁盘删掉、又从没进过仓库的文件，
  // 之前会掉到下面「还没被 .gitignore 覆盖」那条去，于是页面上出现了
  // 「磁盘上已不存在」和「建议加进 .gitignore」并排显示 —— 建议用户去保护
  // 一个不存在的文件。中心记录里还留着它，所以它仍然该在报告里列出来，
  // 但等级是 ok。
  //
  // 注意**只在未跟踪时**才走这条：文件在本地删掉、但仓库里还有的那种，
  // 内容照样躺在 git 历史里，得继续按下面的规则定罪。
  if (!onDisk && !tracked) {
    return {
      level: 'ok',
      reason: '文件已从磁盘消失，Git 里也没有它 —— 只剩中心记录里的这一份。',
      remedy: null
    }
  }

  // 3. 🔴 既被跟踪、又写在 .gitignore 里 —— 整个功能里最有价值的一条。
  //
  // 真实世界里的顺序几乎总是「先提交了 .env，后来才想起来加进 .gitignore」。
  // 加完之后 git status 变干净了，于是所有人都以为堵上了 ——
  // 而那把 Key 还在仓库里躺着，并且还会跟着每一次 push 出去。
  // 忽略规则对**已经跟踪**的文件完全无效，这一点必须直说。
  if (tracked && ignored && hasSecrets) {
    return {
      level: 'critical',
      reason: `已经写在 .gitignore 里，但文件仍然被 Git 跟踪着 —— 忽略规则对已跟踪的文件无效，${contents}。`,
      remedy: untrackRemedy(relativePath)
    }
  }

  // 3. 被跟踪，且里面有一把长得就像真 Key 的值。
  if (tracked && highCount > 0) {
    return {
      level: 'critical',
      reason: `正被 Git 跟踪，${contents}。这些值会随每一次提交进入仓库历史。`,
      remedy: untrackRemedy(relativePath)
    }
  }

  // 4. 还没进仓库，但也没人拦着 —— 下一次 `git add .` 就进去了。
  if (!tracked && !ignored && highCount > 0) {
    return {
      level: 'critical',
      reason: `${contents}，而且没有被任何 .gitignore 规则覆盖 —— 下一次 git add . 就会把它带进仓库。`,
      remedy: `把 ${relativePath} 加进 .gitignore（或用 .env* 这类规则一并覆盖）。`
    }
  }

  // 5. 跟踪与忽略规则自相矛盾，但文件里没东西可泄漏。
  //    仍然要说一声：等哪天往里加了 Key，第 2 条就成立了。
  if (tracked && ignored) {
    return {
      level: 'warning',
      reason: `已经写在 .gitignore 里，但文件仍然被 Git 跟踪着 —— 忽略规则对已跟踪的文件无效。目前${contents}。`,
      remedy: untrackRemedy(relativePath)
    }
  }

  if (tracked && sensitiveCount > 0) {
    return {
      level: 'warning',
      reason: `正被 Git 跟踪，${contents}。确认这些值可以进仓库。`,
      remedy: untrackRemedy(relativePath)
    }
  }

  if (!tracked && !ignored && sensitiveCount > 0) {
    return {
      level: 'warning',
      reason: `${contents}，而且没有被 .gitignore 覆盖。`,
      remedy: `把 ${relativePath} 加进 .gitignore。`
    }
  }

  // 6. 真实配置文件没被覆盖：现在是空的，但 .env 这类文件迟早会装上东西。
  //    模板文件不在此列 —— 模板本来就该进仓库。
  if (!tracked && !ignored && !isTemplate) {
    return {
      level: 'warning',
      reason: '还没有被任何 .gitignore 规则覆盖。现在没有敏感值，但以后往里加 Key 就会跟着进仓库。',
      remedy: `把 ${relativePath} 加进 .gitignore。`
    }
  }

  // 7. 查过了，没问题。
  //    被跟踪的干净模板走到这里 —— 那是正常做法，不该报警。
  return {
    level: 'ok',
    reason: tracked
      ? `正被 Git 跟踪，但${contents}。`
      : ignored
        ? `已被 .gitignore 覆盖，不会进入仓库，${contents}。`
        : `${contents}。`,
    remedy: null
  }
}
