/**
 * dsh-deepseek-code-supervisor — shared target classification.
 *
 * `guard.js` (deny before the write) and `verify.js` (instruct after the write)
 * must answer the same question — "does this call rewrite something the review
 * workflow cares about?" — and they must answer it identically. Keeping two
 * hand-copied tables drifted once already; this module is the single source.
 *
 * Three classes instead of two booleans:
 *   - `code`   — source files, and extensionless files (`Makefile`, `Dockerfile`).
 *   - `config` — dependency manifests, lockfiles, CI/infra YAML, `.env`: the
 *                "加依赖改配置" case the persona already calls a large change.
 *   - `doc`    — prose and data; deliberately ungated so notes and fixtures
 *                never pay the skill-loading tax.
 *
 * Node built-ins only: a linked checkout has no `node_modules` of its own.
 *
 * @module dsh-deepseek-code-supervisor/shared
 */

/** File tools that rewrite a target on disk. */
export const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch'])

/** Extensions treated as source code. */
const CODE_EXTENSIONS = new Set([
  'py', 'pyi', 'pyw', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'vue', 'svelte', 'astro', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'cs', 'fs', 'vb', 'rb', 'php', 'swift', 'm', 'mm', 'dart', 'lua', 'r', 'jl', 'pl', 'pm',
  'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'ml', 'mli', 'zig', 'nim', 'sol',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'asm', 's',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'ipynb',
])

/**
 * Extensions treated as configuration. Narrow on purpose: a whitelist of
 * dependency/infra formats, not "everything that is not code".
 */
const CONFIG_EXTENSIONS = new Set(['yml', 'yaml', 'toml', 'ini', 'cfg', 'lock'])

/**
 * Basenames treated as configuration regardless of extension. This is the
 * dependency-manifest list: editing one changes what the project installs,
 * which the persona already classifies as a large change.
 */
const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lockb',
  'tsconfig.json', 'jsconfig.json',
  'pyproject.toml', 'setup.cfg', 'requirements.txt', 'pipfile', 'pipfile.lock', 'poetry.lock',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'gemfile', 'gemfile.lock',
  'dockerfile', 'containerfile', 'makefile', 'cmakelists.txt',
  '.npmrc', '.nvmrc', '.node-version', '.editorconfig', '.gitattributes',
])

/**
 * Split a path into its lowercase basename and extension without assuming a
 * POSIX or Windows separator.
 * @param path - file path from tool arguments.
 * @returns the lowercase basename and the extension without its dot.
 */
function splitPath(path) {
  const normal = String(path).replaceAll('\\', '/')
  const base = normal.slice(normal.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  const extension = dot <= 0 || dot === base.length - 1 ? '' : base.slice(dot + 1)
  return { base, extension }
}

/**
 * Classify one target path.
 * @param path - file path from tool arguments.
 * @returns `'code'`, `'config'`, or `'doc'`.
 */
export function classifyTarget(path) {
  const { base, extension } = splitPath(path)
  if (base.startsWith('.env')) return 'config'
  if (CONFIG_BASENAMES.has(base)) return 'config'
  if (extension === '') return 'code'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (CONFIG_EXTENSIONS.has(extension)) return 'config'
  return 'doc'
}

/**
 * Whether a target is subject to the review workflow.
 * @param path - file path from tool arguments.
 * @returns whether the path is gated.
 */
function isGated(path) {
  return classifyTarget(path) !== 'doc'
}

/**
 * Whether a path is *unambiguously* code or config — it either carries a known
 * extension or is a known manifest basename.
 *
 * Shell commands need this stricter predicate: `[ $x > 5 ]` redirects nothing,
 * but a loose `> target` match would read `5` as an extensionless code file.
 * Requiring a recognisable name keeps the shell channel from denying ordinary
 * comparisons and logging.
 * @param path - candidate path from a shell command.
 * @returns whether the name is unmistakably code or configuration.
 */
export function hasKnownCodeName(path) {
  const { base, extension } = splitPath(path)
  if (base.length === 0) return false
  if (base.startsWith('.env')) return true
  if (CONFIG_BASENAMES.has(base)) return true
  return CODE_EXTENSIONS.has(extension) || CONFIG_EXTENSIONS.has(extension)
}

/**
 * Collect the paths one `apply_patch` call touches. Headers cover add, update,
 * delete, and the `*** Move to:` destination of a move — the destination is a
 * write too, and missing it let a patch land on a code path unannounced.
 * @param args - parsed tool arguments.
 * @returns the touched paths, or an empty array when none can be parsed.
 */
function patchPaths(args) {
  const text = typeof args?.input === 'string' ? args.input
    : typeof args?.patch === 'string' ? args.patch
      : undefined
  if (text === undefined) return []
  const paths = []
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gmu)) paths.push(match[1].trim())
  for (const match of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gmu)) paths.push(match[1].trim())
  return paths.filter((path) => path.length > 0)
}

/**
 * Collect the gated paths one file-tool call touches.
 *
 * `unknown` reports "the call rewrites something but the argument shape could
 * not be read", which both callers must treat as gated (fail closed) rather
 * than silently skipping the workflow.
 * @param toolName - model-facing tool name.
 * @param args - parsed tool arguments.
 * @returns the gated paths plus whether the target could not be resolved.
 */
export function gatedTargets(toolName, args) {
  if (!EDIT_TOOLS.has(toolName)) return { paths: [], unknown: false }
  if (toolName === 'apply_patch') {
    const paths = patchPaths(args)
    if (paths.length === 0) return { paths: [], unknown: true }
    return { paths: paths.filter(isGated), unknown: false }
  }
  const path = typeof args?.file_path === 'string' ? args.file_path
    : typeof args?.path === 'string' ? args.path
      : undefined
  if (path === undefined) return { paths: [], unknown: true }
  return { paths: isGated(path) ? [path] : [], unknown: false }
}

/**
 * Whether one call needs the review workflow. Unknown shapes fail closed.
 * @param toolName - model-facing tool name.
 * @param args - parsed tool arguments.
 * @returns whether this call is gated.
 */
export function isGatedWrite(toolName, args) {
  const { paths, unknown } = gatedTargets(toolName, args)
  return unknown || paths.length > 0
}
