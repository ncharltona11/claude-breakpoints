import type { BreakpointMark, BreakpointPrompt } from '../types'

export const PROMPT_CHARS = 160
export const RECALL_CHARS = 80_000

export type FoundPrompt = Omit<BreakpointPrompt, 'n'>
export type FoundAnswer = { uuid: string; text: string }
// A compaction or a slash command found in the transcript file, and the last
// prompt before it ('' when it came before any).
export type FoundEvent = { kind: 'compact' | 'command'; uuid: string; at: number; label: string; after: string }
export type Label = { n: number; chapter: string; section: string; answer: string }

export type OutlineRow =
  | { kind: 'chapter'; mark: BreakpointMark; isOpen: boolean; sections: number }
  | { kind: 'section'; prompt: BreakpointPrompt; title: string; isNested: boolean }
  | { kind: 'answer'; prompt: BreakpointPrompt; title: string; isNested: boolean }
  | { kind: 'mark'; mark: BreakpointMark; isNested: boolean }

export const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

// How each kind of mark is drawn: chapter, your /bp, a starred answer, a
// compaction, a slash command.
export const MARK_GLYPH: Record<BreakpointMark['kind'], string> = { auto: '◇', manual: '◆', star: '☆', compact: '⇊', command: '⌘' }
export const MARK_COLOR: Record<BreakpointMark['kind'], string> = {
  auto: 'cyan',
  manual: 'magenta',
  star: 'yellow',
  compact: 'blue',
  command: 'gray',
}

// The mod's own commands are the outline's controls, and /compact shows as
// its compaction: none of them is a hint.
export const QUIET_COMMANDS = new Set(['bp', 'bps', 'compact'])
const COMMAND_ROW = /^<command-name>\/?([^<\s]+)<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/
const OUTPUT_ROW = /^<local-command-stdout>([\s\S]*?)(?:<\/local-command-stdout>|$)/
const COLOUR_CODES = /\u001b\[[0-9;]*m/g

export const clip = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`

export const cleanTitle = (text: string) =>
  clip(
    squash(text)
      .replace(/^(chapter|title|sub-?topic|answer)\s*:\s*/i, '')
      .replace(/^["'“”‘’`*]+|["'“”‘’`*.!]+$/g, ''),
    60,
  )

export function textOf(content: readonly unknown[]): string {
  return content
    .map(block => {
      const one = block as { type?: unknown; text?: unknown }

      return one.type === 'text' && typeof one.text === 'string' ? one.text : ''
    })
    .join('\n')
}

type TranscriptRow = {
  type?: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  origin?: { kind?: string }
  content?: unknown
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number }
  message?: { content?: unknown; stop_reason?: unknown }
}

const thousands = (tokens: number) => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens))

// "Compacted · 658k → 11k tokens", or "Auto-compacted" when Claude Code did it
// at its limit.
export function compactLabel(meta: TranscriptRow['compactMetadata']): string {
  const how = meta?.trigger === 'auto' ? 'Auto-compacted' : 'Compacted'
  const before = meta?.preTokens
  const after = meta?.postTokens

  return typeof before === 'number' && typeof after === 'number' ? `${how} · ${thousands(before)} → ${thousands(after)} tokens` : how
}

