import type { On, RenderComponent, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseOwners } from '../hooks/fold-lib'

const composer = { kind: 'composer' } as const
const presentation = { isFullscreen: true, columns: 160 }
const viewport = { columns: 120, rows: 40, isFullscreen: true }
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const U1 = id(1)
const I1 = id(2)
const T1 = id(3)
const R1 = id(4)
const A1 = id(5)
const D1 = id(6)
const U2 = id(7)
const C2 = id(8)
const A2 = id(9)
const U3 = id(10)
const T3 = id(11)
const A3 = id(12)

const row = (fields: object) => JSON.stringify({ parentUuid: null, isSidechain: false, ...fields })
const said = (uuid: string, text: string) => row({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp: '2026-10-14T09:00:00Z', origin: { kind: 'human' } })
const wrote = (uuid: string, stop: string, block: object) => row({ type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [block] }, uuid, timestamp: '2026-10-14T09:01:00Z' })
const text = (value: string) => ({ type: 'text', text: value })

const TRANSCRIPT = [
  said(U1, 'The login form rejects valid passwords'),
  wrote(I1, 'tool_use', text('Looking into it.')),
  wrote(T1, 'tool_use', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }),
  row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, uuid: R1, timestamp: '2026-10-14T09:01:00Z' }),
  wrote(A1, 'end_turn', text('Fixed: the bcrypt cost was compared as a string.')),
  row({ type: 'system', subtype: 'turn_duration', durationMs: 3000, timestamp: '2026-10-14T09:02:00Z', uuid: D1 }),
  said(U2, 'yes do it'),
  row({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>cost $0.10</local-command-stdout>', timestamp: '2026-10-14T09:03:00Z', uuid: C2 }),
  wrote(A2, 'end_turn', text('Done, tests pass.')),
  said(U3, 'Set up the deploy pipeline for staging'),
  wrote(T3, 'tool_use', { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'make' } }),
  wrote(A3, 'end_turn', text('Pipeline added to the CI config.')),
]

const OWNER_GREP = /"isSidechain":true|"origin":\{"kind":"human"\}|"type":"tool_use","id":"[A-Za-z0-9_]+"|"uuid":"[0-9a-f-]{36}"/g

// What grep answers for each of the two ways the mod reads the file.
function grep(argv: readonly string[]): string {
  if (argv.includes('-o')) {
    return TRANSCRIPT.flatMap((line, at) => [...line.matchAll(OWNER_GREP)].map(found => `${at + 1}:${found[0]}`)).join('\n')
  }

  return TRANSCRIPT.filter(line => line.includes('"origin":{"kind":"human"}') || line.includes('"stop_reason":"end_turn"')).join('\n')
}

const LABELS = [
  '1 | Login bug | Valid passwords rejected | Fixed bcrypt cost comparison',
  '2 | - | - | Applied the fix',
  '3 | Deploy pipeline | Staging pipeline | Added the CI pipeline',
].join('\n')

type Seen = { opened: unknown[]; filled: string[]; asked: string[] }

