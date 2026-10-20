import { expect, test } from 'claude-code/testing'

import type { BreakpointMark, BreakpointPrompt } from '../types'
import { breakpointScope } from '../hooks/fold-lib'
import { buildOutline, chapterBefore, chapterScope, filterOutline, isComplete, isSameTitle, parseLabels, repeatedChapters, parseTranscript, recallBlock, sectionScope } from '../hooks/outline'

const prompt = (n: number, extra: Partial<BreakpointPrompt> = {}): BreakpointPrompt => ({
  uuid: `u-${n}`,
  text: `prompt ${n}`,
  at: 0,
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

test('labels: dashes and "same" mean none, decoration is stripped, junk lines are ignored', async () => {
  expect(parseLabels('Here you go:\n[4] | - | "Fix the pane." | **Added closeOnEscape**\n5 | Same | — | n/a\n')).toEqual([
    { n: 4, chapter: '', section: 'Fix the pane', answer: 'Added closeOnEscape' },
    { n: 5, chapter: '', section: '', answer: '' },
  ])
})

test('a transcript gives each prompt the last final answer before the next prompt', async () => {
  const found = parseTranscript(
    [
      JSON.stringify({ type: 'user', uuid: 'p', origin: { kind: 'human' }, message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', uuid: 'x', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'working' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'a', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'b', message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'c', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'second' }] } }),
    ].join('\n'),
  )

  expect(found.prompts.map(one => one.uuid)).toEqual(['p'])
  expect(found.answers.get('p')).toEqual({ uuid: 'c', text: 'second' })
})

test('the outline nests sub-topics and answers under chapters, folds all but the last, and merges follow-ups', async () => {
  const said = [
    prompt(1, { title: 'Build the mod', answer: 'r-1', answerTitle: 'Built it' }),
    prompt(2, { title: '', answer: 'r-2', answerTitle: 'Tweaked it' }),
    prompt(3, { title: 'Escape closes pane', answer: 'r-3', answerTitle: 'Added closeOnEscape' }),
    prompt(4, { isLabelled: false, text: 'still being titled' }),
  ]
  const marks = [chapter(1, 'u-1', 'Mod'), chapter(2, 'u-3', 'Pane fixes')]

  const kinds = (rows: ReturnType<typeof buildOutline>) =>
    rows.map(row =>
      row.kind === 'chapter'
        ? `${row.isOpen ? '▾' : '▸'} ${row.mark.label} ${row.sections}`
        : row.kind === 'mark'
          ? `◆ ${row.mark.label}`
          : `${row.kind === 'section' ? '›' : '↳'} ${row.title}`,
    )

  expect(kinds(buildOutline(marks, said, []))).toEqual([
    '▸ Mod 1',
    '▾ Pane fixes 2',
    '› Escape closes pane',
    '↳ Added closeOnEscape',
    '› still being titled',
  ])
  expect(kinds(buildOutline(marks, said, [1, 2]))).toEqual([
    '▾ Mod 1',
    '› Build the mod',
    '↳ Built it',
    '↳ Tweaked it',
    '▸ Pane fixes 2',
  ])
  expect(kinds(filterOutline(marks, said, 'tweak'))).toEqual(['▾ Mod 1', '↳ Tweaked it'])
})

test('a chapter recalls up to the next chapter, a sub-topic only its follow-ups', async () => {
  const said = [
    prompt(1, { title: 'Build the mod' }),
    prompt(2, { title: '' }),
    prompt(3, { title: 'Escape closes pane' }),
    prompt(4, { title: 'Next chapter work' }),
  ]
  const marks = [chapter(1, 'u-1', 'Mod'), chapter(2, 'u-4', 'Later')]

  expect(chapterScope(marks[0] as BreakpointMark, marks, said).map(one => one.n)).toEqual([1, 2, 3])
  expect(sectionScope(said[0] as BreakpointPrompt, marks, said).map(one => one.n)).toEqual([1, 2])
  expect(sectionScope(said[2] as BreakpointPrompt, marks, said).map(one => one.n)).toEqual([3])
  expect(recallBlock('answer', 'Say "hi"', [{ prompt: 'q', answer: '' }])).toContain(
    `title="Say 'hi'">`,
  )
})

test('a reply must name each exchange it was asked about exactly once', async () => {
  const batch = [prompt(4), prompt(5)]

  expect(isComplete(batch, parseLabels('4 | - | a | b\n5 | - | c | d'))).toBe(true)
  expect(isComplete(batch, parseLabels('4 | - | a | b'))).toBe(false)
  expect(isComplete(batch, parseLabels('4 | - | a | b\n4 | - | c | d'))).toBe(false)
  expect(isComplete(batch, parseLabels('4. | - | a | b\n[5] | - | c | d'))).toBe(true)
})

test('a chapter named like the one before it is a repeat, a renamed one never is', async () => {
  const said = [prompt(1), prompt(2), prompt(3), prompt(4)]
  const marks = [
    chapter(1, 'u-1', 'Breakpoints mod for Claude Code'),
    chapter(2, 'u-2', 'breakpoints mod for claude code!'),
    chapter(3, 'u-3', 'Search'),
    { ...chapter(4, 'u-4', 'search'), isRenamed: true },
  ]

  expect(isSameTitle('Login  bug', 'login-bug.')).toBe(true)
  expect(chapterBefore(marks, said, 'u-3')?.id).toBe(2)
  expect(repeatedChapters(marks, said)).toEqual([2])
})

test('a /bp folds the exchanges after it, stopping at the next /bp or chapter', async () => {
  const said = [prompt(1), prompt(2), prompt(3), prompt(4), prompt(5)]
  const bp = (id: number, after: string): BreakpointMark => ({ id, kind: 'manual', label: `bp ${id}`, anchor: '', anchorText: '', after, at: 0 })
  const marks = [chapter(1, 'u-1', 'Start'), bp(2, 'u-1'), bp(3, 'u-2'), chapter(4, 'u-4', 'Later'), bp(5, 'u-4'), bp(6, 'u-4')]

  expect(breakpointScope(marks[1] as BreakpointMark, marks, said).map(one => one.n)).toEqual([2])
  expect(breakpointScope(marks[2] as BreakpointMark, marks, said).map(one => one.n)).toEqual([3])
  expect(breakpointScope(marks[4] as BreakpointMark, marks, said).map(one => one.n)).toEqual([])
  expect(breakpointScope(marks[5] as BreakpointMark, marks, said).map(one => one.n)).toEqual([5])
})
