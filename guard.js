/**
 * dsh-deepseek-code-supervisor — the code-edit gate.
 *
 * `ctx.tools.guard()` is a monotonic denial checked after the `tools/pre-execute`
 * waterfall: whatever reason it returns becomes `Error: <reason>` for that call,
 * before the tool body runs. This row uses it to stop gated writes until the
 * agent has loaded the `deepseek-code-supervisor` skill, so the review workflow
 * cannot be skipped by simply editing first.
 *
 * Coverage is per agent and per process: one successful `skill` call for this
 * skill opens the gate for that agent until it ends. A fresh session (or a
 * subagent) loads it again.
 *
 * Two channels are gated, with different failure directions:
 *
 *   - **File tools** (`write`/`edit`/`apply_patch`) fail closed: an unreadable
 *     argument shape is denied, because the call certainly rewrites a file.
 *   - **Shell tools** (`bash`/`pwsh`) fail open but pattern-match the obvious
 *     writes — a redirect, `Set-Content`, `sed -i`, `tee`, `git apply`, or a
 *     formatter `--write` aimed at a code or config path. A shell command is
 *     too broad to deny blindly, and denying every command would cost more in
 *     false positives than the bypass costs. This channel raises the cost of
 *     the bypass; it does not close it, and the README says so.
 *
 * Node built-ins only: a linked checkout has no `node_modules` of its own.
 *
 * @module dsh-deepseek-code-supervisor/guard
 */

import { gatedTargets, hasKnownCodeName, isGatedWrite } from './shared.js'

/** Cordis plugin name. */
export const name = 'code-supervisor-guard'

/** The tool registry this plugin contributes a guard to. */
export const inject = ['tools']

/** The skill whose load opens the gate. */
export const SKILL_NAME = 'deepseek-code-supervisor'

/** The tool that loads a skill. */
const SKILL_TOOL = 'skill'

/** Shell tools whose arguments may carry a file write. */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Shell write forms.
 *
 * Two shapes, because they fail differently:
 *   - `{ path: true, pattern }` captures the target in group 1, so the caller
 *     can leave a doc path alone.
 *   - `{ path: false, pattern }` is a marker: the form rewrites a file but its
 *     arguments do not name one reliably (`git apply` takes paths from the diff;
 *     `sed -i` puts the script before the target). A marker always counts.
 */
const SHELL_WRITE_FORMS = [
  // A file-descriptor redirect: `> path`, `>> path`, `2> path`, `1>> path`.
  // The leading `[0-9]?` consumes the descriptor, and `&` is excluded so that
  // `2>&1` stays a stream duplication rather than a file write.
  { path: true, pattern: /(?:^|[^0-9&])[0-9]?>>?\s*["']?([^\s"'|;&<>]+)["']?/gu },
  // PowerShell file-writing cmdlets.
  { path: true, pattern: /\b(?:Set-Content|Add-Content|Out-File|Export-Csv|Export-Clixml)\b[^|;]*?(?:-Path|-FilePath|-LiteralPath)?\s*["']?([^\s"'|;]+\.\w+)["']?/giu },
  // tee path
  { path: true, pattern: /\btee\b(?:\s+-a)?\s+["']?([^\s"'|;&]+)["']?/gu },
  // In-place editors: the target follows the script, so this is a marker.
  { path: false, pattern: /\b(?:sed|gsed)\b[^\n|;]*?\s-{1,2}i\S*/giu },
  // git apply / patch consume a diff; the paths come from the diff, not argv.
  { path: false, pattern: /\bgit\s+apply\b/gu },
  // Formatters that rewrite in place.
  { path: false, pattern: /\b(?:prettier|eslint|biome|ruff|black|gofmt|rustfmt)\b[^\n|;]*?\s--write\b/gu },
]

/** Rejection text the model sees; it names the exact call that opens the gate. */
const REASON =
  `未加载 ${SKILL_NAME}：先调用 ${SKILL_TOOL} 工具并传 name=${SKILL_NAME} 加载二轮检测流程，再重试这次代码修改。`

/** Rejection text for a shell write, which needs a different remedy wording. */
const SHELL_REASON =
  `未加载 ${SKILL_NAME}：这条命令会写代码/配置文件。先调用 ${SKILL_TOOL} 工具并传 name=${SKILL_NAME}，再重试。`

/**
 * Find gated targets inside one shell command string.
 * @param command - the shell command text.
 * @returns the gated paths (or a marker) the command appears to write.
 */
export function shellWriteTargets(command) {
  if (typeof command !== 'string' || command.length === 0) return []
  const found = []
  for (const form of SHELL_WRITE_FORMS) {
    form.pattern.lastIndex = 0
    for (const match of command.matchAll(form.pattern)) {
      if (!form.path) {
        found.push('(shell write)')
        continue
      }
      const target = match[1]
      if (target === undefined) continue
      // `<` and `&` are already excluded by the capture class, so a stream
      // duplication (`>&2`, `2>&1`) never reaches here; the only special case
      // worth naming is the discard sink.
      if (target === '/dev/null') continue
      if (hasKnownCodeName(target)) found.push(target)
    }
  }
  return [...new Set(found)]
}

/**
 * Whether one tool call rewrites a gated target, and why.
 * @param toolName - model-facing tool name.
 * @param args - parsed tool arguments.
 * @returns the denial reason, or `undefined` when the call may proceed.
 */
export function denialFor(toolName, args) {
  if (SHELL_TOOLS.has(toolName)) {
    const targets = shellWriteTargets(args?.command)
    return targets.length === 0 ? undefined : SHELL_REASON
  }
  if (!isGatedWrite(toolName, args)) return undefined
  return REASON
}

/**
 * Register the gate: track skill loads, deny gated writes for unloaded agents.
 * @param ctx - host context carrying the tool registry.
 */
export function apply(ctx) {
  const loaded = new WeakSet()

  ctx.on('tools/result', (exec, result) => {
    if (exec?.agent === undefined) return
    if (exec.name !== SKILL_TOOL) return
    if (exec.arguments?.name !== SKILL_NAME) return
    if (result?.isError === true) return
    loaded.add(exec.agent)
  })

  ctx.tools.guard((exec) => {
    if (exec?.agent === undefined) return undefined
    if (loaded.has(exec.agent)) return undefined
    return denialFor(exec.name, exec.arguments)
  })
}

/** Re-exported so both halves read the classification from one place. */
export { gatedTargets, hasKnownCodeName }