// The engine beneath the plugin: its answers to every call, and its own
// drawing of each transcript row, a Text naming the component.
function world(on: On, stored: Record<string, unknown> = {}): Seen {
  const seen: Seen = { opened: [], filled: [], asked: [] }
  mock.store(on, stored)
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.id', () => ({ value: 'session-fold' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: grep(e.argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', ($, e) => {
    seen.asked.push(e.prompt)
    const reply = e.prompt.includes('Sum this chapter up') ? 'Asked why valid passwords failed.\nFixed the bcrypt cost comparison.' : LABELS

    return { value: { isAnswered: true, text: reply, usage } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    seen.opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)

    return { isFilled: true }
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('ui.render', { component: 'ToolUse' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('ui.render', { component: 'ToolResult' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('ui.render', { component: 'ToolGroup' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('ui.render', { component: 'TurnDuration' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))
  on('ui.render', { component: 'CommandOutput' }, ($, e) => $.ui.resolve(e).Text({ children: `engine ${e.component}` }))

  return seen
}

const run = (args: string) => ({ command: 'bps', args, origin: composer, presentation })

async function start($: Engine, clock: ReturnType<typeof mock.clock>) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)
}

const ROWS = {
  user: (uuid: string, text: string, isExpanded = false) =>
    ({ component: 'UserMessage', requestId: uuid, props: { text, origin: composer, isExpanded } }) as const,
  assistant: (uuid: string, text: string) =>
    ({ component: 'AssistantMessage', requestId: uuid, props: { text, isFirstOfReply: true } }) as const,
  tool: (toolId: string) =>
    ({
      component: 'ToolUse',
      requestId: toolId,
      props: { tool_use_id: toolId, tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    }) as const,
  result: (toolId: string) =>
    ({ component: 'ToolResult', requestId: toolId, props: { tool_use_id: toolId, tool: 'Bash', output: {}, isErrored: false } }) as const,
  group: (toolId: string) =>
    ({
      component: 'ToolGroup',
      requestId: `group-${toolId}`,
      props: {
        calls: [{ tool_use_id: toolId, tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }],
        isActive: false,
        isExpanded: false,
      },
    }) as const,
  duration: (uuid: string) => ({ component: 'TurnDuration', requestId: uuid, props: { word: 'Baked', durationMs: 3000 } }) as const,
  output: (uuid: string) =>
    ({ component: 'CommandOutput', requestId: uuid, props: { command: 'cost', args: '', text: 'cost $0.10', isErrored: false } }) as const,
}

type Row = { component: RenderComponent; requestId: string; props: RenderPropsOf[RenderComponent] }

async function drawn(
  $: Engine,
  target: Row,
  surface: 'terminal' | 'desktop' = 'terminal',
): Promise<{ texts: string[]; isHidden: boolean; buttons: Record<string, string> }> {
  const ui = await $.ui.mount({ plugin: 'breakpoints', surface, viewport, ...target } as Parameters<typeof $.ui.mount>[0])
  const texts: string[] = []
  const buttons: Record<string, string> = {}
  for (const key of ['fold-open', 'fold-close', 'fold-recall', 'fold-rename', 'star', 'bp-fold', 'bp-recall', 'bp-remove']) {
    const found = await ui.find({ key })
    if (found !== undefined) buttons[key] = String(found.props.label)
  }
  const all = await ui.find({ type: 'Text' })
  if (all !== undefined) texts.push(all.text)
  const box = await ui.find({ type: 'Box' })
  const isHidden = all === undefined && box?.props.display === 'none'
  await ui.unmount()

  return { texts, isHidden, buttons }
}

test('owners: every row belongs to the prompt above it, subagent rows to none', async () => {
  const owners = parseOwners(grep(['-o']), new Set([U1, U2, U3]))

  expect(owners.get(U1)).toBe(U1)
  expect(owners.get(I1)).toBe(U1)
  expect(owners.get('toolu_1')).toBe(U1)
  expect(owners.get(D1)).toBe(U1)
  expect(owners.get(C2)).toBe(U2)
  expect(owners.get('toolu_3')).toBe(U3)
  expect(parseOwners('1:"uuid":"' + U1 + '"\n2:"isSidechain":true\n2:"uuid":"' + I1 + '"', new Set([U1])).has(I1)).toBe(false)
})

test('a folded chapter draws as one line on its opening prompt, and nothing for the rest', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on)
  await start($, clock)

  expect((await $.command.run(run('fold 1'))).text).toBe('Folded 1 chapter.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const opener = await drawn($, ROWS.user(U1, 'The login form rejects valid passwords'), surface)
    expect(opener.texts[0]).toContain('Login bug · 2 exchanges · 1 tool call')
    expect(opener.buttons['fold-open']).toBe('▶ Unfold')
    expect(Object.keys(opener.buttons)).toEqual(['fold-open', 'fold-recall', 'fold-rename'])

    for (const target of [
      ROWS.user(U2, 'yes do it'),
      ROWS.assistant(I1, 'Looking into it.'),
      ROWS.assistant(A1, 'Fixed: the bcrypt cost was compared as a string.'),
      ROWS.tool('toolu_1'),
      ROWS.result('toolu_1'),
      ROWS.group('toolu_1'),
      ROWS.output(C2),
    ]) {
      expect(await drawn($, target, surface)).toEqual({ texts: [], isHidden: true, buttons: {} })
    }
    expect((await drawn($, ROWS.tool('toolu_3'), surface)).texts).toEqual(['engine ToolUse'])
  }
  expect((await drawn($, ROWS.duration(D1))).isHidden).toBe(true)

  // ctrl+o draws the prompt whole.
  expect((await drawn($, ROWS.user(U2, 'yes do it', true))).texts).toEqual(['engine UserMessage'])

  expect((await $.command.run(run('unfold'))).text).toBe('Unfolded everything.')
  const open = await drawn($, ROWS.user(U1, 'The login form rejects valid passwords'))
  expect(open.texts[0]).toContain('Login bug')
  expect(open.buttons['fold-close']).toBe('▼ Fold')
  expect(Object.keys(open.buttons)).toEqual(['fold-close', 'fold-recall', 'fold-rename'])
  expect((await drawn($, ROWS.tool('toolu_1'))).texts).toEqual(['engine ToolUse'])
})

test('the chapter heading folds, recalls and renames from the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const seen = world(on)
  await start($, clock)

  const heading = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U3, 'Set up the deploy pipeline for staging') })
  await heading.press({ key: 'fold-recall' })
  expect(seen.filled).toEqual(['Re ◇ "Deploy pipeline": '])
  await heading.press({ key: 'fold-rename' })
  expect(seen.opened).toContainEqual(expect.objectContaining({ id: 'breakpoints', focus: true }))
  await heading.press({ key: 'fold-close' })
  await heading.unmount()

  expect((await drawn($, ROWS.user(U3, 'Set up the deploy pipeline for staging'))).texts[0]).toContain('Deploy pipeline · 1 exchange · 1 tool call')
  expect((await drawn($, ROWS.assistant(A3, 'Pipeline added to the CI config.'))).isHidden).toBe(true)
})

