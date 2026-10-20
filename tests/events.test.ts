import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { BreakpointMark, BreakpointPrompt } from '../types'
import { compactionOutline } from '../hooks/export-lib'
import { buildOutline, compactLabel, orderedMarks, parseTranscript, promptAfter, withEvents } from '../hooks/outline'

const line = (row: object) => JSON.stringify({ isSidechain: false, ...row })
const said = (uuid: string, at: string, content: string) =>
  line({ type: 'user', uuid, timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content } })
const answered = (uuid: string, text: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
// Most commands write system rows; the ones that open a picker write user rows.
const command = (uuid: string, at: string, name: string, args = '') =>
  line({
    type: 'system',
    subtype: 'local_command',
    uuid,
    timestamp: at,
    content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`,
  })
const printed = (uuid: string, parent: string, text: string) =>
  line({ type: 'system', subtype: 'local_command', uuid, parentUuid: parent, content: `<local-command-stdout>${text}</local-command-stdout>` })
const picker = (uuid: string, at: string, name: string) =>
  line({ type: 'user', uuid, timestamp: at, message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-args></command-args>` } })
const pickerPrinted = (uuid: string, parent: string, text: string) =>
  line({ type: 'user', uuid, parentUuid: parent, message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } })
const compacted = (uuid: string, at: string, trigger: string, preTokens: number, postTokens: number) =>
  line({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: at, content: 'Conversation compacted', compactMetadata: { trigger, preTokens, postTokens } })

const TRANSCRIPT = [
  picker('cmd-start', '2026-10-14T08:59:00Z', 'effort'),
  said('u-1', '2026-10-14T09:00:00Z', 'Fix the login bug'),
  answered('a-1', 'Fixed it.'),
  command('cmd-model', '2026-10-14T09:01:00Z', 'model', 'opus'),
  printed('out-model', 'cmd-model', 'Set model to \u001b[1mOpus 5.5\u001b[22m\nsecond line'),
  command('cmd-bps', '2026-10-14T09:02:00Z', 'bps', 'fold'),
  printed('out-bps', 'cmd-bps', 'breakpoints: Folded 1 chapter.'),
  compacted('boundary', '2026-10-14T09:10:00Z', 'manual', 658137, 11006),
  said('u-2', '2026-10-14T09:20:00Z', 'Add a deploy pipeline'),
  answered('a-2', 'Set it up.'),
  picker('cmd-effort', '2026-10-14T09:25:00Z', 'effort'),
  pickerPrinted('out-effort', 'cmd-effort', 'Set effort level to xhigh'),
  compacted('boundary-2', '2026-10-14T09:40:00Z', 'auto', 165000, 12400),
].join('\n')

const prompt = (n: number): BreakpointPrompt => ({ uuid: `u-${n}`, text: `prompt ${n}`, at: 0, n, isLabelled: true, title: `topic ${n}` })

test('the transcript gives compactions and commands, each after the prompt before it', async () => {
  const { prompts, events } = parseTranscript(TRANSCRIPT)

  expect(prompts.map(one => one.uuid)).toEqual(['u-1', 'u-2'])
  expect(events).toEqual([
    { kind: 'command', uuid: 'cmd-start', at: Date.parse('2026-10-14T08:59:00Z'), label: '/effort', after: '' },
    { kind: 'command', uuid: 'cmd-model', at: Date.parse('2026-10-14T09:01:00Z'), label: '/model opus · Set model to Opus 5.5', after: 'u-1' },
    { kind: 'compact', uuid: 'boundary', at: Date.parse('2026-10-14T09:10:00Z'), label: 'Compacted · 658k → 11k tokens', after: 'u-1' },
    { kind: 'command', uuid: 'cmd-effort', at: Date.parse('2026-10-14T09:25:00Z'), label: '/effort · Set effort level to xhigh', after: 'u-2' },
    { kind: 'compact', uuid: 'boundary-2', at: Date.parse('2026-10-14T09:40:00Z'), label: 'Auto-compacted · 165k → 12k tokens', after: 'u-2' },
  ])
})

test('a compaction with no token counts is still labelled', async () => {
  expect(compactLabel(undefined)).toBe('Compacted')
  expect(compactLabel({ trigger: 'auto' })).toBe('Auto-compacted')
  expect(compactLabel({ trigger: 'manual', preTokens: 800, postTokens: 120 })).toBe('Compacted · 800 → 120 tokens')
})

test('events become marks once, a later label replaces the first, a removed one stays removed', async () => {
  const { events } = parseTranscript(TRANSCRIPT)
  const chapter: BreakpointMark = { id: 7, kind: 'auto', label: 'Login bug', anchor: 'u-1', anchorText: '', after: '', at: 0 }

  const first = withEvents([chapter], events)
  expect(first.map(one => [one.id, one.kind, one.anchor])).toEqual([
    [7, 'auto', 'u-1'],
    [8, 'command', 'cmd-start'],
    [9, 'command', 'cmd-model'],
    [10, 'compact', 'boundary'],
    [11, 'command', 'cmd-effort'],
    [12, 'compact', 'boundary-2'],
  ])
  expect(withEvents(first, events)).toBe(first)

  // Read before the command's output reached the file, then after.
  const early = withEvents([], [{ kind: 'command', uuid: 'c', at: 1, label: '/model opus', after: 'u-1' }])
  const late = withEvents(early, [{ kind: 'command', uuid: 'c', at: 1, label: '/model opus · Set model', after: 'u-1' }])
  expect(late.map(one => [one.id, one.label])).toEqual([[1, '/model opus · Set model']])

  const removed = first.map(one => (one.anchor === 'boundary' ? { ...one, isRemoved: true } : one))
  expect(withEvents(removed, events)).toBe(removed)
})

