/**
 * dsh-deepseek-code-supervisor — self-check for the runtime half.
 *
 * The rules this checks are the ones the plugin itself promises, because a
 * supervisor that cannot prove its own gate works is the exact failure it
 * exists to prevent: an assertion that was never executed reads as green.
 *
 * Run with `node test.js`. Exit code 0 means every case passed.
 *
 * No test framework: a linked checkout has no `node_modules` of its own, and
 * adding a dependency to verify a dependency-free plugin is the wrong trade.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { apply as guardApply, denialFor, shellWriteTargets } from './guard.js'
import { apply as retroApply, latestEntries } from './retro.js'
import { apply as verifyApply, editReminder } from './verify.js'
import { classifyTarget } from './shared.js'

/** Package root: the directory this suite lives in. */
const BASE = dirname(fileURLToPath(import.meta.url))
/** The skill directory whose pointers this suite verifies. */
const SKILL_DIR = join(BASE, 'skills', 'deepseek-code-supervisor')
/** The procedure file the model loads. */
const SKILL = join(SKILL_DIR, 'SKILL.md')

let passed = 0
const failures = []

/**
 * Run one named case, recording a failure instead of aborting the suite.
 * @param label - what is being checked.
 * @param body - the assertions; may be async.
 */
async function test(label, body) {
  try {
    await body()
    passed += 1
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

/** Minimal Cordis context: just enough for `apply()` to register callbacks. */
function makeCtx(extra = {}) {
  const listeners = new Map()
  return {
    listeners,
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
    },
    async fire(name, ...args) {
      let result
      for (const fn of listeners.get(name) ?? []) {
        // `next()` shape differs by event: post-execute and pre-step answer with
        // a decision object; both accept a permissive default here.
        result = await fn(...args, async () => ({ kind: 'enter', messages: [] }))
      }
      return result
    },
    tools: { guard() { return () => {} } },
    ...extra,
  }
}

// ── classification ────────────────────────────────────────────────────────
await test('source files are code', () => {  for (const file of ['a.ts', 'b.py', 'c.go', 'src/d.rs']) {
    assert.equal(classifyTarget(file), 'code', file)
  }
})

await test('dependency manifests and CI yaml are config', () => {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.env',
    '.env.local', 'ci.yml', 'requirements.txt', 'Cargo.toml',
    'Makefile', 'Dockerfile']) {
    assert.equal(classifyTarget(file), 'config', file)
  }
})

await test('prose and data stay ungated', () => {
  for (const file of ['README.md', 'notes.txt', 'data.csv', 'photo.png']) {
    assert.equal(classifyTarget(file), 'doc', file)
  }
})

// ── file-tool gate ────────────────────────────────────────────────────────
await test('gated writes are denied', () => {
  assert.notEqual(denialFor('write', { file_path: 'a.ts' }), undefined)
  assert.notEqual(denialFor('edit', { file_path: 'package.json' }), undefined)
})

await test('doc writes are allowed', () => {
  assert.equal(denialFor('write', { file_path: 'README.md' }), undefined)
})

await test('an unreadable argument shape fails closed', () => {
  assert.notEqual(denialFor('write', {}), undefined)
  assert.notEqual(denialFor('write', null), undefined)
})

await test('apply_patch is judged by its headers', () => {
  const code = '*** Begin Patch\n*** Update File: a.py\n*** End Patch'
  const doc = '*** Begin Patch\n*** Update File: a.md\n*** End Patch'
  assert.notEqual(denialFor('apply_patch', { input: code }), undefined)
  assert.equal(denialFor('apply_patch', { input: doc }), undefined)
})

await test('apply_patch takes the real `input` field, not `patch`', () => {
  // The shipped tool schema exposes `input` only; reading `patch` alone would
  // have made every real call fail closed by accident, hiding the miss.
  const text = '*** Begin Patch\n*** Update File: a.md\n*** End Patch'
  assert.equal(denialFor('apply_patch', { input: text }), undefined)
})

await test('a patch that moves a doc onto a code path is gated', () => {
  const text = '*** Begin Patch\n*** Update File: a.md\n*** Move to: b.ts\n*** End Patch'
  assert.notEqual(denialFor('apply_patch', { input: text }), undefined)
})

