import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { BreakpointMark, BreakpointPrompt } from '../types'
import {
  OUTLINE_MARK,
  compactionOutline,
  exportDirectory,
  exportFileName,
  exportMarkdown,
  exportScope,
  parseExportArgs,
  withOutline,
} from '../hooks/export-lib'

const composer = { kind: 'composer' } as const
const presentation = { isFullscreen: true, columns: 160 }
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const NOW = Date.parse('2026-10-14T10:00:00Z')

const line = (row: object) => JSON.stringify({ isSidechain: false, ...row })
const said = (uuid: string, at: string, content: string) =>
  line({ type: 'user', uuid, timestamp: at, origin: { kind: 'human' }, message: { role: 'user', content } })
const answered = (uuid: string, text: string) =>
  line({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

const TRANSCRIPT = [
  said('u-1', '2026-10-14T09:00:00Z', 'The login form rejects   valid passwords'),
  answered('a-1', 'Fixed:\n\n1. the bcrypt cost was compared as a string\n2. tests added'),
  said('u-2', '2026-10-14T09:05:00Z', 'yes do it'),
  answered('a-2', 'Done, tests pass.'),
  said('u-3', '2026-10-14T09:30:00Z', 'Set up the deploy pipeline for staging'),
  answered('a-3', 'Which CI do you use?'),
].join('\n')

const LABELS = '1 | Login bug | Valid passwords rejected | Fixed bcrypt cost\n2 | - | - | Applied the fix\n3 | Deploy pipeline | Staging pipeline | Asked which CI'

// The engine's side, answered from memory: a conversation of three prompts
// that the catch-up reads back and labels into two chapters.
function world(on: On, writes: { path: string; text: string }[], taken: readonly string[] = []) {
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'session-x' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', ($, e) => ({ value: e.path.endsWith('.jsonl') || taken.includes(e.path) }))
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: TRANSCRIPT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', ($, e) => ({
    value: {
      isAnswered: true,
      text: e.prompt.includes('Write notes for the developer') ? '## Summary\nFixed the login.\n## Decisions\n- None\n## Open questions\n- None' : LABELS,
      usage,
    },
  }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const prompt = (n: number, extra: Partial<BreakpointPrompt> = {}): BreakpointPrompt => ({
  uuid: `u-${n}`,
  text: `prompt ${n}`,
  at: Date.parse('2026-10-14T09:00:00Z') + n * 60_000,
  n,
  isLabelled: true,
  ...extra,
})
const chapter = (id: number, anchor: string, label: string): BreakpointMark => ({
  id,
  kind: 'auto',
  label,
  anchor,
  anchorText: '',
  after: '',
  at: 0,
})

const SAID = [
  prompt(1, { title: 'Valid passwords rejected', answer: 'a-1', answerTitle: 'Fixed bcrypt cost' }),
  prompt(2, { title: '', answer: 'a-2', answerTitle: 'Applied the fix' }),
  prompt(3, { title: 'Staging pipeline', answer: 'a-3', answerTitle: 'Asked which CI' }),
]
const MARKS = [chapter(1, 'u-1', 'Login bug'), chapter(2, 'u-3', 'Deploy pipeline')]

test('export arguments: a number, words, all, the newest by default, and --summary anywhere', async () => {
  expect(parseExportArgs('')).toEqual({ target: { kind: 'newest' }, withSummary: false })
  expect(parseExportArgs('2 --summary')).toEqual({ target: { kind: 'number', n: 2 }, withSummary: true })
  expect(parseExportArgs('-s deploy  pipeline')).toEqual({ target: { kind: 'words', words: 'deploy pipeline' }, withSummary: true })
  expect(parseExportArgs('ALL')).toEqual({ target: { kind: 'all' }, withSummary: false })
})

test('a chapter export covers its prompts up to the next chapter', async () => {
  const scope = (rest: string) => exportScope(parseExportArgs(rest), MARKS, SAID)

  expect(scope('')).toEqual({ title: 'Deploy pipeline', prompts: [SAID[2]], isWhole: false })
  expect(scope('1')).toEqual({ title: 'Login bug', prompts: [SAID[0], SAID[1]], isWhole: false })
  expect(scope('login')).toEqual({ title: 'Login bug', prompts: [SAID[0], SAID[1]], isWhole: false })
  expect(scope('all')).toEqual({ title: 'Conversation', prompts: SAID, isWhole: true })
  expect(scope('7')).toEqual({ error: 'No chapter number 7. There are 2 chapters: 1. Login bug, 2. Deploy pipeline.' })
  expect(exportScope(parseExportArgs(''), [], SAID)).toEqual({ title: 'Conversation', prompts: SAID, isWhole: true })
  expect(exportScope(parseExportArgs('2'), [], SAID)).toEqual({
    error: 'This conversation has no chapters yet; `/bps export all` exports all of it.',
  })
})

test('file names: dated slug in the export folder, numbered when taken', async () => {
  expect(exportFileName('/work/docs/conversations/', 'Login bug: the "fix"!', NOW, 1)).toBe('/work/docs/conversations/2026-10-14-login-bug-the-fix.md')
  expect(exportFileName('/x', '???', NOW, 3)).toBe('/x/2026-10-14-conversation-3.md')
  expect(exportDirectory('', '/work', '/home/me')).toBe('/work/docs/conversations')
  expect(exportDirectory('./notes', '/work/', '/home/me')).toBe('/work/notes')
  expect(exportDirectory('~/exports', '/work', '/home/me')).toBe('/home/me/exports')
  expect(exportDirectory('/tmp/out', '/work', '/home/me')).toBe('/tmp/out')
})

test('the markdown has the outline and every exchange verbatim', async () => {
  const markdown = exportMarkdown({
    scope: { title: 'Login bug', prompts: [SAID[0] as BreakpointPrompt, SAID[1] as BreakpointPrompt], isWhole: false },
    all: MARKS,
    said: SAID,
    exchanges: [
      { prompt: SAID[0] as BreakpointPrompt, words: 'The login form rejects   valid passwords', answer: 'Fixed:\n\n1. one\n2. two' },
      { prompt: SAID[1] as BreakpointPrompt, words: 'yes do it', answer: '' },
    ],
    sessionId: 'session-x',
    exportedAt: NOW,
  })

  expect(markdown).toBe(
    [
      '# Login bug',
      'Exported 2026-10-14 from Claude Code conversation `session-x`: 2 exchanges, 2026-10-14 09:01 to 2026-10-14 09:02 UTC.',
      '## Outline\n\n- Valid passwords rejected\n  - ↳ Fixed bcrypt cost\n  - ↳ Applied the fix',
      '## Conversation',
      '### 1. Valid passwords rejected',
      '**Developer** (2026-10-14 09:01 UTC)\n\nThe login form rejects   valid passwords',
      '**Claude**\n\nFixed:\n\n1. one\n2. two',
      '### 2. Follow-up',
      '**Developer** (2026-10-14 09:02 UTC)\n\nyes do it',
      '**Claude**\n\n_No final answer recorded._',
    ].join('\n\n') + '\n',
  )
})

test('the compaction outline lists chapters, sub-topics and answers, and replaces an older one', async () => {
  const outline = compactionOutline(MARKS, SAID) ?? ''

  expect(outline.startsWith(OUTLINE_MARK)).toBe(true)
  expect(outline).toContain('◇ Login bug\n  › Valid passwords rejected\n    ↳ Fixed bcrypt cost\n    ↳ Applied the fix\n◇ Deploy pipeline\n  › Staging pipeline')
  expect(outline).toContain('/bps')
  expect(compactionOutline([], [prompt(1, { isLabelled: false })])).toBeNull()

  const summary: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }
  const kept: SessionMessage = { role: 'assistant', text: 'kept', toolUses: [] }
  const old: SessionMessage = { role: 'user', text: `${OUTLINE_MARK}\nold\n</conversation_outline>`, toolUses: [] }

  expect(withOutline([summary, old, kept], 'new').map(one => one.text)).toEqual(['summary', 'new', 'kept'])
  expect(withOutline([], 'new').map(one => one.text)).toEqual(['new'])
})

test('/bps export writes the chapter as markdown, next to a file of the same name', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const clock = mock.clock(on, { now: NOW })
  world(on, writes, ['/work/docs/conversations/2026-10-14-login-bug.md'])

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  const ran = await $.command.run({ command: 'bps', args: 'export 1', origin: composer, presentation })
  expect(ran.text).toBe('Exported "Login bug" (2 exchanges) to docs/conversations/2026-10-14-login-bug-2.md')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.path).toBe('/work/docs/conversations/2026-10-14-login-bug-2.md')
  expect(writes[0]?.text).toContain('**Developer** (2026-10-14 09:00 UTC)\n\nThe login form rejects   valid passwords')
  expect(writes[0]?.text).toContain('**Claude**\n\nFixed:\n\n1. the bcrypt cost was compared as a string\n2. tests added')
  expect(writes[0]?.text).not.toContain('deploy pipeline')

  const missing = await $.command.run({ command: 'bps', args: 'export kubernetes', origin: composer, presentation })
  expect(missing.text).toContain('No chapter matching "kubernetes"')
  expect(writes).toHaveLength(1)

  const other = await $.command.run({ command: 'bps', args: 'deploy', origin: composer, presentation })
  expect(other.text).toBeUndefined()
})

