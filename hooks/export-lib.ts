import type { SessionMessage } from 'claude-code'

import type { BreakpointMark, BreakpointPrompt } from '../types'
import { MARK_GLYPH, buildOutline, clip, squash } from './outline'

export const EXPORT_DIR = 'docs/conversations'
export const OUTLINE_MARK = '<conversation_outline>'
export const OUTLINE_CHARS = 6000

export type ExportTarget = { kind: 'newest' } | { kind: 'all' } | { kind: 'number'; n: number } | { kind: 'words'; words: string }

export type ExportArgs = { target: ExportTarget; withSummary: boolean }

export type ExportScope = { title: string; prompts: BreakpointPrompt[]; isWhole: boolean }

export type ExportExchange = { prompt: BreakpointPrompt; words: string; answer: string }

// `/bps export [n|words|all] [--summary]`, everything after `export`.
export function parseExportArgs(rest: string): ExportArgs {
  const words = squash(rest).split(' ').filter(one => one !== '')
  const withSummary = words.some(one => one === '--summary' || one === '-s')
  const left = words.filter(one => one !== '--summary' && one !== '-s').join(' ')

  const target: ExportTarget =
    left === ''
      ? { kind: 'newest' }
      : left.toLowerCase() === 'all'
        ? { kind: 'all' }
        : /^\d+$/.test(left)
          ? { kind: 'number', n: Number(left) }
          : { kind: 'words', words: left }

  return { target, withSummary }
}

// The chapters that are on the outline, in conversation order.
export function exportChapters(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): BreakpointMark[] {
  const index = new Map(said.map((one, at) => [one.uuid, at]))

  return all
    .filter(one => one.kind === 'auto' && one.isRemoved !== true && index.has(one.anchor))
    .sort((a, b) => (index.get(a.anchor) ?? 0) - (index.get(b.anchor) ?? 0))
}

// Which prompts an export covers: one chapter (to the next chapter), or all.
export function exportScope(
  args: ExportArgs,
  all: readonly BreakpointMark[],
  said: readonly BreakpointPrompt[],
): ExportScope | { error: string } {
  if (said.length === 0) return { error: 'Nothing to export yet: this conversation has no prompts recorded.' }

  const chapters = exportChapters(all, said)
  const whole: ExportScope = { title: chapters.length === 1 ? chapters[0]?.label ?? 'Conversation' : 'Conversation', prompts: [...said], isWhole: true }
  const target = args.target

  if (target.kind === 'all' || chapters.length === 0) {
    if (target.kind === 'number' || target.kind === 'words') {
      return { error: 'This conversation has no chapters yet; `/bps export all` exports all of it.' }
    }

    return whole
  }

  const chapter =
    target.kind === 'newest'
      ? chapters.at(-1)
      : target.kind === 'number'
        ? chapters[target.n - 1]
        : chapters.find(one => one.label.toLowerCase().includes(target.words.toLowerCase()))

  if (chapter === undefined) {
    const which = target.kind === 'number' ? `number ${target.n}` : `matching "${target.kind === 'words' ? target.words : ''}"`

    return { error: `No chapter ${which}. There ${chapters.length === 1 ? 'is 1 chapter' : `are ${chapters.length} chapters`}: ${chapters.map((one, at) => `${at + 1}. ${one.label}`).join(', ')}.` }
  }

  const start = said.findIndex(one => one.uuid === chapter.anchor)
  const starts = new Set(chapters.map(one => one.anchor))
  let end = start + 1
  while (end < said.length && !starts.has(said[end]?.uuid ?? '')) end += 1

  return { title: chapter.label, prompts: said.slice(start, end), isWhole: false }
}