test('reading mode keeps prompts and final answers, and drops tool rows and the text in between', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on)
  await start($, clock)

  expect((await $.command.run(run('reading'))).text).toBe('Reading mode on: prompts and final answers only.')

  expect((await drawn($, ROWS.user(U2, 'yes do it'))).texts).toEqual(['engine UserMessage'])
  expect((await drawn($, ROWS.assistant(A1, 'Fixed: the bcrypt cost was compared as a string.'))).texts).toEqual(['engine AssistantMessage'])
  for (const target of [ROWS.assistant(I1, 'Looking into it.'), ROWS.tool('toolu_1'), ROWS.result('toolu_3'), ROWS.duration(D1)]) {
    expect((await drawn($, target)).isHidden).toBe(true)
  }
  // A row nothing has tied to a prompt yet (a turn still running) shows.
  expect((await drawn($, ROWS.tool('toolu_new'))).texts).toEqual(['engine ToolUse'])
  expect((await drawn($, ROWS.output(C2))).texts).toEqual(['engine CommandOutput'])

  expect((await $.command.run(run('reading'))).text).toBe('Reading mode off.')
  expect((await drawn($, ROWS.tool('toolu_1'))).texts).toEqual(['engine ToolUse'])
})

test('a final answer gets a star that keeps it as a breakpoint, and takes it back', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on)
  await start($, clock)

  expect((await drawn($, ROWS.assistant(I1, 'Looking into it.'))).buttons).toEqual({})
  expect((await drawn($, ROWS.assistant(A3, 'Pipeline added to the CI config.'))).buttons).toEqual({ star: '☆ Star' })

  const answer = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.assistant(A3, 'Pipeline added to the CI config.') })
  expect(await answer.find({ key: 'star-bar' })).toBeUndefined()
  await answer.press({ key: 'star' })
  expect((await answer.find({ key: 'star' }))?.props.label).toBe('★ Starred')
  expect((await answer.find({ key: 'star-bar' }))?.props).toEqual(expect.objectContaining({ width: 1, backgroundColor: 'yellow' }))
  await answer.unmount()
  for (const surface of ['terminal', 'desktop'] as const) {
    const drawnStar = await $.ui.mount({ plugin: 'breakpoints', surface, viewport, ...ROWS.assistant(A3, 'Pipeline added to the CI config.') })
    expect(await drawnStar.find({ key: 'star-bar' })).toBeDefined()
    expect(await drawnStar.find({ type: 'Text', text: 'engine AssistantMessage' })).toBeDefined()
    await drawnStar.unmount()
  }

  const pane = await $.ui.mount({
    plugin: 'breakpoints',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'breakpoints',
    props: { title: 'Breakpoints', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport,
  })
  await pane.press({ key: 'tab-marks' })
  expect((await pane.find({ key: 'm-3' }))?.props.label).toBe('Added the CI pipeline')
  await pane.unmount()

  const again = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.assistant(A3, 'Pipeline added to the CI config.') })
  await again.press({ key: 'star' })
  expect((await again.find({ key: 'star' }))?.props.label).toBe('☆ Star')
  expect(await again.find({ key: 'star-bar' })).toBeUndefined()
  await again.unmount()
})