test('the export folder is an option, and --summary puts Haiku notes on top', { options: { exportDir: '~/notes' } }, async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const clock = mock.clock(on, { now: NOW })
  world(on, writes)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  const ran = await $.command.run({ command: 'bps', args: 'export --summary', origin: composer, presentation })
  expect(ran.text).toBe('Exported "Deploy pipeline" (1 exchange, with a summary) to /home/me/notes/2026-10-14-deploy-pipeline.md')
  expect(writes[0]?.text).toContain('UTC.\n\n## Summary\nFixed the login.\n## Decisions')
  expect(writes[0]?.text.indexOf('## Summary')).toBeLessThan(writes[0]?.text.indexOf('## Conversation') ?? 0)
})

test('a compaction of the main conversation keeps exactly one outline; others are left alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, [])
  const compacted: SessionMessage[] = [
    { role: 'user', text: 'This session is being continued: summary', toolUses: [] },
    { role: 'user', text: `${OUTLINE_MARK}\nan outline from an earlier compaction\n</conversation_outline>`, toolUses: [] },
    { role: 'assistant', text: 'kept', toolUses: [] },
  ]
  on('session.compact', () => ({ messages: compacted }))

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await clock.advance(200)

  const messages = [{ role: 'user' as const, text: 'old', toolUses: [] }]
  const done = await $.session.compact({ trigger: 'manual', messages })
  const outlines = (done.messages ?? []).filter(one => one.text.includes(OUTLINE_MARK))
  expect(outlines).toHaveLength(1)
  expect(outlines[0]?.text).toContain('◇ Login bug')
  expect(outlines[0]?.text).toContain('◇ Deploy pipeline')
  expect(done.messages?.[1]?.text).toBe(outlines[0]?.text)

  const agents = await $.session.compact({ trigger: 'auto', messages, agentId: 'agent-1' })
  expect(agents.messages).toEqual(compacted)

  const ahead = await $.session.compact({ trigger: 'precompute', messages })
  expect(ahead.messages).toEqual(compacted)
})
