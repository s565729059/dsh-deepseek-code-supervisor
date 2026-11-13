/**
 * dsh-deepseek-code-supervisor — 复盘注入.
 *
 * On the first step of every session in this mode, read `.workbuddy/复盘.md`
 * from the session's working directory and append the latest entries as a
 * user-role context message. The file is the accumulated post-mortems of the
 * project; injecting it once at the start lets the agent avoid repeating a
 * judgement error it already recorded, without paying that context on every
 * request (it is read once per session).
 *
 * Three things this row refuses to do:
 *
 *   - **Mark a read it did not complete.** The "already injected" flag is set
 *     only after a successful read, so a missing file or a transient I/O error
 *     leaves the injection armed for the next step instead of silently
 *     forfeiting it for the whole session.
 *   - **Hand over a truncated section without saying so.** The size budget cuts
 *     from the front (the newest entries are at the end of an append-only log),
 *     and the cut is announced — an unmarked partial section reads as complete.
 *   - **Read a whole file to use its tail.** Only the last slice of a large
 *     file is loaded, so a pathological log cannot block the step.
 *
 * Missing file, empty file and unreadable file are all silent no-ops *for the
 * model*: the plugin stays out of the transcript, and there is nothing for the
 * agent to act on.
 *
 * @module dsh-deepseek-code-supervisor/retro
 */

import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'code-supervisor-retro'

/** The working directory service that resolves the session cwd. */
export const inject = ['workingDirectory']

/** Retrospective file, relative to the session working directory. */
const RETRO_FILE = join('.workbuddy', '复盘.md')

/** Keep the injection small: at most this many `##` sections… */
const MAX_ENTRIES = 5
/**
 * …and at most this many UTF-16 code units. Unit chosen by `String.length`,
 * which is what the budget is compared against; a Chinese character is 3 UTF-8
 * bytes, so the byte cost of a full budget is roughly 3× this number.
 */
const MAX_CHARS = 4000
/** Longest tail read: enough for MAX_ENTRIES sections of ordinary length. */
const MAX_READ_BYTES = 256 * 1024

/**
 * Read at most the last `MAX_READ_BYTES` of a file as UTF-8. A cut can land
 * mid-codepoint; the replacement character it produces sits in text that is
 * about to be trimmed or dropped by section splitting anyway.
 *
 * A missing file is a finished answer (`absent`); any other failure is not, and
 * the caller retries it on a later step rather than forfeiting the session.
 * @param path - absolute file path.
 * @returns the tail text, `absent`, or `failed`.
 */
function readTail(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const stats = fstatSync(fd)
    // Opening a directory succeeds on Windows and reports size 0, which is
    // indistinguishable from an empty file unless the type is checked. Treat a
    // non-file as a failure so a stray directory does not silently finish the
    // injection with zero content.
    if (!stats.isFile()) return { kind: 'failed' }
    const size = stats.size
    const length = Math.min(size, MAX_READ_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, size - length)
    return { kind: 'text', text: buffer.toString('utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'failed' }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* already closed */ }
  }
}

/**
 * Take the newest `##` sections of the retrospective file.
 *
 * The file is append-only, so the newest entries are at the end. A leading
 * partial section — the price of reading only a tail — is dropped rather than
 * passed off as a whole entry.
 * @param text - whole file, or its tail.
 * @returns the tail of the file, trimmed to the size budget.
 */
export function latestEntries(text) {
  const sections = text.split(/\n(?=## )/u).filter((section) => section.trim().length > 0)
  const joined = sections.slice(-MAX_ENTRIES).join('\n').trim()
  if (joined.length <= MAX_CHARS) return joined
  // Cut from the front: keep the newest text and say that the head is missing.
  const note = '\n…（复盘内容过长，仅保留最近部分）'
  const keep = Math.max(0, MAX_CHARS - note.length)
  return joined.slice(joined.length - keep) + note
}

/**
 * Register the one-shot retrospective injection.
 * @param ctx - agent-scoped context carrying the working directory service.
 */
export function apply(ctx) {
  const injected = new WeakSet()

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (injected.has(agent)) return decision

    let read
    try {
      const cwd = await ctx.workingDirectory.ensure(agent, signal)
      read = readTail(join(cwd, RETRO_FILE))
    } catch {
      return decision
    }
    // A missing or empty file is a finished decision; a read that failed for
    // another reason is not, and the next step gets another try.
    if (read.kind === 'failed') return decision
    injected.add(agent)
    if (read.kind === 'absent') return decision
    const entries = latestEntries(read.text)
    if (entries.length === 0) return decision

    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          id: randomUUID(),
          role: 'user',
          source: { kind: 'retro-context', form: 'instructions' },
          content: [{
            type: 'text',
            text: '<retro_context>\n本项目历史复盘的最近几条（来自 .workbuddy/复盘.md）。开工前先扫一眼，别重复已经记录过的同类判断错误：\n\n' + entries + '\n</retro_context>',
          }],
        },
      ],
    }
  })
}