// The rows of a transcript file that matter here, in file order: the person's
// own prompts, the final answer of each turn (the last end_turn text before
// the next prompt is that prompt's answer), compactions, and slash commands
// with the first line they printed.
export function parseTranscript(stdout: string): {
  prompts: FoundPrompt[]
  answers: Map<string, FoundAnswer>
  words: Map<string, string>
  events: FoundEvent[]
} {
  const prompts: FoundPrompt[] = []
  const answers = new Map<string, FoundAnswer>()
  const words = new Map<string, string>()
  const events: FoundEvent[] = []
  const commands = new Map<string, FoundEvent>()
  let current: string | undefined

  for (const line of stdout.split('\n')) {
    let row: TranscriptRow
    try {
      row = JSON.parse(line) as TranscriptRow
    } catch {
      continue
    }
    if (typeof row.uuid !== 'string' || row.isSidechain === true || row.isMeta === true) continue

    const content = row.message?.content
    const blocks = Array.isArray(content) ? content : []
    const raw = (typeof content === 'string' ? content : textOf(blocks)).trim()
    const text = squash(raw)
    const at = Date.parse(row.timestamp ?? '') || 0

    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      events.push({ kind: 'compact', uuid: row.uuid, at, label: compactLabel(row.compactMetadata), after: current ?? '' })
      continue
    }
    // A command's echo and what it printed: system rows for most, user rows
    // for the ones that open a picker (/model, /effort).
    const notice =
      row.type === 'system' && row.subtype === 'local_command' && typeof row.content === 'string'
        ? row.content.trim()
        : row.type === 'user' && row.origin?.kind !== 'human'
          ? raw
          : ''
    const command = COMMAND_ROW.exec(notice)
    if (command !== null) {
      const name = (command[1] ?? '').toLowerCase()
      const args = squash(command[2] ?? '')
      if (!QUIET_COMMANDS.has(name)) {
        const event: FoundEvent = { kind: 'command', uuid: row.uuid, at, label: `/${name}${args === '' ? '' : ` ${clip(args, 40)}`}`, after: current ?? '' }
        events.push(event)
        commands.set(row.uuid, event)
      }
      continue
    }
    const output = OUTPUT_ROW.exec(notice)
    if (output !== null) {
      const event = commands.get(row.parentUuid ?? '')
      const first = (output[1] ?? '').replace(COLOUR_CODES, '').split('\n').map(squash).find(one => one !== '') ?? ''
      if (event !== undefined && first !== '') event.label = `${event.label} · ${clip(first, 60)}`
      continue
    }

    if (row.type === 'user' && row.origin?.kind === 'human') {
      const hasToolResult = blocks.some(block => (block as { type?: unknown }).type === 'tool_result')
      if (hasToolResult || text === '' || text.startsWith('<')) continue

      prompts.push({ uuid: row.uuid, text: clip(text, PROMPT_CHARS), at })
      words.set(row.uuid, raw)
      current = row.uuid
    } else if (row.type === 'assistant' && row.message?.stop_reason === 'end_turn' && text !== '' && current) {
      answers.set(current, { uuid: row.uuid, text: raw })
    }
  }

  return { prompts, answers, words, events }
}

// Compactions and commands not yet among the marks are added; one whose label
// grew (its output was written after the first read) is updated. The same list
// comes back when nothing changed. A removed one stays removed.
export function withEvents(list: readonly BreakpointMark[], events: readonly FoundEvent[]): readonly BreakpointMark[] {
  const known = new Map(list.filter(one => one.kind === 'compact' || one.kind === 'command').map(one => [one.anchor, one]))
  let next: BreakpointMark[] | undefined
  let top = list.reduce((most, one) => Math.max(most, one.id), 0)

  for (const event of events) {
    const kept = known.get(event.uuid)
    if (kept !== undefined && (kept.label === event.label || kept.isRenamed === true)) continue
    next ??= [...list]
    if (kept !== undefined) {
      next = next.map(one => (one.id === kept.id ? { ...one, label: event.label } : one))
      continue
    }
    top += 1
    const mark: BreakpointMark = { id: top, kind: event.kind, label: event.label, anchor: event.uuid, anchorText: '', after: event.after, at: event.at }
    next.push(mark)
    known.set(event.uuid, mark)
  }

  return next ?? list
}

// The first prompt after a mark that sits between prompts: where a jump lands
// when the mark's own row is not on screen.
export function promptAfter(said: readonly BreakpointPrompt[], after: string): BreakpointPrompt | undefined {
  if (after === '') return said[0]
  const at = said.findIndex(one => one.uuid === after)

  return at < 0 ? undefined : said[at + 1]
}

const dash = (text: string) => {
  const title = cleanTitle(text)

  return /^[-–—_]*$/.test(title) || /^(none|same|n\/a)$/i.test(title) ? '' : title
}

// "<number> | <chapter or -> | <sub-topic or -> | <answer>"
export function parseLabels(reply: string): Label[] {
  // Numbered like "[4]" or "4." too; a heading or a blank line is skipped.
  return reply.split('\n').flatMap(line => {
    const found = /^\s*\[?(\d+)\]?\.?\s*\|([^|]*)\|([^|]*)\|(.*)$/.exec(line)

    return found
      ? [{ n: Number(found[1]), chapter: dash(found[2] ?? ''), section: dash(found[3] ?? ''), answer: dash(found[4] ?? '') }]
      : []
  })
}

// Where a mark sits among the prompts: a chapter just before the prompt it
// opens, a /bp just after the prompt it followed.
export function markPlace(mark: BreakpointMark, index: ReadonlyMap<string, number>): number {
  if (mark.kind !== 'auto' && mark.after === '') return -1
  const at = index.get(mark.kind === 'auto' ? mark.anchor : mark.after)
  if (at === undefined) return Number.MAX_SAFE_INTEGER

  return mark.kind === 'auto' ? at * 3 : at * 3 + 2
}