// ── shell channel ─────────────────────────────────────────────────────────
await test('obvious shell writes to code are caught', () => {
  for (const command of ['echo x > a.ts', 'echo x >> a.ts', 'Set-Content a.ts x',
    'Out-File a.yaml', 'sed -i s/a/b/ a.js', 'echo x | tee a.ts',
    'git apply p.diff', 'npx prettier --write .']) {
    assert.notEqual(denialFor('pwsh', { command }), undefined, command)
  }
})

await test('ordinary shell commands are not caught', () => {
  for (const command of ['ls -la', 'python build.py', 'if [ $x -gt 5 ]; then :; fi',
    'echo log >> build.log', 'git status']) {
    assert.equal(denialFor('pwsh', { command }), undefined, command)
  }
})

await test('shell targets are reported for the message', () => {
  assert.deepEqual(shellWriteTargets('echo x > a.ts'), ['a.ts'])
})

await test('every file-descriptor redirect is caught', () => {
  // `2> f`, `1>> f` and `2>> f` are ordinary redirects; missing them would let
  // the most common way to write a log or a generated file slip through.
  for (const command of ['cmd 2> a.ts', 'cmd 2>> a.ts', 'cmd 1> a.ts', 'cmd 1>> a.ts']) {
    assert.notEqual(denialFor('pwsh', { command }), undefined, command)
  }
})

await test('stream duplication is not mistaken for a file write', () => {
  for (const command of ['cmd 2>&1', 'cmd >&2', 'cmd > /dev/null', 'cmd 2> /dev/null']) {
    assert.equal(denialFor('pwsh', { command }), undefined, command)
  }
})

// ── verify: honesty of the injected claim ─────────────────────────────────
await test('a failed call injects nothing', async () => {
  const ctx = makeCtx()
  verifyApply(ctx)
  const agent = { id: 's', session: {} }
  const denied = await ctx.fire('tools/post-execute',
    { name: 'write', arguments: { file_path: 'a.ts' }, agent }, { isError: true })
  assert.equal(denied.additionalContexts, undefined)
})

await test('a successful code write injects once', async () => {
  const ctx = makeCtx()
  verifyApply(ctx)
  const agent = { id: 's', session: {} }
  const ok = await ctx.fire('tools/post-execute',
    { name: 'write', arguments: { file_path: 'a.ts' }, agent }, { isError: false })
  assert.equal(ok.additionalContexts.length, 1)
})

await test('an agent without a session attribute does not throw', async () => {
  // The public `Agent` interface declares only `id`. Keying the edit counter by
  // `agent.session` made a bare agent throw `Invalid value used as weak map key`,
  // which fails the whole post-execute waterfall instead of skipping a reminder.
  const ctx = makeCtx()
  verifyApply(ctx)
  const agent = { id: 'bare' }
  const result = await ctx.fire('tools/post-execute',
    { name: 'write', arguments: { file_path: 'a.ts' }, agent }, { isError: false })
  assert.equal(result.additionalContexts.length, 1)
})

await test('later edits in one turn drop to a short line', async () => {
  const ctx = makeCtx()
  verifyApply(ctx)
  const agent = { id: 's', session: {} }
  const exec = { name: 'write', arguments: { file_path: 'a.ts' }, agent }
  const first = await ctx.fire('tools/post-execute', exec, { isError: false })
  const second = await ctx.fire('tools/post-execute', exec, { isError: false })
  const firstText = first.additionalContexts[0].content[0].text
  const secondText = second.additionalContexts[0].content[0].text
  assert.ok(firstText.length > secondText.length * 2, 'second must be much shorter')
  assert.ok(secondText.includes('本轮第 2 次'), secondText)
})

await test('a new turn restores the full reminder', async () => {
  const ctx = makeCtx()
  verifyApply(ctx)
  const agent = { id: 's', session: {} }
  const exec = { name: 'write', arguments: { file_path: 'a.ts' }, agent }
  await ctx.fire('tools/post-execute', exec, { isError: false })
  // The turn boundary is `agent/status` reaching `idle`, not a Session event:
  // the listener only ever receives an Agent, so this is the one signal it can
  // key on.
  for (const fn of ctx.listeners.get('agent/status') ?? []) fn({ agent, status: 'idle' })
  const again = await ctx.fire('tools/post-execute', exec, { isError: false })
  assert.equal(again.additionalContexts[0].content[0].text, editReminder(['a.ts']).content[0].text)
})

// ── retro ─────────────────────────────────────────────────────────────────
await test('the newest sections win', () => {
  const text = '## A\n1\n\n## B\n2\n\n## C\n3\n'
  assert.ok(latestEntries(text).endsWith('## C\n3'))
})