test('the outline puts them after the prompt they followed, in the order they happened', async () => {
  const said = [prompt(1), prompt(2)]
  const all: BreakpointMark[] = [
    { id: 1, kind: 'auto', label: 'Login bug', anchor: 'u-1', anchorText: '', after: '', at: 0 },
    { id: 2, kind: 'compact', label: 'Compacted', anchor: 'b', anchorText: '', after: 'u-1', at: 20 },
    { id: 3, kind: 'manual', label: 'my mark', anchor: 'r', anchorText: '', after: 'u-1', at: 30 },
    { id: 4, kind: 'command', label: '/model opus', anchor: 'c', anchorText: '', after: 'u-1', at: 10 },
    { id: 5, kind: 'command', label: '/effort', anchor: 'e', anchorText: '', after: '', at: 5 },
  ]
  const rows = buildOutline(all, said, [], true).map(row =>
    row.kind === 'mark' ? `${row.isNested ? '  ' : ''}${row.mark.label}` : row.kind === 'chapter' ? row.mark.label : `  ${row.title}`,
  )

  expect(rows).toEqual(['/effort', 'Login bug', '  topic 1', '  /model opus', '  Compacted', '  my mark', '  topic 2'])
  expect(orderedMarks(all, said).map(one => one.id)).toEqual([5, 1, 4, 2, 3])
  expect(promptAfter(said, 'u-1')?.uuid).toBe('u-2')
  expect(promptAfter(said, '')?.uuid).toBe('u-1')
  expect(promptAfter(said, 'u-2')).toBeUndefined()
})

test('the outline kept through a compaction shows compactions and leaves command hints out', async () => {
  const said = [prompt(1)]
  const all: BreakpointMark[] = [
    { id: 1, kind: 'auto', label: 'Login bug', anchor: 'u-1', anchorText: '', after: '', at: 0 },
    { id: 2, kind: 'command', label: '/model opus', anchor: 'c', anchorText: '', after: 'u-1', at: 10 },
    { id: 3, kind: 'compact', label: 'Compacted · 658k → 11k tokens', anchor: 'b', anchorText: '', after: 'u-1', at: 20 },
  ]
  const outline = compactionOutline(all, said) ?? ''

  expect(outline).toContain('  ⇊ Compacted · 658k → 11k tokens')
  expect(outline).not.toContain('/model')
})

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function world(on: On, file: { text: string }) {
  mock.store(on)
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.id', () => ({ value: 'session-c' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/cfg/projects/-work/session-c.jsonl' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: file.text, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: '1 | Login bug | Login fix | Fixed it\n2 | Deploy pipeline | Staging pipeline | Set it up', usage },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
}

const pane = {
  plugin: 'breakpoints',
  component: 'Pane',
  requestId: 'breakpoints',
  surface: 'terminal',
  props: { title: 'Breakpoints', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 160, rows: 40, isFullscreen: true },
} as const

test('compactions are breakpoints and commands are dim hints, past ones read back from the file', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on, { text: TRANSCRIPT })

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  // Marks 1-5 are the events (the quiet /bps makes none), 6 and 7 the chapters.
  const ui = await $.ui.mount(pane)
  const find = (key: string) => ui.find({ key })
  const label = async (key: string) => (await find(key))?.props.label

  expect(await label('m-4')).toBe('/effort · Set effort level to xhigh')
  expect((await find('m-4'))?.props.dimColor).toBe(true)
  expect(await label('m-5')).toBe('Auto-compacted · 165k → 12k tokens')
  expect((await find('m-5'))?.props.dimColor).toBeUndefined()
  expect(await label('m-1')).toBe('/effort')

  await ui.press({ key: 'fold-6' })
  expect(await label('m-2')).toBe('/model opus · Set model to Opus 5.5')
  expect(await label('m-3')).toBe('Compacted · 658k → 11k tokens')

  await ui.press({ key: 'tab-marks' })
  expect(await find('m-1')).toBeUndefined()
  expect(await find('m-2')).toBeUndefined()
  expect(await find('m-4')).toBeUndefined()
  expect(await label('m-6')).toBe('Login bug')
  expect(await label('m-3')).toBe('Compacted · 658k → 11k tokens')
  expect(await label('m-5')).toBe('Auto-compacted · 165k → 12k tokens')
  await ui.unmount()
})

test('a compaction that happens now shows up once its row is in the file', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const file = { text: [said('u-1', '2026-10-14T09:00:00Z', 'Fix the login bug'), answered('a-1', 'Fixed it.')].join('\n') }
  world(on, file)
  const summary: SessionMessage[] = [{ role: 'user', text: 'summary', toolUses: [] }]
  on('session.compact', () => ({ messages: summary }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  file.text = `${file.text}\n${compacted('now', '2026-10-14T10:00:01Z', 'manual', 90000, 9000)}`
  await clock.advance(3100)

  const ui = await $.ui.mount(pane)
  await ui.press({ key: 'tab-marks' })
  expect(await ui.find({ key: 'm-2' }).then(one => one?.props.label)).toBe('Compacted · 90k → 9k tokens')
  await ui.unmount()
})
