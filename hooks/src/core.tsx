import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { BreakpointMark, BreakpointPrompt, BreakpointRecall } from '../../types'
import { MARK_GLYPH, PROMPT_CHARS, chapterScope, clip, parseTranscript, promptAfter, recallBlock, sectionScope, squash } from '../outline'
import type { OutlineRow } from '../outline'
import { trackingOnSwitch } from './tracking'
import { transcriptOnSwitch } from './transcript'

export type Dollar = EngineInterface
export type Saved = { marks: BreakpointMark[]; prompts: BreakpointPrompt[] }

export const PANE = 'breakpoints'
export const TITLE = 'Breakpoints'
export const SESSIONS = 'sessions'
export const AUTO = 'auto'
export const KEEP_SESSIONS = 25
export const RECALL_KEEP = 4
// Bumped when labelling changes enough that saved outlines should be redone.
export const OUTLINE_VERSION = 2
export const BATCH = 40
export const MARK_TEXT = /◆ Breakpoint (\d+) · ?([^\n]*)/
// The rows parseTranscript reads: prompts, final answers, compactions, and
// slash commands with what they printed.
export const TRANSCRIPT_ROWS = [
  '-e',
  '"origin":{"kind":"human"}',
  '-e',
  '"stop_reason":"end_turn"',
  '-e',
  '"subtype":"compact_boundary"',
  '-e',
  '<command-name>',
  '-e',
  '<local-command-stdout>',
]
export const NOT_FULLSCREEN =
  'Jumping needs the fullscreen layout. On the main screen use your terminal scrollback (CLAUDE_CODE_NO_FLICKER=1 turns fullscreen on).'
export const OUTLINE_SYSTEM =
  'You keep the outline of a long conversation between a developer and a coding assistant. ' +
  'Titles are plain words naming the task or topic, written like a commit subject: ' +
  'no quotes, no trailing punctuation, no "Chapter" prefix.'

export const session = atom({ plugin: 'breakpoints', key: 'session' } as const, '')
export const marks = atom({ plugin: 'breakpoints', key: 'marks' } as const, [])
export const prompts = atom({ plugin: 'breakpoints', key: 'prompts' } as const, [])
export const tab = atom({ plugin: 'breakpoints', key: 'tab' } as const, 'outline')
export const filter = atom({ plugin: 'breakpoints', key: 'filter' } as const, '')
export const lastJump = atom({ plugin: 'breakpoints', key: 'lastJump' } as const, '')
export const auto = atom({ plugin: 'breakpoints', key: 'auto' } as const, true)
export const busy = atom({ plugin: 'breakpoints', key: 'busy' } as const, '')
export const toggled = atom({ plugin: 'breakpoints', key: 'toggled' } as const, [])
export const recall = atom({ plugin: 'breakpoints', key: 'recall' } as const, [])
export const isRecalling = atom({ plugin: 'breakpoints', key: 'isRecalling' } as const, false)

// The requestIds the transcript drew rows under, keyed by what the row says,
// tried after the stored row ids in case the two ever differ. Module memory:
// a reload refills it as rows are drawn again.
export const markRows = new Map<number, string>()
export const promptRows = new Map<string, string>()
export const answerRows = new Map<string, string>()

// Model calls run one at a time, off the hook that asked for them.
export let queue: Promise<void> = Promise.resolve()

export const rowKey = (text: string) => clip(squash(text), PROMPT_CHARS)

export const nextId = (list: readonly BreakpointMark[]) => list.reduce((top, one) => Math.max(top, one.id), 0) + 1

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

// Older saves predate automatic chapters.
export const normalise = (one: BreakpointMark): BreakpointMark => ({
  ...one,
  kind: one.kind ?? 'manual',
  anchorText: one.anchorText ?? '',
  after: one.after ?? '',
})

export function enqueue($: Dollar, job: () => Promise<void>): void {
  queue = queue.then(job).catch(error => {
    $.ui.log(`breakpoints: ${String(error)}`, { to: 'debug' })
  })
}

export const later = ($: Dollar, job: () => Promise<void>) => void $.clock.after(10, () => enqueue($, job))

// Breakpoints belong to one conversation. /clear and /resume swap it under a
// running process, so every entry point checks the id and loads that
// conversation's saved breakpoints when it changed.
export async function syncSession($: Dollar): Promise<void> {
  const id = await $.session.id()
  if ((await read($, session)) === id) return

  const saved = (await $.store.get(`s:${id}`)) as Saved | undefined
  await update($, marks, () => (saved?.marks ?? []).map(normalise))
  await update($, prompts, () => saved?.prompts ?? [])
  await update($, lastJump, () => '')
  await update($, toggled, () => [])
  await update($, session, () => id)
  trackingOnSwitch($)
  transcriptOnSwitch($)
}

export async function persist($: Dollar): Promise<void> {
  const id = await read($, session)
  if (id === '') return

  const saved: Saved = { marks: await read($, marks), prompts: await read($, prompts) }
  await $.store.set(`s:${id}`, saved)

  const known = ((await $.store.get(SESSIONS)) as string[] | undefined) ?? []
  const order = [id, ...known.filter(one => one !== id)]
  for (const old of order.slice(KEEP_SESSIONS)) {
    await $.store.delete(`s:${old}`)
  }
  await $.store.set(SESSIONS, order.slice(0, KEEP_SESSIONS))
}