export const exportSlug = (text: string) =>
  squash(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'conversation'

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

// <dir>/<yyyy-mm-dd>-<slug>.md, then -2, -3 for a name already taken.
export function exportFileName(dir: string, title: string, at: number, attempt: number): string {
  return `${dir.replace(/\/+$/, '')}/${day(at)}-${exportSlug(title)}${attempt > 1 ? `-${attempt}` : ''}.md`
}

// The folder an export goes to: an absolute path as given, `~/` under home,
// anything else under the project root.
export function exportDirectory(option: string, root: string, home: string): string {
  const dir = option.trim() === '' ? EXPORT_DIR : option.trim()
  if (dir.startsWith('/')) return dir
  if (dir === '~' || dir.startsWith('~/')) return `${home}${dir.slice(1)}`

  return `${root.replace(/\/+$/, '')}/${dir.replace(/^\.\//, '')}`
}

// The exported part as an outline: sub-topics and what Claude answered, with
// the chapters too when the export spans more than one.
function exportOutlineLines(
  all: readonly BreakpointMark[],
  said: readonly BreakpointPrompt[],
  scope: ExportScope,
): string[] {
  const inScope = new Set(scope.prompts.map(one => one.uuid))
  const nest = scope.isWhole && exportChapters(all, said).length > 1 ? '  ' : ''

  return buildOutline(all, said, [], true).flatMap(row => {
    if (row.kind === 'chapter') return nest !== '' && inScope.has(row.mark.anchor) ? [`- **${row.mark.label}**`] : []
    if (row.kind === 'section') return inScope.has(row.prompt.uuid) ? [`${nest}- ${row.title}`] : []
    if (row.kind === 'answer') return inScope.has(row.prompt.uuid) ? [`${nest}  - ↳ ${row.title}`] : []
    if (!inScope.has(row.mark.after)) return []

    return [`${nest}  - ${MARK_GLYPH[row.mark.kind]} ${row.mark.label}`]
  })
}

export function exportMarkdown(input: {
  scope: ExportScope
  all: readonly BreakpointMark[]
  said: readonly BreakpointPrompt[]
  exchanges: readonly ExportExchange[]
  sessionId: string
  exportedAt: number
  summary?: string
}): string {
  const { scope, exchanges } = input
  const times = exchanges.map(one => one.prompt.at).filter(at => at > 0)
  const from = times.length > 0 ? minute(Math.min(...times)) : ''
  const to = times.length > 0 ? minute(Math.max(...times)) : ''
  const span = from === '' ? '' : from === to ? `, ${from} UTC` : `, ${from} to ${to} UTC`
  const count = `${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}`
  const outline = exportOutlineLines(input.all, input.said, scope)

  const parts = [
    `# ${scope.title}`,
    `Exported ${day(input.exportedAt)} from Claude Code conversation \`${input.sessionId}\`: ${count}${span}.`,
  ]
  if (input.summary !== undefined && input.summary.trim() !== '') parts.push(input.summary.trim())
  if (outline.length > 0) parts.push(`## Outline\n\n${outline.join('\n')}`)
  parts.push('## Conversation')

  for (const [at, one] of exchanges.entries()) {
    const heading = one.prompt.isLabelled === true ? one.prompt.title || 'Follow-up' : clip(one.prompt.text, 60)
    const when = one.prompt.at > 0 ? ` (${minute(one.prompt.at)} UTC)` : ''
    parts.push(
      `### ${at + 1}. ${heading}`,
      `**Developer**${when}\n\n${one.words.trim()}`,
      `**Claude**\n\n${one.answer.trim() === '' ? '_No final answer recorded._' : one.answer.trim()}`,
    )
  }

  return `${parts.join('\n\n')}\n`
}

// What Haiku is asked for an export's summary section.
export function exportSummaryRequest(title: string, exchanges: readonly ExportExchange[]): string {
  const room = Math.max(2000, Math.floor(60_000 / Math.max(1, exchanges.length)))
  const body = exchanges
    .map(one => `Developer: ${clip(one.words.trim(), room)}\n\nAssistant: ${clip(one.answer.trim(), room) || '(no final answer)'}`)
    .join('\n\n---\n\n')

  return (
    `This is part of a conversation between a developer and a coding assistant, titled "${title}":\n\n${body}\n\n` +
    'Write notes for the developer in markdown, exactly three sections and nothing else:\n' +
    '## Summary\n3 to 5 plain sentences on what was done and where it ended.\n' +
    '## Decisions\nBullets of what was decided or built. "None" if nothing was.\n' +
    '## Open questions\nBullets of what is unresolved or untested. "None" if nothing is.'
  )
}

// The table of contents kept through a compaction: chapters, sub-topics and
// answer titles, shrinking to fit (answers go first, then the oldest chapters).
export function compactionOutline(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): string | null {
  const rows = buildOutline(all, said, [], true)
  if (!rows.some(row => row.kind === 'chapter' || (row.kind === 'section' && row.prompt.isLabelled === true))) return null

  const lines = (withAnswers: boolean) =>
    rows.flatMap(row => {
      if (row.kind === 'chapter') return [`◇ ${row.mark.label}`]
      if (row.kind === 'section') return [`${row.isNested ? '  ' : ''}› ${row.title}`]
      if (row.kind === 'answer') return withAnswers ? [`${row.isNested ? '    ' : '  '}↳ ${row.title}`] : []
      // Command hints are for the person scanning the outline, not the model.
      if (row.mark.kind === 'command') return []

      return [`${row.isNested ? '  ' : ''}${MARK_GLYPH[row.mark.kind]} ${row.mark.label}`]
    })

  let body = lines(true)
  if (body.join('\n').length > OUTLINE_CHARS) body = lines(false)
  let dropped = 0
  while (body.join('\n').length > OUTLINE_CHARS && body.length > 1) {
    body = body.slice(1)
    dropped += 1
  }

  return [
    OUTLINE_MARK,
    'The table of contents of this conversation so far, kept through compaction by the breakpoints mod ' +
      '(◇ chapter, › sub-topic, ↳ what the assistant answered, ◆ a breakpoint the developer set, ' +
      '☆ an answer the developer starred, ⇊ an earlier compaction). ' +
      'The developer can pull any part back word for word with /bps, pressing r to recall it.',
    '',
    ...(dropped > 0 ? [`(${dropped} earlier lines left out)`] : []),
    ...body,
    '</conversation_outline>',
  ].join('\n')
}

// The compacted conversation with the outline as its second message, after
// the summary; an outline an earlier compaction kept is replaced, never doubled.
export function withOutline(messages: readonly SessionMessage[], outline: string): SessionMessage[] {
  const kept = messages.filter(one => !one.text.includes(OUTLINE_MARK))
  const block: SessionMessage = { role: 'user', text: outline, toolUses: [] }

  return kept.length === 0 ? [block] : [kept[0] as SessionMessage, block, ...kept.slice(1)]
}
