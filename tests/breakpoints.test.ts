import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const composer = { kind: 'composer' } as const
const presentation = { isFullscreen: true, columns: 160 }

const pane = {
  plugin: 'breakpoints',
  component: 'Pane',
  requestId: 'breakpoints',
  props: {
    title: 'Breakpoints',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
  viewport: { columns: 160, rows: 40, isFullscreen: true },
} as const

const bpRow = (id: number, label: string) =>
  ({
    plugin: 'breakpoints',
    component: 'CommandOutput',
    requestId: `row-of-bp-${id}`,
    props: { command: 'bp', args: label, text: `◆ Breakpoint ${id} · ${label}`, isErrored: false },
    viewport: { columns: 80, rows: 40, isFullscreen: true },
  }) as const

// The engine's side of what the plugin calls, answered from memory. The kit
// draws no transcript, so jumping is checked in a live session, not here.
function world(on: On, sessionId: string) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.id', () => ({ value: sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
}

test('/bp numbers breakpoints and takes the label it is given', async ($, on) => {
  world(on, 'session-a')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const bare = await $.command.run({ command: 'bp', args: '', origin: composer, presentation })
  expect(bare.text).toBe('◆ Breakpoint 1 · Breakpoint 1')

  const named = await $.command.run({ command: 'bp', args: '  tests   green ', origin: composer, presentation })
  expect(named.text).toBe('◆ Breakpoint 2 · tests green')
})

test('the transcript row of a breakpoint draws as a labelled rule', async ($, on) => {
  world(on, 'session-b')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'bp', args: 'deploy plan', origin: composer, presentation })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...bpRow(1, 'deploy plan'), surface })
    expect((await ui.find({ key: 'bp-fold' }))?.props.label).toBe('▼ Fold')
    expect(await ui.find({ type: 'Text', text: 'deploy plan' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane lists breakpoints with their number as hotkey, and removes one', async ($, on) => {
  world(on, 'session-c')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'bp', args: 'design agreed', origin: composer, presentation })
  await $.command.run({ command: 'bp', args: 'tests green', origin: composer, presentation })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    await ui.press({ key: 'tab-marks' })
    const entry = await ui.find({ key: 'm-2' })
    expect(entry?.props.label).toBe('tests green')
    expect(entry?.props.hotkey).toBe('2')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'del-1' })
  expect(await ui.find({ key: 'm-1' })).toBeUndefined()
  expect(await ui.find({ key: 'm-2' })).toBeDefined()

  await ui.press({ key: 'tab-outline' })
  expect(await ui.find({ key: 'm-2' })).toBeDefined()
  expect(await ui.find({ key: 'm-1' })).toBeUndefined()
  await ui.unmount()
})

test('/bps with text filters the list', async ($, on) => {
  world(on, 'session-d')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'bp', args: 'auth flow', origin: composer, presentation })
  await $.command.run({ command: 'bp', args: 'deploy plan', origin: composer, presentation })
  await $.command.run({ command: 'bps', args: 'DEPLOY', origin: composer, presentation })

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect(await ui.find({ key: 'm-1' })).toBeUndefined()
  expect(await ui.find({ key: 'm-2' })).toBeDefined()

  await ui.press({ key: 'clear-filter' })
  expect(await ui.find({ key: 'm-1' })).toBeDefined()
  await ui.unmount()
})

const line = (row: object) => JSON.stringify({ isSidechain: false, ...row })
const said = (uuid: string, at: string, content: unknown) =>
  line({ type: 'user', uuid, timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content } })