// Where Claude Code keeps this conversation: <config>/projects/<dir>/<id>.jsonl,
// <dir> being the start directory with every non-alphanumeric turned into "-".
export async function transcriptPath($: Dollar, id: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? ''
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const config = (configured ?? `${home}/.claude`).replace(/^~/, home).replace(/\/$/, '')

  for (const dir of new Set([await $.session.root(), await $.session.cwd()])) {
    const path = `${config}/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
    if (await $.fs.exists(path)) return path
  }

  return undefined
}

// The person's prompts and Claude's final answers, read from the transcript
// file: it keeps every row, compacted ones included.
export async function readTranscript($: Dollar, id: string): Promise<ReturnType<typeof parseTranscript>> {
  const path = await transcriptPath($, id)
  const run = path === undefined ? undefined : await $.process.run(['grep', '-F', ...TRANSCRIPT_ROWS, path], { timeoutMs: 15_000 })

  return run?.exitCode === 0 ? parseTranscript(run.stdout) : { prompts: [], answers: new Map(), words: new Map(), events: [] }
}

export async function askHaiku($: Dollar, prompt: string, maxTokens: number, timeoutMs: number): Promise<string | null> {
  const reply = await $.model.complete({ model: 'haiku', system: OUTLINE_SYSTEM, prompt, maxTokens, effort: 'low', timeoutMs })

  return reply.isAnswered ? reply.text.trim() : null
}

// Pins part of the conversation, word for word, to the person's next message.
export async function recallRow($: Dollar, row: OutlineRow): Promise<void> {
  const said = await read($, prompts)
  const all = (await read($, marks)).filter(one => one.isRemoved !== true)
  const after = (mark: BreakpointMark) => said.filter(one => one.uuid === mark.after)
  const [what, glyph, title, scope] =
    row.kind === 'chapter'
      ? ['chapter', '◇', row.mark.label, chapterScope(row.mark, all, said)]
      : row.kind === 'section'
        ? ['sub-topic', '›', row.title, sectionScope(row.prompt, all, said)]
        : row.kind === 'answer'
          ? ['answer', '↳', row.title, [row.prompt]]
          : row.mark.kind === 'auto'
            ? ['chapter', '◇', row.mark.label, chapterScope(row.mark, all, said)]
            : row.mark.kind === 'star'
              ? ['answer', '☆', row.mark.label, after(row.mark)]
              : // A /bp, a compaction or a command: the exchange it came after.
                [
                  row.mark.kind === 'manual' ? 'breakpoint' : `exchange before a ${row.mark.kind === 'compact' ? 'compaction' : 'command'}`,
                  MARK_GLYPH[row.mark.kind],
                  row.mark.label,
                  after(row.mark),
                ]

  const found = await readTranscript($, await read($, session))
  const exchanges = scope.map(prompt => ({
    prompt: found.words.get(prompt.uuid) ?? prompt.text,
    answer: found.answers.get(prompt.uuid)?.text ?? '',
  }))
  if (exchanges.length === 0) {
    $.ui.toast('Nothing to recall there yet.')

    return
  }

  const pinned: BreakpointRecall = {
    key: `${what}:${scope[0]?.uuid ?? ''}`,
    glyph,
    label: title,
    what: exchanges.length > 1 ? `${what}, ${exchanges.length} exchanges` : what,
    text: recallBlock(what, title, exchanges),
  }
  await update($, recall, list => [...list.filter(one => one.key !== pinned.key), pinned].slice(-RECALL_KEEP))
  await update($, isRecalling, () => false)
  await $.ui.close({ id: PANE })

  const box = await $.prompt.read()
  if (box.text.trim() === '') await $.prompt.fill({ text: `Re ${glyph} "${title}": ` })
}

export async function jump(
  $: Dollar,
  key: string,
  candidates: readonly string[],
  block: 'start' | 'end',
  isFullscreen: boolean | undefined,
): Promise<void> {
  let reason = 'that part of the conversation has not been drawn'

  for (const requestId of new Set(candidates.filter(one => one !== ''))) {
    try {
      const moved = await $.ui.scroll({ to: { requestId }, block })
      if (moved.deny === undefined) {
        await update($, lastJump, () => key)

        return
      }
      reason = moved.deny
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    }
  }

  $.ui.toast(isFullscreen === false ? NOT_FULLSCREEN : `Could not jump there: ${reason}`)
}

// A /bp mark lands its row at the bottom of the screen, showing what led up to
// it; a chapter, a sub-topic and an answer land at the top. A compaction or a
// command lands its own row at the top, or else the prompt that came after it.
export async function jumpToMark($: Dollar, mark: BreakpointMark, isFullscreen: boolean | undefined): Promise<void> {
  if (mark.kind === 'compact' || mark.kind === 'command') {
    const next = promptAfter(await read($, prompts), mark.after)

    return jump($, `mark:${mark.id}`, [mark.anchor, next?.uuid ?? ''], 'start', isFullscreen)
  }

  return mark.kind === 'auto'
    ? jump($, `mark:${mark.id}`, [mark.anchor, promptRows.get(mark.anchorText) ?? ''], 'start', isFullscreen)
    : mark.kind === 'star'
      ? jump($, `mark:${mark.id}`, [mark.anchor, answerRows.get(mark.anchorText) ?? ''], 'start', isFullscreen)
      : jump($, `mark:${mark.id}`, [markRows.get(mark.id) ?? '', mark.anchor], 'end', isFullscreen)
}

export const jumpToPrompt = ($: Dollar, prompt: BreakpointPrompt, isFullscreen: boolean | undefined) =>
  jump($, `prompt:${prompt.uuid}`, [prompt.uuid, promptRows.get(prompt.text) ?? ''], 'start', isFullscreen)

export const jumpToAnswer = ($: Dollar, prompt: BreakpointPrompt, isFullscreen: boolean | undefined) =>
  jump(
    $,
    `answer:${prompt.uuid}`,
    [prompt.answer ?? '', answerRows.get(prompt.answerText ?? '') ?? ''],
    'start',
    isFullscreen,
  )
