import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { BreakpointMark, BreakpointPrompt } from '../types'
import {
  SEARCH_SCRIPT,
  parseSearchOutput,
  searchChapter,
  searchDate,
  searchHits,
  searchPrefilter,
  searchSnippet,
  searchWords,
} from '../hooks/search-lib'
import type { SearchSaved } from '../hooks/search-lib'

const composer = { kind: 'composer' } as const
const presentation = { isFullscreen: true, columns: 160 }
const NOW = Date.parse('2026-10-14T10:00:00Z')

const row = (fields: object) => JSON.stringify({ isSidechain: false, ...fields })
const said = (uuid: string, at: string, text: string, cwd = '/work/app') =>
  row({ type: 'user', uuid, cwd, timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content: text } })
const answered = (uuid: string, at: string, text: string) =>
  row({ type: 'assistant', uuid, timestamp: at, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

const chapter = (id: number, anchor: string, label: string): BreakpointMark => ({
  id,
  kind: 'auto',
  label,
  anchor,
  anchorText: '',
  after: '',
  at: 0,
})
const prompt = (uuid: string, n: number, at: string, extra: Partial<BreakpointPrompt> = {}): BreakpointPrompt => ({
  uuid,
  text: `prompt ${n}`,
  at: Date.parse(at),
  n,
  isLabelled: true,
  ...extra,
})

test('words: quoted phrases stay whole, case and repeats fold', async () => {
  expect(searchWords('Rakuten "scope id"  rakuten')).toEqual(['rakuten', 'scope id'])
  expect(searchPrefilter(['scope', 'say "hi"', 'rakuten'])).toBe('rakuten')
  expect(searchPrefilter(['a\\b'])).toBe('')
})

test('the search output parses into transcripts with titles, prompts and final answers', async () => {
  const files = parseSearchOutput(
    [
      '@@FILE /cfg/projects/-work-app/s-1.jsonl',
      row({ type: 'custom-title', customTitle: 'My  title', sessionId: 's-1' }),
      row({ type: 'ai-title', aiTitle: 'Model title', sessionId: 's-1' }),
      said('p-1', '2026-10-01T09:00:00Z', 'Where does the Rakuten   scope come from?'),
      row({ type: 'user', uuid: 'tool', origin: { kind: 'human' }, message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'rakuten' }] } }),
      row({ type: 'user', uuid: 'meta', isMeta: true, origin: { kind: 'human' }, message: { content: 'rakuten reminder' } }),
      row({ type: 'attachment', uuid: 'att', origin: { kind: 'human' } }),
      answered('a-1', '2026-10-01T09:02:00Z', 'From the account SID.'),
      row({ type: 'assistant', uuid: 'side', isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] } }),
      'cut off half a li',
      '@@FILE /cfg/projects/-work-app/s-2.jsonl',
      row({ type: 'ai-title', aiTitle: 'Second', sessionId: 's-2' }),
      said('p-9', '2026-10-02T09:00:00Z', '<command-name>/effort</command-name>'),
      answered('orphan', '2026-10-02T09:01:00Z', 'An answer with no prompt before it.'),
    ].join('\n'),
  )

  expect(files.map(file => [file.sessionId, file.title, file.cwd])).toEqual([
    ['s-1', 'My title', '/work/app'],
    ['s-2', 'Second', '/work/app'],
  ])
  expect(files[0]?.rows).toEqual([
    { uuid: 'p-1', kind: 'prompt', text: 'Where does the Rakuten scope come from?', at: Date.parse('2026-10-01T09:00:00Z'), prompt: 'p-1' },
    { uuid: 'a-1', kind: 'answer', text: 'From the account SID.', at: Date.parse('2026-10-01T09:02:00Z'), prompt: 'p-1' },
  ])
  expect(files[1]?.rows).toEqual([])
})