const answered = (uuid: string, text: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

const TRANSCRIPT = [
  said('u-1', '2026-10-14T09:00:00Z', 'The login form rejects   valid passwords'),
  answered('a-1-early', 'Looking into it.'),
  answered('a-1', 'Fixed: the bcrypt cost was compared as a string.'),
  line({ type: 'user', uuid: 'meta', isMeta: true, origin: { kind: 'human' }, message: { role: 'user', content: 'a reminder' } }),
  said('u-2', '2026-10-14T09:05:00Z', 'yes do it'),
  answered('a-2', 'Done, tests pass.'),
  line({ type: 'user', uuid: 'result', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
  said('u-3', '2026-10-14T09:30:00Z', [{ type: 'text', text: 'Set up the deploy pipeline for staging' }]),
  said('cmd', '2026-10-14T09:31:00Z', '<command-name>/effort</command-name>'),
  line({ type: 'assistant', uuid: 'side', isSidechain: true, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'subagent' }] } }),
  'not json',
].join('\n')

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('a conversation the mod never saw is read back and outlined: chapters, sub-topics, answers', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const grepped: string[][] = []
  const asked: string[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg/' })
  on('session.id', () => ({ value: 'session-e' }))
  on('session.root', () => ({ value: '/work/my.app' }))
  on('session.cwd', () => ({ value: '/work/my.app/sub' }))
  on('fs.exists', ($, e) => ({ value: e.path === '/cfg/projects/-work-my-app/session-e.jsonl' }))
  on('process.run', ($, e) => {
    grepped.push([...e.argv])

    return { value: { exitCode: 0, stdout: TRANSCRIPT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    const text = '1 | Login bug | Valid passwords rejected | Fixed bcrypt cost comparison\n2 | - | - | Applied the fix\n3 | "Deploy pipeline." | Staging pipeline | Asked which CI'

    return { value: { isAnswered: true, text, usage } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  // The engine's own prompt row, which the chapter title is drawn above.
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: `> ${e.props.text}` })
  })

  await $.session.start({ cwd: '/work/my.app', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  expect(grepped).toEqual([
    [
      'grep',
      '-F',
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
      '/cfg/projects/-work-my-app/session-e.jsonl',
    ],
  ])
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('[1] Developer: The login form rejects valid passwords\n     Assistant: Fixed: the bcrypt cost')
  expect(asked[0]).toContain('[2] Developer: yes do it\n     Assistant: Done, tests pass.')
  expect(asked[0]).toContain('[3] Developer: Set up the deploy pipeline for staging\n     Assistant: (no answer)')

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  const label = async (key: string) => (await ui.find({ key }))?.props.label

  expect(await label('c-1')).toBe('Login bug (1)')
  expect(await label('s-1')).toBeUndefined()
  expect(await label('c-2')).toBe('Deploy pipeline')
  expect(await label('s-3')).toBe('Staging pipeline')
  expect(await label('a-3')).toBeUndefined()

  await ui.press({ key: 'fold-1' })
  expect(await label('c-1')).toBe('Login bug')
  expect(await label('s-1')).toBe('Valid passwords rejected')
  expect(await label('a-1')).toBe('Fixed bcrypt cost comparison')
  expect(await label('s-2')).toBeUndefined()
  expect(await label('a-2')).toBe('Applied the fix')

  await ui.press({ key: 'tab-marks' })
  expect(await label('m-1')).toBe('Login bug')
  expect(await label('m-2')).toBe('Deploy pipeline')
  await ui.unmount()

  const opener = await $.ui.mount({
    plugin: 'breakpoints',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u-3',
    props: { text: 'Set up the deploy pipeline for staging', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 80, rows: 40, isFullscreen: true },
  })
  expect(await opener.find({ type: 'Text', text: 'Deploy pipeline' })).toBeDefined()
  expect(await opener.find({ type: 'Text', text: '> Set up the deploy pipeline for staging' })).toBeDefined()
  await opener.unmount()

  const plain = await $.ui.mount({
    plugin: 'breakpoints',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u-2',
    props: { text: 'yes do it', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 80, rows: 40, isFullscreen: true },
  })
  expect(await plain.find({ type: 'Text', text: /◇/ })).toBeUndefined()
  await plain.unmount()
})

test('recall pins a sub-topic, word for word, to the next message and then lets go', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const filled: string[] = []
  const submitted: { text: string; context?: readonly string[] }[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.id', () => ({ value: 'session-f' }))
  on('session.root', () => ({ value: '/work/my.app' }))
  on('session.cwd', () => ({ value: '/work/my.app' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: TRANSCRIPT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '1 | Login bug | Valid passwords rejected | Fixed bcrypt cost comparison\n2 | - | - | Applied the fix\n3 | Deploy pipeline | Staging pipeline | -',
      usage,
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.close', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)

    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })

    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })

  await $.session.start({ cwd: '/work/my.app', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'fold-1' })
  await ui.press({ key: 'recall-mode' })
  expect(await ui.find({ type: 'Text', text: /Pick what to bring back/ })).toBeDefined()
  await ui.press({ key: 's-1' })
  await ui.unmount()

  expect(filled).toEqual(['Re › "Valid passwords rejected": '])

  const band = await $.ui.mount({
    plugin: 'breakpoints',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ type: 'Text', text: /Valid passwords rejected \(sub-topic, 2 exchanges\)/ })).toBeDefined()
  await band.unmount()

  await $.prompt.submit({ text: 'explain the second step again', origin: composer, wait: false })
  const context = submitted[0]?.context ?? []
  expect(context).toHaveLength(1)
  expect(context[0]).toContain('<recalled_context what="sub-topic" title="Valid passwords rejected">')
  expect(context[0]).toContain('Developer:\nThe login form rejects   valid passwords\n\nAssistant:\nFixed: the bcrypt cost was compared as a string.')
  expect(context[0]).toContain('Developer:\nyes do it\n\nAssistant:\nDone, tests pass.')
  expect(context[0]).not.toContain('deploy pipeline')

  await $.prompt.submit({ text: 'and something else', origin: composer, wait: false })
  expect(submitted[1]?.context).toBeUndefined()
})

test('a reply that merges exchanges is not trusted: the batch is split and asked again', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const asked: string[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'session-g' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: TRANSCRIPT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    const text = e.prompt.includes('numbered 1, 2, 3,')
      ? '1 | Login bug | Login fix and follow-up | Fixed and applied\n2 | Deploy pipeline | Staging pipeline | -'
      : e.prompt.includes('numbered 1, 2,')
        ? '1 | Login bug | Valid passwords rejected | Fixed bcrypt cost\n2 | - | - | Applied the fix'
        : '3 | Deploy pipeline | Staging pipeline | -'

    return { value: { isAnswered: true, text, usage } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)
  expect(asked).toHaveLength(3)

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'fold-1' })
  const label = async (key: string) => (await ui.find({ key }))?.props.label
  expect(await label('s-1')).toBe('Valid passwords rejected')
  expect(await label('a-2')).toBe('Applied the fix')
  expect(await label('c-2')).toBe('Deploy pipeline')
  await ui.unmount()
})

