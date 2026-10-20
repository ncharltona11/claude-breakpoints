import type { BreakpointMark, BreakpointPrompt } from '../types'
import { chapterScope, clip, orderedMarks, sectionScope } from './outline'

// What `grep -n -o -E` pulls out of a transcript file to tie every row to the
// prompt above it: each row's own uuid (one per line), its tool_use ids, and
// the markers of a person's prompt and of a subagent's row. About 180 KB for a
// 13 MB transcript, well under the 4 MiB a process may hand back.
export const OWNER_PATTERNS = [
  '"isSidechain":true',
  '"origin":\\{"kind":"human"\\}',
  '"type":"tool_use","id":"[A-Za-z0-9_]+"',
  '"uuid":"[0-9a-f-]{36}"',
]

// Which prompt each row belongs to, from that grep's output in file order: a
// row of a known prompt opens it, every row after it (and every tool call in
// those rows) belongs to it until the next. A human-origin row that is not a
// known prompt (a slash command's echo) opens nothing.
export function parseOwners(stdout: string, known: ReadonlySet<string>): Map<string, string> {
  const owners = new Map<string, string>()
  let line = ''
  let row: { uuid?: string; isHuman: boolean; isSide: boolean; tools: string[] } = { isHuman: false, isSide: false, tools: [] }
  let current: string | undefined

  const settle = () => {
    if (row.isSide || row.uuid === undefined) return
    if (known.has(row.uuid)) current = row.uuid
    if (current === undefined) return
    owners.set(row.uuid, current)
    for (const tool of row.tools) owners.set(tool, current)
  }

  for (const text of stdout.split('\n')) {
    const found = /^(\d+):(.*)$/.exec(text)
    if (found === null) continue
    const [, number = '', match = ''] = found
    if (number !== line) {
      settle()
      line = number
      row = { isHuman: false, isSide: false, tools: [] }
    }
    if (match === '"isSidechain":true') row.isSide = true
    else if (match.startsWith('"origin"')) row.isHuman = true
    else if (match.startsWith('"type":"tool_use"')) row.tools.push(match.slice(match.lastIndexOf(':') + 2, -1))
    else if (match.startsWith('"uuid"')) row.uuid = match.slice(8, -1)
  }
  settle()

  return owners
}

// The chapters still in the outline, in conversation order: what `/bps fold 2`
// counts.
export function chapterList(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): BreakpointMark[] {
  const known = new Set(said.map(one => one.uuid))

  return orderedMarks(
    all.filter(one => one.kind === 'auto' && one.isRemoved !== true && known.has(one.anchor)),
    said,
  )
}

export type FoldView = {
  // Every prompt in a folded chapter (its opening prompt included) or after a
  // folded /bp.
  hidden: Map<string, BreakpointMark>
  // A folded chapter's opening prompt, which draws the folded line. A folded
  // /bp draws its folded line on its own row.
  openers: Map<string, BreakpointMark>
  // The prompts each folded chapter or /bp holds.
  scopes: Map<number, BreakpointPrompt[]>
  // A folded sub-topic's opening prompt, which draws the folded line, and the
  // prompts it holds (its follow-ups), and those follow-ups on their own.
  topics: Map<string, BreakpointPrompt[]>
  topicHidden: Set<string>
}

// Whether a prompt opens a sub-topic (and gets a fold arrow): a titled one,
// one not titled yet, or a chapter's first.
export const opensTopic = (prompt: BreakpointPrompt, isChapterStart: boolean) =>
  isChapterStart || prompt.isLabelled !== true || (prompt.title ?? '') !== ''

// A folded sub-topic's line, after its Unfold button.
export function foldedTopicLine(title: string, scope: readonly BreakpointPrompt[], tools: number): string {
  const parts = [
    clip(title, 60),
    ...(scope.length > 1 ? [`${scope.length} exchanges`] : []),
    ...(tools > 0 ? [`${tools} tool call${tools === 1 ? '' : 's'}`] : []),
  ]

  return parts.join(' · ')
}

// What a /bp folds, the way an editor folds a region: the exchanges after it,
// up to the next /bp or chapter. A /bp followed straight away by another
// folds nothing.
export function breakpointScope(
  mark: BreakpointMark,
  all: readonly BreakpointMark[],
  said: readonly BreakpointPrompt[],
): BreakpointPrompt[] {
  const others = all.filter(one => one.kind === 'manual' && one.isRemoved !== true && one.id !== mark.id)
  if (others.some(one => one.after === mark.after && one.id > mark.id)) return []

  const after = said.findIndex(one => one.uuid === mark.after)
  if (mark.after !== '' && after < 0) return []

  const chapters = new Set(all.filter(one => one.kind === 'auto' && one.isRemoved !== true).map(one => one.anchor))
  const stops = new Set(others.map(one => one.after))
  const start = after + 1
  let end = start
  while (end < said.length) {
    const prompt = said[end]
    if (prompt === undefined || chapters.has(prompt.uuid)) break
    end += 1
    if (stops.has(prompt.uuid)) break
  }

  return said.slice(start, end)
}