test('snippets centre on the match, chapters come from the stored outline, dates drop this year', async () => {
  const long = `${'a'.repeat(100)} the rakuten scope ${'b'.repeat(100)}`
  const snippet = searchSnippet(long, ['rakuten'], 40)
  expect(snippet.startsWith('…')).toBe(true)
  expect(snippet).toContain('rakuten')
  expect(snippet.length).toBeLessThanOrEqual(40)
  expect(searchSnippet('short text', ['x'], 40)).toBe('short text')

  const saved: SearchSaved = {
    marks: [chapter(1, 'p-1', 'Setup'), chapter(2, 'p-3', 'Deploy')],
    prompts: [prompt('p-1', 1, '2026-10-01T09:00:00Z'), prompt('p-2', 2, '2026-10-01T09:05:00Z'), prompt('p-3', 3, '2026-10-01T09:10:00Z')],
  }
  expect(searchChapter(saved, 'p-2')).toBe('Setup')
  expect(searchChapter(saved, 'p-3')).toBe('Deploy')
  expect(searchChapter(saved, 'nope')).toBe('')

  expect(searchDate(Date.parse('2026-10-01T12:00:00'), NOW)).toBe('1 Oct')
  expect(searchDate(Date.parse('2025-03-09T12:00:00'), NOW)).toBe('9 Mar 2025')
})

test('hits: newest conversation first, each in conversation order, outline hits only where searched', async () => {
  const files = parseSearchOutput(
    [
      '@@FILE /cfg/projects/-work-app/new.jsonl',
      row({ type: 'ai-title', aiTitle: 'Newer', sessionId: 'new' }),
      said('n-1', '2026-10-10T09:00:00Z', 'rakuten again'),
      '@@FILE /cfg/projects/-work-app/old.jsonl',
      said('o-1', '2026-10-01T09:00:00Z', 'set up the Rakuten client'),
      answered('o-2', '2026-10-01T09:30:00Z', 'Rakuten client written.'),
      said('o-3', '2026-10-01T10:00:00Z', 'nothing to see'),
    ].join('\n'),
  )
  const outlines = new Map<string, SearchSaved>([
    ['old', { marks: [chapter(1, 'o-1', 'Rakuten affiliate API')], prompts: [prompt('o-1', 1, '2026-10-01T09:00:00Z', { title: 'Rakuten setup' })] }],
    ['elsewhere', { marks: [chapter(1, 'x-1', 'Rakuten in another project')], prompts: [prompt('x-1', 1, '2026-10-12T09:00:00Z')] }],
  ])
  const places = new Map([
    ['new', { cwd: '', title: '' }],
    ['old', { cwd: '', title: '' }],
  ])

  const hits = searchHits({ files, outlines, words: ['rakuten'], places, room: 80 })

  expect(hits.map(hit => [hit.sessionId, hit.kind, hit.uuid, hit.text, hit.chapter, hit.title])).toEqual([
    ['new', 'prompt', 'n-1', 'rakuten again', '', 'Newer'],
    ['old', 'chapter', 'o-1', 'Rakuten affiliate API', '', 'set up the Rakuten client'],
    ['old', 'topic', 'o-1', 'Rakuten setup', 'Rakuten affiliate API', 'set up the Rakuten client'],
    ['old', 'prompt', 'o-1', 'set up the Rakuten client', 'Rakuten affiliate API', 'set up the Rakuten client'],
    ['old', 'answer', 'o-1', 'Rakuten client written.', 'Rakuten affiliate API', 'set up the Rakuten client'],
  ])
  expect(searchHits({ files, outlines, words: ['rakuten', 'written'], places, room: 80 }).map(hit => hit.kind)).toEqual(['answer'])
})

const searchPane = {
  plugin: 'breakpoints',
  component: 'Pane',
  requestId: 'bp-search',
  props: {
    title: 'Search',
    isFocused: true,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 160, rows: 40, isFullscreen: true },
} as const

type Seen = { argv: string[][]; filled: string[]; copied: string[]; closed: string[]; toasts: string[] }