await test('an oversized file is cut with a visible marker', () => {
  const text = '## S\n' + 'x'.repeat(9000)
  const out = latestEntries(text)
  assert.ok(out.includes('仅保留最近部分'), 'marker missing')
})

await test('a missing file injects nothing and does not retry forever', async () => {
  const root = join(tmpdir(), 'supervisor-retro-' + Date.now())
  mkdirSync(root, { recursive: true })
  try {
    const ctx = makeCtx({ workingDirectory: { ensure: async () => root } })
    retroApply(ctx)
    const agent = { id: 'a' }
    const step = () => ctx.fire('agent/pre-step', { agent, signal: undefined })
    const first = await step()
    assert.equal(first.messages.length, 0)
    mkdirSync(join(root, '.workbuddy'), { recursive: true })
    writeFileSync(join(root, '.workbuddy', '复盘.md'), '## E\nboom\n', 'utf8')
    const second = await step()
    assert.equal(second.messages.length, 0, 'a missing file is a finished decision')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await test('a present file is injected exactly once', async () => {
  const root = join(tmpdir(), 'supervisor-retro-' + Date.now())
  mkdirSync(join(root, '.workbuddy'), { recursive: true })
  writeFileSync(join(root, '.workbuddy', '复盘.md'), '## E\nboom\n', 'utf8')
  try {
    const ctx = makeCtx({ workingDirectory: { ensure: async () => root } })
    retroApply(ctx)
    const agent = { id: 'a' }
    const first = await ctx.fire('agent/pre-step', { agent, signal: undefined })
    assert.equal(first.messages.length, 1)
    assert.ok(first.messages[0].content[0].text.includes('boom'))
    const second = await ctx.fire('agent/pre-step', { agent, signal: undefined })
    assert.equal(second.messages.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── guard: unlock semantics ───────────────────────────────────────────────
await test('only a successful skill load opens the gate, per agent', async () => {
  const ctx = makeCtx()
  let denial = () => undefined
  ctx.tools = { guard(fn) { denial = (exec) => fn(exec); return () => {} } }
  guardApply(ctx)
  const agent = { id: 'a' }
  const other = { id: 'b' }
  const write = { name: 'write', arguments: { file_path: 'a.ts' } }

  assert.notEqual(denial({ ...write, agent }), undefined, 'locked before any load')

  ctx.listeners.get('tools/result')[0](
    { name: 'skill', arguments: { name: 'deepseek-code-supervisor' }, agent },
    { isError: true },
  )
  assert.notEqual(denial({ ...write, agent }), undefined, 'a failed load must not unlock')

  ctx.listeners.get('tools/result')[0](
    { name: 'skill', arguments: { name: 'deepseek-code-supervisor' }, agent },
    { isError: false },
  )
  assert.equal(denial({ ...write, agent }), undefined, 'unlocked for the loading agent')
  assert.notEqual(denial({ ...write, agent: other }), undefined, 'not unlocked for others')
})

// ── documentation pointers ────────────────────────────────────────────────
// SKILL.md deliberately keeps its body short and points at references/ for the
// detail. A pointer that names a section which no longer exists is worse than
// no pointer: the model follows it, finds nothing, and quietly skips the check.
await test('every reference pointer in SKILL.md resolves', () => {
  const skill = readFileSync(SKILL, 'utf8')
  const dir = join(SKILL_DIR, 'references')
  const pointers = [...skill.matchAll(/`references\/([\w.-]+\.md)`\s*([^\n,，。；]*)/g)]
  assert.ok(pointers.length > 0, 'SKILL.md should point at references/')
  for (const [, file, tail] of pointers) {
    const path = join(dir, file)
    assert.ok(existsSync(path), `missing reference file: ${file}`)
    const body = readFileSync(path, 'utf8')
    // A pointer may name a section right after the filename: "取证 8",
    // "六（部署与发布）". Anything else is prose and carries no section claim.
    const claimed = tail.trim()
    const heading = /^(取证\s*\d+|第?[一二三四五六七八九十〇]+[、.．])/.exec(claimed)
    if (heading === null) continue
    // Match the WHOLE claim, not just its first token: "取证 8" must find
    // "## 取证 8", so "取证 99" cannot pass on the strength of "## 取证 8".
    const needle = heading[1].replace(/[（(].*$/, '').trim()
    assert.ok(
      body.includes('## ' + needle) || body.includes(needle),
      `${file} has no section matching "${needle}"`,
    )
  }
})

await test('the deploy rules are not duplicated into SKILL.md', () => {
  const skill = readFileSync(SKILL, 'utf8')
  for (const phrase of ['白名单', 'SPA 兜底']) {
    assert.ok(!skill.includes(phrase), `"${phrase}" belongs in scenarios.md, not SKILL.md`)
  }
})

// ── dead code ─────────────────────────────────────────────────────────────
// An exported symbol nobody consumes is dead weight, and it is how a
// superseded helper survives a refactor. The suite counts as a consumer: these
// exports exist precisely so this file can exercise them, which is the whole
// point of testing a plugin with no other importer.
await test('no module exports a symbol nothing consumes', () => {
  const modules = ['index.js', 'guard.js', 'verify.js', 'retro.js', 'shared.js', 'client.js']
  const sources = Object.fromEntries(modules.map((f) => [f, readFileSync(join(BASE, f), 'utf8')]))
  // The suite itself is a legitimate consumer, and so is index.js's catalog.
  const selfSource = readFileSync(join(BASE, 'test.js'), 'utf8')
  const orphans = []
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/^export (?:const|function|async function) (\w+)/gm)) {
      const name = match[1]
      const word = new RegExp(`\\b${name}\\b`)
      const consumers = modules.filter((other) => other !== file && word.test(sources[other]))
      const consumedBySuite = word.test(selfSource)
      // Re-exports keep a name alive only when something outside imports it.
      const reExported = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source)
      if (consumers.length === 0 && !consumedBySuite && !reExported) orphans.push(`${file}:${name}`)
    }
  }
  assert.deepEqual(orphans, [], `dead exports: ${orphans.join(', ')}`)
})

// ── packaging contract ────────────────────────────────────────────────────
// `dsh-client-modules` serves `exports["./client"]` to the browser and identifies
// each generation by (mtime, ctime, size). The file is a browser bundle, so these
// are the conditions the loader actually relies on — a violation ships a plugin
// that silently fails to register, which no runtime test here would catch.
await test('client.js satisfies the browser bundle contract', () => {
  const pkg = JSON.parse(readFileSync(join(BASE, 'package.json'), 'utf8'))
  const rel = typeof pkg.exports['./client'] === 'string'
    ? pkg.exports['./client']
    : pkg.exports['./client']?.default
  assert.ok(typeof rel === 'string', 'exports["./client"] must name a file')

  const path = join(BASE, rel.replace(/^\.\//, ''))
  assert.ok(existsSync(path), `served bundle missing: ${rel}`)
  const source = readFileSync(path, 'utf8')

  // 1. the registration call the loader waits for
  assert.ok(source.includes('window.__ModuleLoader__.load({'), 'bundle never registers')
  // 2. the id must be the package name, or the row is published under a name
  //    nothing resolves
  const id = /id:\s*'([^']+)'/.exec(source)
  assert.equal(id?.[1], pkg.name, 'bundle id must equal the package name')
  // 3. factory form: executing the script only registers; effects run later
  assert.ok(/factory\s*\(\s*require\s*\)/.test(source), 'bundle has no factory(require)')
  // 4. a classic script, not an ES module
  assert.ok(!/^\s*import\s+/m.test(source), 'bundle must not use top-level import')
  assert.ok(!/^\s*export\s+/m.test(source), 'bundle must not use top-level export')
  // 5. nothing may execute before registration
  const preamble = source.slice(0, source.indexOf('window.__ModuleLoader__.load'))
  const executable = preamble.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(executable.trim(), '', 'statement executes before the loader call')
})

await test('shipped files cover what the market needs to render', () => {
  const pkg = JSON.parse(readFileSync(join(BASE, 'package.json'), 'utf8'))
  for (const required of ['client.js', 'locale/', 'LICENSE', 'README.md', 'presets/', 'skills/']) {
    assert.ok(pkg.files.includes(required), `${required} is not shipped in files[]`)
  }
  // Market rows read this; a missing locale means a blank listing.
  for (const lang of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(BASE, 'locale', `${lang}.json`), 'utf8'))
    assert.ok(meta.meta?.title, `${lang} locale has no title`)
    assert.ok((meta.meta?.description ?? '').length > 20, `${lang} locale description too short`)
  }
})

// ── report ────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} of ${passed + failures.length}:`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
} else {
  console.log(`dsh-deepseek-code-supervisor: ${passed} checks passed`)
}