test('an exchange answered again gets a new answer summary but keeps its title and chapter; repeated chapters go', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-14T10:00:00Z') })
  const asked: string[] = []
  const labelled = { isLabelled: true, at: 0 }
  mock.store(on, {
    'v:session-r': 2,
    's:session-r': {
      prompts: [
        { uuid: 'u-1', n: 1, text: 'The login form rejects valid passwords', title: 'Valid passwords rejected', answerTitle: 'Fixed bcrypt cost', ...labelled },
        { uuid: 'u-2', n: 2, text: 'yes do it', title: 'Retry the fix', answer: 'a-2', answerText: 'Done, tests pass.', at: 0 },
        { uuid: 'u-3', n: 3, text: 'Set up the deploy pipeline for staging', title: 'Staging pipeline', ...labelled },
      ],
      marks: [
        { id: 1, kind: 'auto', label: 'Login bug', anchor: 'u-1', anchorText: '', after: '', at: 0 },
        { id: 2, kind: 'auto', label: 'login bug!', anchor: 'u-3', anchorText: '', after: '', at: 0 },
      ],
    },
  })
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'session-r' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: TRANSCRIPT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)

    return { value: { isAnswered: true, text: '2 | Brand new chapter | Something else | Applied the fix again', usage } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('numbered 2,')

  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  const label = async (key: string) => (await ui.find({ key }))?.props.label
  expect(await label('c-1')).toBe('Login bug')
  expect(await label('c-2')).toBeUndefined()
  expect(await label('s-2')).toBe('Retry the fix')
  expect(await label('a-2')).toBe('Applied the fix again')
  expect(await label('s-3')).toBe('Staging pipeline')
  await ui.unmount()
})

test('the Outline button under the prompt toggles the panel, and carries the key binding', async ($, on) => {
  const opened: unknown[] = []
  const closed: unknown[] = []
  let isUp = false
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.id', () => ({ value: 'session-t' }))
  on('ui.panes', () => ({ value: isUp ? [{ id: 'breakpoints', title: 'Breakpoints', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.open', ($, e) => {
    opened.push(e)
    isUp = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e)
    isUp = false

    return { value: undefined }
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ children: e.props.hint }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const hint = await $.ui.mount({
      plugin: 'breakpoints',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    const button = await hint.find({ key: 'bps-toggle' })
    expect(button?.props).toEqual(expect.objectContaining({ label: '◇ Outline', action: 'app:toggleDiffNoiseFilter' }))
    expect(await hint.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    await hint.unmount()
  }

  const hint = await $.ui.mount({
    plugin: 'breakpoints',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
  })
  await hint.press({ key: 'bps-toggle' })
  expect(opened).toEqual([expect.objectContaining({ id: 'breakpoints', focus: true, closeOnEscape: true })])
  await hint.press({ key: 'bps-toggle' })
  expect(closed).toEqual([expect.objectContaining({ id: 'breakpoints' })])
  await hint.unmount()
})
