import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { BreakpointMark, BreakpointPrompt } from '../types'

const pane = {
  plugin: 'breakpoints',
  component: 'Pane',
  requestId: 'breakpoints',
  props: {
    title: 'Breakpoints',
    isFocused: true,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 200, rows: 50, isFullscreen: true },
} as const

const MINUTE = 60_000

const said: BreakpointPrompt[] = [
  {
    uuid: 'u-1',
    text: 'The login form rejects valid passwords',
    at: 0,
    n: 1,
    title: 'Valid passwords rejected',
    answer: 'r-1',
    answerTitle: 'Fixed bcrypt cost',
    isLabelled: true,
    durationMs: 10 * MINUTE,
    tokens: 1000,
    costUsd: 0.3,
  },
  {
    uuid: 'u-2',
    text: 'apply it to the signup form too',
    at: 0,
    n: 2,
    title: 'Apply the fix',
    answer: 'r-2',
    answerTitle: 'Applied it',
    isLabelled: true,
    durationMs: 5 * MINUTE,
    tokens: 500,
    costUsd: 0.2,
  },
  { uuid: 'u-3', text: 'Set up the deploy pipeline', at: 0, n: 3, title: 'Staging pipeline', isLabelled: true },
  { uuid: 'u-4', text: 'add a rollback step', at: 0, n: 4, title: 'Rollback step', isLabelled: true },
]

const chapter = (id: number, anchor: string, label: string): BreakpointMark => ({
  id,
  kind: 'auto',
  label,
  anchor,
  anchorText: '',
  after: '',
  at: 0,
})

const marks: BreakpointMark[] = [
  chapter(1, 'u-1', 'Login bug'),
  chapter(2, 'u-3', 'Deploy pipeline'),
  { id: 3, kind: 'star', label: 'Fixed bcrypt cost', anchor: 'r-1', anchorText: '', after: 'u-1', at: 0 },
]

// A conversation saved before this run: the panel reads it back at the start,
// with nothing left to label, so no model call is made.
function savedWorld(on: On, statuses: (string | undefined)[], spent: number[] = []) {
  const clock = mock.clock(on, { now: 10 * MINUTE })
  mock.store(on, { 's:session-p': { marks, prompts: said }, 'v:session-p': 2 })
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'session-p' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: spent.shift() ?? 0 } },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })

  return clock
}

const start = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

test('a starred answer is listed under that answer and in the breakpoints list', async ($, on) => {
  savedWorld(on, [])
  await $.session.start(start)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    await ui.press({ key: 'fold-1' })
    expect((await ui.find({ key: 'a-1' }))?.props.label).toBe('Fixed bcrypt cost')
    expect((await ui.find({ key: 'm-3' }))?.props.label).toBe('Fixed bcrypt cost')
    expect(await ui.find({ type: 'Text', text: /☆/ })).toBeDefined()

    await ui.press({ key: 'tab-marks' })
    const star = await ui.find({ key: 'm-3' })
    expect(star?.props.hotkey).toBe('2')
    await ui.press({ key: 'tab-outline' })
    await ui.press({ key: 'fold-1' })
    await ui.unmount()
  }
})

test('edit mode splits a chapter at a sub-topic, merges it back, and renames one', async ($, on) => {
  const statuses: (string | undefined)[] = []
  savedWorld(on, statuses)
  await $.session.start(start)
  expect(statuses).toEqual(['◇ Deploy pipeline'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    const label = async (key: string) => (await ui.find({ key }))?.props.label

    expect(await ui.find({ key: 'split-2' })).toBeUndefined()
    await ui.press({ key: 'edit-mode' })
    expect(await ui.find({ type: 'Text', text: /Rename or merge a chapter/ })).toBeDefined()
    await ui.press({ key: 'fold-1' })

    expect(await label('merge-1')).toBe(' ✕')
    expect(await label('merge-2')).toBe(' merge ↑')
    expect(await ui.find({ key: 'split-1' })).toBeUndefined()

    await ui.press({ key: 'split-2' })
    expect(await label('c-4')).toBe('Apply the fix')
    await ui.press({ key: 'merge-4' })
    expect(await ui.find({ key: 'c-4' })).toBeUndefined()
    await ui.press({ key: 'split-2' })
    expect(await label('c-4')).toBe('Apply the fix')
    expect(await ui.find({ key: 'c-5' })).toBeUndefined()
    await ui.press({ key: 'merge-4' })

    await ui.press({ key: 'rename-2' })
    expect((await ui.find({ key: 'rename' }))?.props.value).toBe(surface === 'terminal' ? 'Deploy pipeline' : 'Deploys')
    await ui.input({ key: 'rename', text: 'Deploys' })
    expect(await ui.find({ key: 'rename' })).toBeUndefined()
    expect(await label('c-2')).toBe('Deploys')

    await ui.press({ key: 'rename-2' })
    await ui.input({ key: 'rename', text: '   ' })
    expect(await label('c-2')).toBe('Deploys')

    await ui.press({ key: 'edit-mode' })
    expect(await ui.find({ key: 'rename-2' })).toBeUndefined()
    await ui.press({ key: 'fold-1' })
    await ui.unmount()
  }

  expect(statuses.at(-1)).toBe('◇ Deploys')
})

test('turning auto off clears the status line', async ($, on) => {
  const statuses: (string | undefined)[] = []
  savedWorld(on, statuses)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start(start)

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'auto' })
  expect(statuses).toEqual(['◇ Deploy pipeline', undefined])
  await ui.unmount()
})

test('each turn adds its time and cost to the prompt it answered; chapters total them', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const clock = savedWorld(on, statuses, [1.0, 1.5])
  await $.session.start(start)

  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, model: 'm' }
  const turn = { answer: 'done', durationMs: MINUTE, isAborted: false, reason: 'answer', usage } as const
  await $.turn.complete({ ...turn, turnId: 't-1' })
  await clock.advance(50)
  await $.turn.complete({ ...turn, turnId: 't-2' })
  await clock.advance(50)

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / \$0\.50 · 2 min ·/ })).toBeDefined()
  await ui.press({ key: 'fold-1' })
  expect(await ui.find({ type: 'Text', text: / \$0\.50 · 15 min ·/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / \$0\.30 · 10 min ·/ })).toBeDefined()
  await ui.unmount()
})

test('the status line follows a chapter added after the start', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const clock = savedWorld(on, statuses)
  await $.session.start(start)

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'edit-mode' })
  await ui.press({ key: 'merge-2' })
  expect(statuses.at(-1)).toBe('◇ Login bug')
  await ui.unmount()

  await clock.advance(6000)
  expect(statuses).toEqual(['◇ Deploy pipeline', '◇ Login bug'])
})

test('splitting the last chapter leaves the new last chapter open', async ($, on) => {
  savedWorld(on, [])
  await $.session.start(start)

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'edit-mode' })
  await ui.press({ key: 'split-4' })
  expect((await ui.find({ key: 'c-4' }))?.props.label).toBe('Rollback step')
  expect(await ui.find({ key: 's-4' })).toBeDefined()
  expect((await ui.find({ key: 'c-2' }))?.props.label).toBe('Deploy pipeline (1)')
  await ui.unmount()
})