test('/bp rows recall and remove from the transcript', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const seen = world(on)
  await start($, clock)
  await $.command.run({ command: 'bp', args: 'deploy plan', origin: composer, presentation })

  const target = {
    component: 'CommandOutput',
    requestId: 'row-of-bp',
    props: { command: 'bp', args: 'deploy plan', text: '◆ Breakpoint 3 · deploy plan', isErrored: false },
  } as const
  const ui = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...target })
  await ui.press({ key: 'bp-recall' })
  expect(seen.filled).toEqual(['Re ◆ "deploy plan": '])
  await ui.press({ key: 'bp-remove' })
  expect(await ui.find({ type: 'Text', text: 'deploy plan (removed)' })).toBeDefined()
  expect(await ui.find({ key: 'bp-remove' })).toBeUndefined()
  await ui.unmount()
})

test('/bps fold others, fold-style summary, and the words it does not own', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const seen = world(on)
  await start($, clock)

  expect((await $.command.run(run('fold 5'))).text).toBe('There is no chapter 5; there are 2.')
  expect((await $.command.run(run('fold-style nope'))).text).toBe('Use /bps fold-style heading or /bps fold-style summary.')
  expect((await $.command.run(run('fold-style summary'))).text).toBe('Folded chapters now show a two-line summary.')
  expect((await $.command.run(run('fold others'))).text).toBe('Folded 1 chapter.')
  await clock.advance(100)

  expect(seen.asked.filter(prompt => prompt.includes('Sum this chapter up'))).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U1, 'The login form rejects valid passwords') })
  expect(await ui.find({ type: 'Text', text: /Asked why valid passwords failed\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fixed the bcrypt cost comparison\./ })).toBeDefined()
  await ui.unmount()
  // The newest chapter stays open, its heading offering to fold.
  expect((await drawn($, ROWS.user(U3, 'Set up the deploy pipeline for staging'))).buttons['fold-close']).toBe('▼ Fold')

  // Anything else is the panel's.
  await $.command.run(run('deploy'))
  expect(seen.opened).toContainEqual(expect.objectContaining({ id: 'breakpoints' }))
})

test('a /bp row folds what follows it, up to the next chapter, from its arrow', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  // A /bp set after the first exchange folds the second; the third opens a chapter.
  const mark = { id: 9, kind: 'manual', label: 'before the follow-up', anchor: 'row-of-bp', anchorText: '', after: U1, at: 0 }
  world(on, { 's:session-fold': { prompts: [], marks: [mark] } })
  await start($, clock)
  const bpRow = {
    component: 'CommandOutput',
    requestId: 'row-of-bp',
    props: { command: 'bp', args: 'before the follow-up', text: '◆ Breakpoint 9 · before the follow-up', isErrored: false },
  } as const

  const marked = await drawn($, bpRow)
  expect(marked.buttons['bp-fold']).toBe('▼ Fold')

  const ui = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...bpRow })
  await ui.press({ key: 'bp-fold' })
  await ui.unmount()

  const folded = await drawn($, bpRow)
  expect(folded.buttons['bp-fold']).toBe('▶ Unfold')
  expect(folded.texts[0]).toContain('before the follow-up · 1 exchange')
  expect((await drawn($, ROWS.user(U2, 'yes do it'))).isHidden).toBe(true)
  expect((await drawn($, ROWS.assistant(A2, 'Done, tests pass.'))).isHidden).toBe(true)
  expect((await drawn($, ROWS.user(U3, 'Set up the deploy pipeline for staging'))).isHidden).toBe(false)
  expect((await drawn($, ROWS.assistant(A1, 'Fixed: the bcrypt cost was compared as a string.'))).isHidden).toBe(false)

  expect((await $.command.run(run('unfold all'))).text).toBe('Unfolded everything.')
  expect((await drawn($, ROWS.user(U2, 'yes do it'))).isHidden).toBe(false)
})