export function foldView(
  all: readonly BreakpointMark[],
  said: readonly BreakpointPrompt[],
  folded: readonly number[],
  topics: readonly string[] = [],
): FoldView {
  const view: FoldView = { hidden: new Map(), openers: new Map(), scopes: new Map(), topics: new Map(), topicHidden: new Set() }
  const live = all.filter(one => one.isRemoved !== true)

  for (const mark of chapterList(live, said)) {
    if (!folded.includes(mark.id)) continue
    const scope = chapterScope(mark, live, said)
    view.scopes.set(mark.id, scope)
    view.openers.set(mark.anchor, mark)
    for (const prompt of scope) view.hidden.set(prompt.uuid, mark)
  }
  for (const mark of live) {
    if (mark.kind !== 'manual' || !folded.includes(mark.id)) continue
    const scope = breakpointScope(mark, live, said)
    view.scopes.set(mark.id, scope)
    for (const prompt of scope) if (!view.hidden.has(prompt.uuid)) view.hidden.set(prompt.uuid, mark)
  }
  // A sub-topic inside a folded chapter or /bp is already out of sight.
  for (const uuid of topics) {
    const prompt = said.find(one => one.uuid === uuid)
    if (prompt === undefined || view.hidden.has(uuid)) continue
    const scope = sectionScope(prompt, live, said)
    view.topics.set(uuid, scope)
    for (const one of scope) if (one.uuid !== uuid) view.topicHidden.add(one.uuid)
  }

  return view
}

export type RowKind = 'tool' | 'text' | 'command' | 'duration'

// Whether a transcript row draws. A row of a folded chapter never does. In
// reading mode tool rows, turn-duration lines and Claude's in-between text go
// once their exchange has its final answer; an exchange still running (or a
// row nobody has tied to a prompt yet) shows whole.
export function isRowShown(
  kind: RowKind,
  owner: string | undefined,
  view: FoldView,
  reading: { isOn: boolean; isAnswered: boolean; isFinal: boolean },
): boolean {
  if (owner !== undefined && (view.hidden.has(owner) || view.topics.has(owner) || view.topicHidden.has(owner))) return false
  if (!reading.isOn) return true
  if (kind === 'duration') return false
  if (kind === 'command') return true
  if (owner === undefined || !reading.isAnswered) return true

  return kind === 'text' && reading.isFinal
}

// `/bps fold <target>`: a chapter number, `all`, or `others` (all but the
// newest). Answers the chapter ids, or why not.
export function foldTargets(target: string, chapters: readonly BreakpointMark[]): number[] | string {
  if (chapters.length === 0) return 'There are no chapters yet.'
  if (target === '' || target === 'all') return chapters.map(one => one.id)
  if (target === 'others') return chapters.slice(0, -1).map(one => one.id)
  if (!/^\d+$/.test(target)) return `Use a chapter number (1-${chapters.length}), all or others.`
  const mark = chapters[Number(target) - 1]

  return mark === undefined ? `There is no chapter ${target}; there are ${chapters.length}.` : [mark.id]
}

// A folded chapter's or /bp's line, after its Unfold button.
export function foldedLine(mark: BreakpointMark, exchanges: number, tools: number): string {
  const parts = [
    clip(mark.label, 60),
    `${exchanges} exchange${exchanges === 1 ? '' : 's'}`,
    ...(tools > 0 ? [`${tools} tool call${tools === 1 ? '' : 's'}`] : []),
  ]

  return parts.join(' · ')
}

// What Haiku reads to sum a folded chapter up in two lines.
export function summaryRequest(title: string, exchanges: readonly { prompt: string; answer: string }[]): string {
  const body = exchanges
    .map(one => `Developer: ${clip(one.prompt, 300)}\nAssistant: ${one.answer === '' ? '(no answer)' : clip(one.answer, 600)}`)
    .join('\n\n')

  return (
    `Chapter: ${title}\n\n${clip(body, 12_000)}\n\n` +
    'Sum this chapter up in at most two short lines: what was asked, and what was decided or built. ' +
    'Plain words, no heading, no bullet points.'
  )
}

export const summaryLines = (summary: string): string[] =>
  summary
    .split('\n')
    .map(line => line.replace(/^[-*•\s]+/, '').trim())
    .filter(line => line !== '')
    .slice(0, 2)
