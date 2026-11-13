/**
 * dsh-deepseek-code-supervisor — 反思模式的硬性验收注入.
 *
 * The persona states the loop, the skill holds the procedure, and `guard.js`
 * refuses gated writes until the skill is loaded. This row makes the loop
 * *visible on every edit* instead of only at session start:
 *
 *   - `tools/post-execute` watches file tools. After a gated file is written,
 *     a context message lands after that tool result carrying the exact
 *     obligations for the round: reproduce/verify command, the six-point
 *     self-check, the L2 decision rule, and the closing summary.
 *   - `tools/post-execute` also watches review tools (`subagent`,
 *     `subagent_fork`): after one finishes, a message states that the verdict
 *     is evidence to report, not a pass to skip the self-check.
 *
 * Three rules keep the injection honest and cheap, because an injected claim
 * the model cannot trust is worse than no injection:
 *
 *   1. **A failed call injects nothing.** A denied call wrote no bytes; an
 *      edit whose `old_string` did not match wrote no bytes either. Telling the
 *      model "刚改了代码" after either one invites it to report a verification
 *      of a change that does not exist.
 *   2. **One full reminder per turn, then one line.** The full text is ~700
 *      chars. Ten edits in one turn used to mean ten copies of it, all of them
 *      durable user messages that every later request re-sends.
 *   3. **Nothing here blocks a call.** `guard.js` owns the denials; injection
 *      cannot deadlock an agent and still arrives verbatim in the transcript.
 *
 * @module dsh-deepseek-code-supervisor/verify
 */

import { randomUUID } from 'node:crypto'

import { EDIT_TOOLS, gatedTargets } from './shared.js'

/** Cordis plugin name. */
export const name = 'code-supervisor-verify'

/** The tool registry this row reads. */
export const inject = ['tools']

/** Delegation tools whose result a round must report. */
const REVIEW_TOOLS = new Set(['subagent', 'subagent_fork'])

const LARGE_CHANGE_CRITERIA =
  '2+ files / >30 net lines / function signature or data-structure change / business data writes / auth-key-payment callbacks / concurrency-async-timers / new dependency or config change / production bug fix / visually verifiable only'

/**
 * Build the short follow-up that replaces the full reminder later in a turn.
 * @param count - how many gated edits this turn has now made.
 * @returns the user-role context message.
 */
function repeatReminder(count) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'reflection-verify', form: 'notice', summary: `more code edits: ${count}` },
    content: [{
      type: 'text',
      text: `<reflection_round_required>\n本轮第 ${count} 次代码改动。收尾时仍按首条注入的五项做完，不重复贴全文。\n</reflection_round_required>`,
    }],
  }
}

/**
 * Build the reminder a code edit earns.
 * @param targets - code paths the edit touched.
 * @returns the user-role context message.
 */
export function editReminder(targets) {
  const list = targets.join(', ')
  const text = [
    '<reflection_round_required>',
    `刚改了代码：${list}`,
    '',
    '这一轮收尾前必须依次做完，缺一项就不算完成：',
    '',
    '1. 复现/验证：跑一条能证明改动生效的命令或测试，原样贴输出。修 bug 时必须是「改前红、改后绿」的同一条命令。',
    '2. 自检六项：逻辑错误 / 死代码 / 原有功能 / 误用 bug / 功能失效 / 结构内容，每项写「查了什么、看了哪里、发现几处」。只写「已检查」等于没查。',
    '3. 两个取证：打开产物数一遍（不看代码）；把期望值改坏一个字节，测试必须红。',
    `4. 判断要不要终检：命中任一即大改动 —— ${LARGE_CHANGE_CRITERIA}。大改动先问用户，确认后把 diff + 判据 + 一条验证命令交给干净上下文的 subagent，只回固定骨架短结论。小改动不起终检，报告写明「未起终检 + 理由」。`,
    '5. 收尾两块：总结（改了什么 / 验了什么带命令 / 没验什么）＋ 下一步（下一步做什么，或需要用户定什么）。',
    '',
    '未验的项直接写「未验」，不许用「应该没问题」「理论上」代替。',
    '</reflection_round_required>',
  ].join('\n')
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'reflection-verify', form: 'notice', summary: `code edit: ${list}` },
    content: [{ type: 'text', text }],
  }
}

/**
 * Build the reminder a finished delegation earns.
 * @param toolName - the delegation tool that ran.
 * @returns the user-role context message.
 */
function reviewReminder(toolName) {
  const text = [
    '<reflection_review_required>',
    `${toolName} 的结论已返回。按反思模式处理：`,
    '',
    '1. 原样呈现它的结论，不许改写、过滤或软化。',
    '2. 有 P0 → 直接判不通过，修完重做终检（仍是 L2）。报出 ≥2 处 P0/P1 → 先修完 + 重自检一轮，仍有问题才起新的换角度复查。',
    '3. 细致报告由主智能体写给用户：改了什么 / 验了什么（命令与输出）/ 没验什么 / 未决项 / 剩余风险。',
    '4. 收尾仍要给总结与下一步。',
    '</reflection_review_required>',
  ].join('\n')
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'reflection-review', form: 'notice', summary: `${toolName} result` },
    content: [{ type: 'text', text }],
  }
}

/**
 * Register the post-execute injections.
 * @param ctx - context carrying the tool registry.
 */
export function apply(ctx) {
  /**
   * Gated-edit count per agent for the turn now in progress.
   *
   * Keyed by agent, not by session: the public `Agent` interface exposes only
   * `id`, so `agent.session` is not something this row may assume exists — and
   * a `WeakMap.set(undefined, …)` throws, which would fail the whole
   * post-execute waterfall instead of merely skipping a reminder.
   *
   * The turn boundary is observed through `agent/status`. `session/event`
   * would be the obvious source, but it delivers a `Session`, and mapping a
   * Session back to its Agent is not something this plugin has access to.
   */
  const counts = new WeakMap()

  ctx.on('agent/status', ({ agent, status }) => {
    // Any status change ends the previous turn's edit run. A turn resets once,
    // and a status flap only costs one extra full reminder.
    if (status === 'idle') counts.delete(agent)
  })

  /**
   * Count one gated edit against the agent's current turn.
   * @param agent - the calling agent; always an object at this call site.
   * @returns how many gated edits this turn has now made.
   */
  function countEdit(agent) {
    const previous = counts.get(agent)
    const count = (previous === undefined ? 0 : previous) + 1
    counts.set(agent, count)
    return count
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()

    let message
    // Rule 1: a call that wrote nothing earns nothing. Both a guard denial and
    // a failed edit arrive here as `isError`, and neither changed a byte.
    if (exec?.agent !== undefined && result?.isError !== true) {
      if (EDIT_TOOLS.has(exec.name)) {
        const { paths } = gatedTargets(exec.name, exec.arguments)
        if (paths.length > 0) {
          const count = countEdit(exec.agent)
          message = count === 1 ? editReminder(paths) : repeatReminder(count)
        }
      } else if (REVIEW_TOOLS.has(exec.name)) {
        message = reviewReminder(exec.name)
      }
    }
    if (message === undefined) return downstream

    const contexts = downstream.additionalContexts
    const merged = Array.isArray(contexts) ? [message, ...contexts] : [message]
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: merged }
    }
    return { ...downstream, additionalContexts: merged }
  })
}