// The engine's side of a search, answered from memory: this project's folder
// /cfg/projects/-work-app, another at /cfg/projects/-other-proj.
function world(on: On, stdout: string): Seen {
  const seen: Seen = { argv: [], filled: [], copied: [], closed: [], toasts: [] }
  mock.clock(on, { now: NOW })
  mock.store(on, {
    sessions: ['cur', 'old'],
    's:old': {
      marks: [chapter(1, 'o-1', 'Rakuten affiliate API')],
      prompts: [prompt('o-1', 1, '2026-10-01T09:00:00Z', { title: 'Rakuten setup', text: 'set up the Rakuten client' })],
    },
  })
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.id', () => ({ value: 'cur' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/cfg/projects/-work-app' }))
  on('fs.list', ($, e) => {
    const file = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 1000, mtimeMs, isLink: false })
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const listing: Record<string, (ReturnType<typeof file> | ReturnType<typeof dir>)[]> = {
      '/cfg/projects': [dir('-work-app'), dir('-other-proj')],
      '/cfg/projects/-work-app': [file('old.jsonl', 2), file('cur.jsonl', 3), file('notes.txt', 9)],
      '/cfg/projects/-other-proj': [file('far.jsonl', 1)],
    }

    return { value: listing[e.path] ?? [] }
  })
  on('process.run', ($, e) => {
    seen.argv.push([...e.argv])

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    seen.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })

  return seen
}

const OLD = [
  '@@FILE /cfg/projects/-work-app/old.jsonl',
  row({ type: 'ai-title', aiTitle: 'Affiliate work', sessionId: 'old' }),
  said('o-1', '2026-10-01T09:00:00Z', 'set up the Rakuten client'),
  answered('o-2', '2026-10-01T09:30:00Z', 'The Rakuten client is written.'),
].join('\n')

test('/bps search lists hits from this project and fills /resume for another conversation', async ($, on) => {
  const seen = world(on, OLD)

  const ran = await $.command.run({ command: 'bps', args: 'search Rakuten', origin: composer, presentation })
  expect(ran.text).toBeUndefined()
  expect(seen.argv).toEqual([
    ['sh', '-c', SEARCH_SCRIPT, 'sh', 'rakuten', '/cfg/projects/-work-app/cur.jsonl', '/cfg/projects/-work-app/old.jsonl'],
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...searchPane, surface })
    expect(await ui.find({ type: 'Text', text: /Affiliate work/ })).toBeDefined()
    expect((await ui.find({ key: 'hit-0' }))?.props.label).toBe('Rakuten affiliate API')
    expect((await ui.find({ key: 'hit-1' }))?.props.label).toBe('Rakuten setup')
    expect((await ui.find({ key: 'hit-2' }))?.props.label).toBe('set up the Rakuten client')
    expect((await ui.find({ key: 'hit-3' }))?.props.label).toBe('The Rakuten client is written.')
    expect(await ui.find({ type: 'Text', text: /4 hits in this project/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...searchPane, surface: 'terminal' })
  await ui.press({ key: 'hit-3' })
  await ui.unmount()

  expect(seen.filled).toEqual(['/resume old'])
  expect(seen.closed).toEqual(['bp-search'])
  expect(seen.toasts).toEqual(['Press Enter to resume "Affiliate work".'])
})

test('/bps search --all reaches other projects and copies the command that resumes there', async ($, on) => {
  const FAR = [
    '@@FILE /cfg/projects/-other-proj/far.jsonl',
    said('f-1', '2026-10-05T09:00:00Z', 'rakuten for the other site', '/other/proj'),
  ].join('\n')
  const seen = world(on, `${OLD}\n${FAR}`)

  await $.command.run({ command: 'bps', args: 'search --all rakuten', origin: composer, presentation })
  expect(seen.argv[0]?.slice(4)).toEqual([
    'rakuten',
    '/cfg/projects/-work-app/cur.jsonl',
    '/cfg/projects/-work-app/old.jsonl',
    '/cfg/projects/-other-proj/far.jsonl',
  ])

  const ui = await $.ui.mount({ ...searchPane, surface: 'terminal' })
  expect((await ui.find({ key: 'hit-0' }))?.props.label).toBe('rakuten for the other site')
  expect(await ui.find({ type: 'Text', text: /proj/ })).toBeDefined()
  await ui.press({ key: 'hit-0' })
  await ui.unmount()

  expect(seen.copied).toEqual(["cd '/other/proj' && claude --resume far"])
  expect(seen.filled).toEqual([])
})

test('/bps search with no words explains itself and opens nothing', async ($, on) => {
  const seen = world(on, '')

  const ran = await $.command.run({ command: 'bps', args: 'search --all', origin: composer, presentation })
  expect(ran.text).toBeUndefined()
  expect(seen.argv).toEqual([])
  expect(seen.toasts).toEqual(['Type /bps search <words>, or /bps search --all <words> for every project.'])
})