export function orderedMarks(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): BreakpointMark[] {
  const index = new Map(said.map((one, at) => [one.uuid, at]))

  return [...all].sort((a, b) => markPlace(a, index) - markPlace(b, index) || a.at - b.at || a.id - b.id)
}

// Chapters, then the sub-topics in each, then what Claude answered. A prompt
// labelled without a sub-topic is a follow-up: its answer joins the sub-topic
// above it. Only the last chapter starts open; `toggled` flips the rest.
export function buildOutline(
  all: readonly BreakpointMark[],
  said: readonly BreakpointPrompt[],
  toggled: readonly number[],
  isAllOpen = false,
): OutlineRow[] {
  const index = new Map(said.map((one, at) => [one.uuid, at]))
  const chapters = all.filter(one => one.kind === 'auto' && index.has(one.anchor))
  const chapterAt = new Map(chapters.map(one => [one.anchor, one]))
  const lastChapter = chapters.reduce<BreakpointMark | undefined>(
    (latest, one) => (latest === undefined || (index.get(one.anchor) ?? 0) > (index.get(latest.anchor) ?? 0) ? one : latest),
    undefined,
  )
  const manual = orderedMarks(
    all.filter(one => one.kind !== 'auto'),
    said,
  )
  const marksAfter = (uuid: string) => manual.filter(one => one.after === uuid)
  const isOpen = (mark: BreakpointMark) => isAllOpen || (mark === lastChapter) !== toggled.includes(mark.id)

  const rows: OutlineRow[] = manual
    .filter(one => one.after === '' || !index.has(one.after))
    .map(mark => ({ kind: 'mark' as const, mark, isNested: false }))
  let chapter: Extract<OutlineRow, { kind: 'chapter' }> | undefined
  let hasSection = false

  for (const prompt of said) {
    const opens = chapterAt.get(prompt.uuid)
    if (opens !== undefined) {
      chapter = { kind: 'chapter', mark: opens, isOpen: isOpen(opens), sections: 0 }
      rows.push(chapter)
      hasSection = false
    }
    const isNested = chapter !== undefined
    const isShown = chapter === undefined || chapter.isOpen
    const title = prompt.isLabelled === true ? (prompt.title ?? '') : ''

    if (title !== '' || prompt.isLabelled !== true || !hasSection) {
      if (chapter !== undefined) chapter.sections += 1
      hasSection = true
      if (isShown) rows.push({ kind: 'section', prompt, title: title || clip(prompt.text, 60), isNested })
    }
    const answer = prompt.answerTitle ?? (prompt.answerText !== undefined ? clip(prompt.answerText, 60) : '')
    if (isShown && answer !== '' && prompt.answer !== undefined) {
      rows.push({ kind: 'answer', prompt, title: answer, isNested })
    }
    if (isShown) {
      for (const mark of marksAfter(prompt.uuid)) rows.push({ kind: 'mark', mark, isNested })
    }
  }

  return rows
}

// The outline searched: every row whose words match, its chapter kept above it.
export function filterOutline(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[], query: string): OutlineRow[] {
  const full = buildOutline(all, said, [], true)
  const matches = (text: string) => text.toLowerCase().includes(query)
  const kept: OutlineRow[] = []
  let chapter: OutlineRow | undefined
  let isChapterKept = false

  for (const row of full) {
    if (row.kind === 'chapter') {
      chapter = row
      isChapterKept = matches(row.mark.label)
      if (isChapterKept) kept.push(row)
      continue
    }
    const text =
      row.kind === 'mark' ? row.mark.label : row.kind === 'section' ? `${row.title} ${row.prompt.text}` : `${row.title} ${row.prompt.answerText ?? ''}`
    if (!matches(text)) continue
    if (chapter !== undefined && !isChapterKept) {
      kept.push(chapter)
      isChapterKept = true
    }
    kept.push(row)
  }

  return kept
}

