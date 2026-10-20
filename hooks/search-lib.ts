import type { BreakpointMark, BreakpointPrompt, BreakpointSearchHit } from '../types'
import { clip, squash, textOf } from './outline'

export const SEARCH_FILE = '@@FILE '
export const SEARCH_LIMIT = 60
export const SEARCH_PER_SESSION = 8

// For every transcript given after the word: skip it unless it holds the word
// (any case) somewhere, else print a marker, its title rows, and the rows that
// carry the person's prompts and Claude's final answers, thinking left out.
// Run as `sh -c SEARCH_SCRIPT sh <word> <file>...`: the word and the paths are
// arguments, never spliced into the script.
export const SEARCH_SCRIPT = [
  'word=$1; shift',
  'for f in "$@"; do',
  '  grep -q -i -F -e "$word" -- "$f" || continue',
  `  printf '${SEARCH_FILE}%s\\n' "$f"`,
  `  grep -F -e '"type":"custom-title"' -- "$f" | tail -n 1`,
  `  grep -F -e '"type":"ai-title"' -- "$f" | tail -n 1`,
  `  grep -F -e '"origin":{"kind":"human"}' -e '"stop_reason":"end_turn"' -- "$f" | grep -v -F -e '"content":[{"type":"thinking"' -e '"content":[{"type":"redacted_thinking"'`,
  'done',
].join('\n')

export type SearchSaved = { marks: BreakpointMark[]; prompts: BreakpointPrompt[] }

export type SearchRow = { uuid: string; kind: 'prompt' | 'answer'; text: string; at: number; prompt: string }

export type SearchFile = {
  sessionId: string
  path: string
  cwd: string
  title: string
  rows: SearchRow[]
}

type SearchLine = {
  type?: string
  uuid?: string
  cwd?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  customTitle?: string
  aiTitle?: string
  title?: string
  origin?: { kind?: string }
  message?: { content?: unknown; stop_reason?: unknown }
}

// The words a query asks for, lower-cased; "a quoted phrase" is one word.
export function searchWords(query: string): string[] {
  const words = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map(found => squash(found[1] ?? found[2] ?? '').toLowerCase())

  return [...new Set(words.filter(word => word !== ''))]
}