test('a /bp with nothing after it yet does not fold', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on)
  await start($, clock)
  await $.command.run({ command: 'bp', args: 'latest', origin: composer, presentation })
  const bpRow = {
    component: 'CommandOutput',
    requestId: 'row-of-latest',
    props: { command: 'bp', args: 'latest', text: '◆ Breakpoint 3 · latest', isErrored: false },
  } as const

  const ui = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...bpRow })
  await ui.press({ key: 'bp-fold' })
  expect((await ui.find({ key: 'bp-fold' }))?.props.label).toBe('▼ Fold')
  await ui.unmount()
})

test('every sub-topic prompt folds its exchange in place, follow-ups included, from its arrow', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on)
  await start($, clock)

  // U1 opens "Valid passwords rejected"; U2 ("yes do it") is its follow-up and gets no arrow.
  const followUp = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U2, 'yes do it') })
  expect(await followUp.find({ key: 'topic-fold' })).toBeUndefined()
  await followUp.unmount()
  const later = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U3, 'Set up the deploy pipeline for staging') })
  expect(await later.find({ key: 'topic-fold' })).toBeDefined()
  await later.unmount()

  const first = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U1, 'The login form rejects valid passwords') })
  expect((await first.find({ key: 'topic-fold' }))?.props.label).toBe('▼ Fold')
  await first.press({ key: 'topic-fold' })
  await first.unmount()

  const folded = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U1, 'The login form rejects valid passwords') })
  expect((await folded.find({ key: 'topic-open' }))?.props.label).toBe('▶ Unfold')
  expect(await folded.find({ type: 'Text', text: 'Valid passwords rejected · 2 exchanges · 1 tool call' })).toBeDefined()
  expect(await folded.find({ type: 'Text', text: '    ↳ Applied the fix' })).toBeDefined()
  await folded.unmount()

  for (const target of [ROWS.user(U2, 'yes do it'), ROWS.tool('toolu_1'), ROWS.assistant(A1, 'Fixed: the bcrypt cost was compared as a string.'), ROWS.assistant(A2, 'Done, tests pass.')]) {
    expect((await drawn($, target)).isHidden).toBe(true)
  }
  expect((await drawn($, ROWS.tool('toolu_3'))).isHidden).toBe(false)

  // ctrl+o shows the prompt whole, with no arrow.
  const expanded = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...ROWS.user(U2, 'yes do it', true) })
  expect(await expanded.find({ key: 'topic-fold' })).toBeUndefined()
  await expanded.unmount()

  expect((await $.command.run(run('unfold'))).text).toBe('Unfolded everything.')
  expect((await drawn($, ROWS.tool('toolu_1'))).isHidden).toBe(false)
})

test('every action in the conversation is a bracketed button with an icon and a word', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  world(on)
  await start($, clock)
  await $.command.run({ command: 'bp', args: 'a mark', origin: composer, presentation })

  const seen: Record<string, unknown> = {}
  const rows = [
    ROWS.user(U1, 'The login form rejects valid passwords'),
    ROWS.assistant(A3, 'Pipeline added to the CI config.'),
    { component: 'CommandOutput', requestId: 'row-of-mark', props: { command: 'bp', args: 'a mark', text: '◆ Breakpoint 3 · a mark', isErrored: false } },
  ] as const
  for (const target of rows) {
    const ui = await $.ui.mount({ plugin: 'breakpoints', surface: 'terminal', viewport, ...target } as Parameters<typeof $.ui.mount>[0])
    for (const key of ['fold-close', 'fold-recall', 'fold-rename', 'topic-fold', 'star', 'bp-fold', 'bp-recall', 'bp-remove']) {
      const found = await ui.find({ key })
      if (found === undefined) continue
      seen[key] = found.props.label
      expect(found.props.plain).toBeUndefined()
      expect(String(found.props.label)).toMatch(/^\S \p{Lu}\p{Ll}+$/u)
    }
    await ui.unmount()
  }

  expect(seen).toEqual({
    'fold-close': '▼ Fold',
    'fold-recall': '↩ Recall',
    'fold-rename': '✎ Rename',
    'topic-fold': '▼ Fold',
    star: '☆ Star',
    'bp-fold': '▼ Fold',
    'bp-recall': '↩ Recall',
    'bp-remove': '✕ Remove',
  })
})