export function labelRequest(
  chapter: string,
  recent: readonly string[],
  batch: readonly BreakpointPrompt[],
  answers: ReadonlyMap<string, string>,
): string {
  const exchanges = batch
    .map(prompt => {
      const answer = answers.get(prompt.uuid) ?? prompt.answerText ?? ''

      return `[${prompt.n}] Developer: ${clip(prompt.text, 300)}\n     Assistant: ${answer === '' ? '(no answer)' : clip(squash(answer), 500)}`
    })
    .join('\n')

  return (
    `Current chapter: ${chapter === '' ? '(none yet)' : chapter}\n` +
    `Recent sub-topics: ${recent.length === 0 ? '(none)' : recent.join('; ')}\n\n` +
    `Exchanges, in order:\n${exchanges}\n\n` +
    `Reply with exactly ${batch.length} line${batch.length === 1 ? '' : 's'}, one per exchange, numbered ` +
    `${batch.map(prompt => prompt.n).join(', ')}, never merging two exchanges into one line:\n` +
    '<number> | <chapter> | <sub-topic> | <answer>\n' +
    '- chapter: a new chapter title when this exchange starts a different task or topic, otherwise -\n' +
    '- sub-topic: 2 to 6 words naming what this exchange is about, or - when it only continues the previous ' +
    'exchange (a short follow-up such as "yes", "do it", "continue", or a small correction)\n' +
    '- answer: 3 to 8 words saying what the assistant did or concluded\n' +
    (chapter === '' ? 'There is no chapter yet, so the first exchange starts one.\n' : '') +
    'Reply with the lines only.'
  )
}

const chapterStarts = (all: readonly BreakpointMark[]) =>
  new Set(all.filter(one => one.kind === 'auto' && one.isRemoved !== true).map(one => one.anchor))

// The exchanges a chapter holds: from its opening prompt to the next chapter.
export function chapterScope(mark: BreakpointMark, all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): BreakpointPrompt[] {
  const start = said.findIndex(one => one.uuid === mark.anchor)
  if (start < 0) return []
  const starts = chapterStarts(all)
  let end = start + 1
  while (end < said.length && !starts.has(said[end]?.uuid ?? '')) end += 1

  return said.slice(start, end)
}

// The exchanges a sub-topic holds: its prompt and the follow-ups merged into it.
export function sectionScope(prompt: BreakpointPrompt, all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): BreakpointPrompt[] {
  const start = said.findIndex(one => one.uuid === prompt.uuid)
  if (start < 0) return []
  const starts = chapterStarts(all)
  let end = start + 1
  while (end < said.length) {
    const next = said[end]
    if (next === undefined || starts.has(next.uuid) || next.isLabelled !== true || (next.title ?? '') !== '') break
    end += 1
  }

  return said.slice(start, end)
}

// What a recalled part of the conversation reads as, for the model: the
// developer's words and the assistant's final answers, quoted as they were.
export function recallBlock(what: string, title: string, exchanges: readonly { prompt: string; answer: string }[]): string {
  const body = exchanges
    .map(one => `Developer:\n${one.prompt}\n\nAssistant:\n${one.answer === '' ? '(no final answer recorded)' : one.answer}`)
    .join('\n\n---\n\n')

  return (
    `<recalled_context what="${what}" title="${title.replace(/"/g, "'")}">\n` +
    'The developer pulled this earlier part of the conversation back as context for their message. ' +
    'It is quoted word for word from the transcript (prompts and final answers, tool calls left out); ' +
    'the details may since have been compacted out of the conversation.\n\n' +
    `${clip(body, RECALL_CHARS)}\n</recalled_context>`
  )
}

// A reply names every exchange it was asked about, each once: anything else
// means the model merged or skipped lines, and its numbering cannot be trusted.
export function isComplete(batch: readonly BreakpointPrompt[], labels: readonly Label[]): boolean {
  const numbers = labels.map(one => one.n)

  return numbers.length === batch.length && batch.every(prompt => numbers.filter(n => n === prompt.n).length === 1)
}

// Two chapter titles name the same topic when they match ignoring case,
// spacing and punctuation: "Login bug" and "login bug!".
export const isSameTitle = (a: string, b: string) => {
  const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

  return plain(a) === plain(b)
}

// The chapter in effect just before a prompt: the last live chapter opening
// at an earlier prompt.
export function chapterBefore(
  all: readonly BreakpointMark[],
  said: readonly BreakpointPrompt[],
  uuid: string,
): BreakpointMark | undefined {
  const index = new Map(said.map((one, at) => [one.uuid, at]))
  const at = index.get(uuid) ?? -1

  return all
    .filter(one => one.kind === 'auto' && one.isRemoved !== true && (index.get(one.anchor) ?? at) < at)
    .sort((a, b) => (index.get(a.anchor) ?? 0) - (index.get(b.anchor) ?? 0))
    .at(-1)
}

// Chapters that only repeat the title of the chapter before them: the model
// sometimes declares a "new" chapter and names it after the current one.
export function repeatedChapters(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): number[] {
  return all
    .filter(one => one.kind === 'auto' && one.isRemoved !== true && one.isRenamed !== true)
    .filter(one => {
      const before = chapterBefore(all, said, one.anchor)

      return before !== undefined && isSameTitle(before.label, one.label)
    })
    .map(one => one.id)
}