// The word grep looks for first: the longest, so the fewest files pass, and
// one the transcript writes as typed (JSON escapes quotes and backslashes).
export function searchPrefilter(words: readonly string[]): string {
  const plain = words.filter(word => !/["\\]/.test(word))

  return [...plain].sort((a, b) => b.length - a.length)[0] ?? ''
}

export const searchMatches = (text: string, words: readonly string[]) => {
  const lower = text.toLowerCase()

  return words.every(word => lower.includes(word))
}

export const searchSessionOf = (path: string) => (path.split('/').at(-1) ?? '').replace(/\.jsonl$/, '')

export const searchProjectOf = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) ?? ''

// The output of SEARCH_SCRIPT, one entry per transcript that held the word.
export function parseSearchOutput(stdout: string): SearchFile[] {
  const files: SearchFile[] = []
  let file: (SearchFile & { custom: string; ai: string }) | undefined
  let prompt = ''

  const close = () => {
    if (file === undefined) return
    const { custom, ai, ...rest } = file
    files.push({ ...rest, title: custom || ai })
  }

  for (const line of stdout.split('\n')) {
    if (line.startsWith(SEARCH_FILE)) {
      close()
      const path = line.slice(SEARCH_FILE.length).trim()
      file = { sessionId: searchSessionOf(path), path, cwd: '', title: '', rows: [], custom: '', ai: '' }
      prompt = ''
      continue
    }
    if (file === undefined || line.trim() === '') continue

    let row: SearchLine
    try {
      row = JSON.parse(line) as SearchLine
    } catch {
      continue
    }

    if (row.type === 'custom-title') file.custom = squash(row.customTitle ?? row.title ?? '')
    if (row.type === 'ai-title') file.ai = squash(row.aiTitle ?? row.title ?? '')
    if (typeof row.uuid !== 'string' || row.isSidechain === true || row.isMeta === true) continue
    if (file.cwd === '' && typeof row.cwd === 'string') file.cwd = row.cwd

    const content = row.message?.content
    const blocks = Array.isArray(content) ? content : []
    const text = squash(typeof content === 'string' ? content : textOf(blocks))
    const at = Date.parse(row.timestamp ?? '') || 0

    if (row.type === 'user' && row.origin?.kind === 'human') {
      const hasToolResult = blocks.some(block => (block as { type?: unknown }).type === 'tool_result')
      if (hasToolResult || text === '' || text.startsWith('<')) continue
      file.rows.push({ uuid: row.uuid, kind: 'prompt', text, at, prompt: row.uuid })
      prompt = row.uuid
    } else if (row.type === 'assistant' && row.message?.stop_reason === 'end_turn' && text !== '' && prompt !== '') {
      file.rows.push({ uuid: row.uuid, kind: 'answer', text, at, prompt })
    }
  }
  close()

  return files
}

// The part of `text` around the first word found, in `room` characters.
export function searchSnippet(text: string, words: readonly string[], room: number): string {
  const flat = squash(text)
  if (flat.length <= room) return flat

  const lower = flat.toLowerCase()
  const at = Math.min(...words.map(word => lower.indexOf(word)).filter(index => index >= 0), flat.length)
  const start = Math.max(0, Math.min(at - Math.floor(room / 3), flat.length - room))
  const piece = flat.slice(start, start + room)

  return `${start > 0 ? '…' : ''}${clip(piece.slice(start > 0 ? 1 : 0), room - (start > 0 ? 1 : 0))}`
}

// The chapter a prompt sits in, by a stored outline: the last chapter opened
// at or before it.
export function searchChapter(saved: SearchSaved | undefined, promptUuid: string): string {
  if (saved === undefined) return ''
  const index = saved.prompts.findIndex(one => one.uuid === promptUuid)
  if (index < 0) return ''

  let label = ''
  for (const [at, prompt] of saved.prompts.entries()) {
    if (at > index) break
    const opens = saved.marks.find(one => one.kind === 'auto' && one.isRemoved !== true && one.anchor === prompt.uuid)
    if (opens !== undefined) label = opens.label
  }

  return label
}

const KIND_ORDER: Record<BreakpointSearchHit['kind'], number> = { chapter: 0, topic: 1, mark: 2, prompt: 3, answer: 4 }

export type SearchInput = {
  files: readonly SearchFile[]
  outlines: ReadonlyMap<string, SearchSaved>
  words: readonly string[]
  // Sessions whose stored outline may be searched, with where they live.
  places: ReadonlyMap<string, { cwd: string; title: string }>
  room: number
  limit?: number
}

// Every hit for the words: the stored outlines' chapters, sub-topics and
// breakpoints, then the prompts and final answers in the transcripts.
// Sessions newest first, each in conversation order, a few hits per session.
export function searchHits(input: SearchInput): BreakpointSearchHit[] {
  const { files, outlines, words, places, room } = input
  const hits: BreakpointSearchHit[] = []
  const seen = new Set<string>()
  const fileOf = new Map(files.map(file => [file.sessionId, file]))
  // One title per conversation: its own (renamed or generated), else its
  // first prompt, from the transcript or the stored outline.
  const titleOf = (sessionId: string) => {
    const file = fileOf.get(sessionId)
    const first = file?.rows.find(one => one.kind === 'prompt')?.text ?? outlines.get(sessionId)?.prompts[0]?.text ?? ''

    return file?.title || places.get(sessionId)?.title || clip(first, 60)
  }
  const add = (hit: BreakpointSearchHit) => {
    const key = `${hit.sessionId}:${hit.kind}:${hit.uuid}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push(hit)
  }

  for (const [sessionId, saved] of outlines) {
    const place = places.get(sessionId)
    if (place === undefined) continue
    const cwd = fileOf.get(sessionId)?.cwd || place.cwd
    const base = { sessionId, project: searchProjectOf(cwd), cwd, title: titleOf(sessionId) }
    const atOf = (uuid: string) => saved.prompts.find(one => one.uuid === uuid)?.at ?? 0

    for (const mark of saved.marks) {
      if (mark.isRemoved === true || mark.kind === 'command' || !searchMatches(mark.label, words)) continue
      const uuid = mark.kind === 'auto' ? mark.anchor : mark.after
      add({
        ...base,
        kind: mark.kind === 'auto' ? 'chapter' : 'mark',
        uuid,
        chapter: mark.kind === 'auto' ? '' : searchChapter(saved, uuid),
        text: clip(mark.label, room),
        at: atOf(uuid) || mark.at,
      })
    }
    for (const prompt of saved.prompts) {
      if (prompt.title === undefined || prompt.title === '' || !searchMatches(prompt.title, words)) continue
      add({ ...base, kind: 'topic', uuid: prompt.uuid, chapter: searchChapter(saved, prompt.uuid), text: clip(prompt.title, room), at: prompt.at })
    }
  }

  for (const file of files) {
    const saved = outlines.get(file.sessionId)
    const title = titleOf(file.sessionId)
    for (const row of file.rows) {
      if (!searchMatches(row.text, words)) continue
      add({
        sessionId: file.sessionId,
        project: searchProjectOf(file.cwd),
        cwd: file.cwd,
        title,
        kind: row.kind,
        uuid: row.prompt,
        chapter: searchChapter(saved, row.prompt),
        text: searchSnippet(row.text, words, room),
        at: row.at,
      })
    }
  }

  const latest = new Map<string, number>()
  for (const hit of hits) latest.set(hit.sessionId, Math.max(latest.get(hit.sessionId) ?? 0, hit.at))
  const sessions = [...latest.keys()].sort((a, b) => (latest.get(b) ?? 0) - (latest.get(a) ?? 0))

  const ordered = sessions.flatMap(sessionId =>
    hits
      .filter(hit => hit.sessionId === sessionId)
      .sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
      .slice(0, SEARCH_PER_SESSION),
  )

  return ordered.slice(0, input.limit ?? SEARCH_LIMIT)
}

// "14 Oct", with the year when it is not this one.
export function searchDate(at: number, now: number): string {
  if (at === 0) return ''
  const date = new Date(at)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const day = `${date.getDate()} ${months[date.getMonth()] ?? ''}`

  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${date.getFullYear()}`
}
