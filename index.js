/**
 * dsh-deepseek-code-supervisor — the skill provider half of the bundle.
 *
 * The `deepseek-code-supervisor` skill ships as plain files beside this entry
 * (`skills/deepseek-code-supervisor/`), so the provider reads the working tree
 * on every load instead of caching a copy: editing `SKILL.md` or any
 * `references/` file takes effect on the next `skill` call without a restart.
 *
 * Registered on the host plane, the provider lands in the global layer of
 * `ctx.skills`, so every agent preset — the bundled ones and the
 * `deepseek-code-supervisor` preset this bundle installs — sees the skill in
 * its catalog. The `resourceBase` directory is what makes the skill's relative
 * `references/…` and `templates/…` paths resolvable by the reader.
 *
 * Only Node built-ins are imported: a linked checkout must load with no
 * `node_modules` of its own.
 *
 * @module dsh-deepseek-code-supervisor
 */

import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'code-supervisor-skill'

/** The registry this plugin contributes to. */
export const inject = ['skills']

/** Skill name; also its directory under `skills/`. */
const SKILL_NAME = 'deepseek-code-supervisor'
/** Provider name; every candidate this provider lists must carry it. */
const PROVIDER_NAME = 'deepseek-code-supervisor'
/** Rank within one layer. 600 is the bundled-provider rank. */
const SKILL_RANK = 600

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL_NAME)
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

/** YAML frontmatter at the top of a `SKILL.md`. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/**
 * Split a skill file into its frontmatter and its body.
 * @param raw - whole file text.
 * @param path - file path used in error messages.
 * @returns the frontmatter block and the trimmed body.
 */
function parseSkill(raw, path) {
  const match = FRONTMATTER.exec(raw)
  if (match === null) throw new Error(`dsh-deepseek-code-supervisor: ${path} has no YAML frontmatter`)
  return { frontmatter: match[1], body: raw.slice(match[0].length).trim() }
}

/**
 * Read `description:` from frontmatter without pulling in a YAML parser.
 * @param frontmatter - the frontmatter block.
 * @param path - file path used in error messages.
 * @returns the non-empty description.
 */
function readDescription(frontmatter, path) {
  const line = frontmatter.split(/\r?\n/u).find((entry) => /^description:/u.test(entry))
  if (line === undefined) throw new Error(`dsh-deepseek-code-supervisor: ${path} has no description`)
  const raw = line.slice('description:'.length).trim()
  const quoted = /^(['"])([\s\S]*)\1$/u.exec(raw)
  const description = (quoted === null ? raw : quoted[2]).trim()
  if (description.length === 0) throw new Error(`dsh-deepseek-code-supervisor: ${path} has an empty description`)
  return description
}

/**
 * Register the skill provider.
 * @param ctx - host context carrying the skill registry.
 */
export function apply(ctx) {
  const { frontmatter } = parseSkill(readFileSync(SKILL_FILE, 'utf8'), SKILL_FILE)
  const description = readDescription(frontmatter, SKILL_FILE)
  const candidate = {
    name: SKILL_NAME,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'plugin',
    rank: SKILL_RANK,
    resourceBase: { kind: 'directory', path: SKILL_DIR.split(sep).join('/') },
    locator: SKILL_FILE,
    path: SKILL_FILE,
  }
  const provider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    get(selected) {
      const { body } = parseSkill(readFileSync(selected.locator, 'utf8'), selected.locator)
      const { rank: _rank, locator: _locator, ...summary } = selected
      return Promise.resolve({ ...summary, content: body })
    },
  }
  ctx.skills.registerProvider(() => provider)
}
