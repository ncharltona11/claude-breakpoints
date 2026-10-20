import { atom, read, update } from 'claude-code'
import type { On, RenderElement } from 'claude-code'

import type { BreakpointMark, BreakpointPrompt } from '../../types'
import {
  OWNER_PATTERNS,
  breakpointScope,
  chapterList,
  foldedTopicLine,
  opensTopic,
  foldTargets,
  foldView,
  foldedLine,
  isRowShown,
  parseOwners,
  summaryLines,
  summaryRequest,
} from '../fold-lib'
import type { FoldView, RowKind } from '../fold-lib'
import { clip, squash, textOf } from '../outline'
import {
  MARK_TEXT,
  PANE,
  TITLE,
  answerRows,
  askHaiku,
  later,
  markRows,
  marks,
  nextId,
  persist,
  promptRows,
  prompts,
  readTranscript,
  recallRow,
  rowKey,
  session,
  syncSession,
  transcriptPath,
} from './core'
import type { Dollar } from './core'

const foldedChapters = atom({ plugin: 'breakpoints', key: 'folded' } as const, [])
const foldStyleSetting = atom({ plugin: 'breakpoints', key: 'foldStyle' } as const, 'heading')
const readingMode = atom({ plugin: 'breakpoints', key: 'isReading' } as const, false)
const foldedTopics = atom({ plugin: 'breakpoints', key: 'foldedTopics' } as const, [])
const renamingChapter = atom({ plugin: 'breakpoints', key: 'renaming' } as const, 0)
const editingChapters = atom({ plugin: 'breakpoints', key: 'isEditing' } as const, false)

const READING = 'reading'
const FOLD_STYLE = 'foldStyle'
const FOLD_WORDS = ['fold', 'unfold', 'reading', 'fold-style']
const PRESENTATION = 'presentation'
// Every action in the conversation draws the same way: a bracketed button, an
// icon and a word, dim until pointed at. A terminal cell cannot be drawn
// larger, so the word is what makes them easy to spot and to hit.
const ACTIONS = {
  fold: '▼ Fold',
  unfold: '▶ Unfold',
  recall: '↩ Recall',
  rename: '✎ Rename',
  remove: '✕ Remove',
  star: '☆ Star',
  starred: '★ Starred',
}

// Which prompt each transcript row belongs to: row id (a message uuid or a
// tool_use_id) to prompt uuid. Rows added while the mod runs are filed as they
// are appended; older rows are read from the transcript file the first time
// folding or reading mode needs them. Module memory: a reload reads the file
// again, which takes a few milliseconds.
const foldOwners = new Map<string, string>()
// Claude's text blocks by what they say, in case a row is drawn under an id
// other than the uuid it was stored under.
const foldTextOwners = new Map<string, string>()
const foldFiled = new Set<string>()
let foldCurrent: string | undefined

function foldOwnerOf(id: string, text?: string): string | undefined {
  return foldOwners.get(id) ?? (text === undefined ? undefined : foldTextOwners.get(rowKey(text)))
}

// The prompt a row hands its owner to: the last one the person sent.
async function foldCurrentPrompt($: Dollar): Promise<string | undefined> {
  if (foldCurrent === undefined) foldCurrent = (await read($, prompts)).at(-1)?.uuid

  return foldCurrent
}

// Files every row of the transcript under its prompt, once per conversation.
async function foldFileOwners($: Dollar): Promise<void> {
  const id = await read($, session)
  if (id === '' || foldFiled.has(id)) return

  const path = await transcriptPath($, id)
  if (path === undefined) return

  const patterns = OWNER_PATTERNS.flatMap(pattern => ['-e', pattern])
  const run = await $.process.run(['grep', '-n', '-o', '-E', ...patterns, path], { timeoutMs: 15_000 })
  if (run.exitCode !== 0) return

  const known = new Set((await read($, prompts)).map(one => one.uuid))
  for (const [row, owner] of parseOwners(run.stdout, known)) {
    if (!foldOwners.has(row)) foldOwners.set(row, owner)
  }
  foldFiled.add(id)
}

// Called from main's session.start: reading mode and the fold style are
// preferences kept across sessions; folds already set (a reload) need the
// rows filed again before they can hide anything.
export async function transcriptOnStart($: Dollar): Promise<void> {
  const reading = await $.store.get(READING)
  const style = await $.store.get(FOLD_STYLE)
  await update($, readingMode, () => reading === true)
  await update($, foldStyleSetting, () => (style === 'summary' ? 'summary' : 'heading'))

  if (reading === true || (await read($, foldedChapters)).length > 0) {
    later($, () => foldRefile($))
  }
}

// Called from core's syncSession: another conversation is in view.
export function transcriptOnSwitch($: Dollar): void {
  foldOwners.clear()
  foldTextOwners.clear()
  foldCurrent = undefined
  later($, () => foldReset($))
}

async function foldReset($: Dollar): Promise<void> {
  await update($, foldedChapters, () => [])
  await update($, foldedTopics, () => [])
  if (await read($, readingMode)) await foldRefile($)
}

// Files the rows, then draws every hooked row again with the owners known.
async function foldRefile($: Dollar): Promise<void> {
  await foldFileOwners($)
  await update($, foldedChapters, list => [...list])
}

async function foldSet($: Dollar, ids: readonly number[], isFolded: boolean): Promise<void> {
  if (isFolded) await foldFileOwners($)
  await update($, foldedChapters, list =>
    isFolded ? [...new Set([...list, ...ids])] : list.filter(one => !ids.includes(one)),
  )
  if (isFolded && (await read($, foldStyleSetting)) === 'summary') later($, () => foldSummarise($))
}

// A two-line summary for every folded chapter that has none yet.
async function foldSummarise($: Dollar): Promise<void> {
  const folded = await read($, foldedChapters)
  const said = await read($, prompts)
  const all = await read($, marks)
  const missing = all.filter(one => folded.includes(one.id) && one.kind === 'auto' && !one.summary)
  if (missing.length === 0) return

  const found = await readTranscript($, await read($, session))
  for (const mark of missing) {
    const scope = foldView(all, said, [mark.id]).scopes.get(mark.id) ?? []
    const exchanges = scope.map(prompt => ({
      prompt: found.words.get(prompt.uuid) ?? prompt.text,
      answer: found.answers.get(prompt.uuid)?.text ?? '',
    }))
    const reply = await askHaiku($, summaryRequest(mark.label, exchanges), 160, 60_000)
    if (reply === null) return

    const summary = summaryLines(reply).join('\n')
    await update($, marks, list => list.map(one => (one.id === mark.id ? { ...one, summary } : one)))
    await persist($)
  }
}

async function foldSetReading($: Dollar, isOn: boolean): Promise<void> {
  if (isOn) await foldFileOwners($)
  await update($, readingMode, () => isOn)
  await $.store.set(READING, isOn)
}

async function foldToggleStar($: Dollar, prompt: BreakpointPrompt, rowId: string, text: string): Promise<void> {
  const key = rowKey(text)
  const at = await $.clock.now()

  await update($, marks, list => {
    const kept = list.find(one => one.kind === 'star' && one.after === prompt.uuid && (one.anchor === rowId || one.anchorText === key))
    if (kept !== undefined) return list.map(one => (one === kept ? { ...one, isRemoved: one.isRemoved !== true } : one))

    const star: BreakpointMark = {
      id: nextId(list),
      kind: 'star',
      label: prompt.answerTitle ?? clip(squash(text), 60),
      anchor: prompt.answer ?? rowId,
      anchorText: key,
      after: prompt.uuid,
      at,
    }

    return [...list, star]
  })
  await persist($)
}

// Tool calls made by the exchanges a fold holds.
function foldToolCount(scope: readonly BreakpointPrompt[]): number {
  const inScope = new Set(scope.map(one => one.uuid))

  return [...foldOwners].filter(([row, owner]) => row.startsWith('toolu_') && inScope.has(owner)).length
}

// A sub-topic's Fold / Unfold on its prompt row.
async function foldTopic($: Dollar, uuid: string, isFolded: boolean): Promise<void> {
  if (isFolded) await foldFileOwners($)
  await update($, foldedTopics, list => (isFolded ? [...new Set([...list, uuid])] : list.filter(one => one !== uuid)))
}

// A /bp's Fold: fold what follows it, or say there is nothing yet.
async function foldBreakpoint($: Dollar, mark: BreakpointMark): Promise<void> {
  const scope = breakpointScope(mark, await read($, marks), await read($, prompts))
  if (scope.length === 0) {
    $.ui.toast('Nothing after this breakpoint to fold yet.')

    return
  }
  await foldSet($, [mark.id], true)
}

async function foldRemoveMark($: Dollar, id: number): Promise<void> {
  await update($, marks, list => list.map(one => (one.id === id ? { ...one, isRemoved: true } : one)))
  await persist($)
}

async function foldRename($: Dollar, mark: BreakpointMark): Promise<void> {
  await update($, renamingChapter, () => mark.id)
  await update($, editingChapters, () => true)
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

// What the hooks below need to decide a row: the folds and reading mode, and
// (only when one is on) the outline they apply to.
async function foldContext($: Dollar): Promise<{ view: FoldView; isReading: boolean; said: readonly BreakpointPrompt[] } | null> {
  const folded = await read($, foldedChapters)
  const topics = await read($, foldedTopics)
  const isReading = await read($, readingMode)
  if (folded.length === 0 && topics.length === 0 && !isReading) return null

  const said = await read($, prompts)
  const view = foldView(await read($, marks), said, folded, topics)

  return { view, isReading, said }
}

async function foldIsShown($: Dollar, kind: RowKind, owner: string | undefined, isFinal = false): Promise<boolean> {
  const context = await foldContext($)
  if (context === null) return true

  const prompt = owner === undefined ? undefined : context.said.find(one => one.uuid === owner)
  const reading = { isOn: context.isReading, isAnswered: prompt?.answer !== undefined, isFinal }

  return isRowShown(kind, owner, context.view, reading)
}

export const registerTranscript = (on: On) => {
  // Rows are filed under the prompt above them as the conversation grows.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    const isPersons = e.origin.kind === 'composer' || e.origin.kind === 'bridge'

    if (stored.uuid !== undefined && e.agentId === undefined && e.message.isMeta !== true && isPersons) {
      foldCurrent = stored.uuid
      foldOwners.set(stored.uuid, stored.uuid)
    }

    return stored
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    const owner = stored.uuid === undefined || e.agentId !== undefined ? undefined : await foldCurrentPrompt($)
    if (owner === undefined || stored.uuid === undefined) return stored

    foldOwners.set(stored.uuid, owner)
    for (const block of stored.message.content as readonly unknown[]) {
      const one = block as { type?: unknown; id?: unknown }
      if (one.type === 'tool_use' && typeof one.id === 'string') foldOwners.set(one.id, owner)
    }
    const text = textOf(stored.message.content)
    if (text.trim() !== '') foldTextOwners.set(rowKey(text), owner)

    return stored
  })

  on('session.append', { door: 'command' }, async ($, e, next) => {
    const stored = await next(e)
    const owner = stored.uuid === undefined || e.agentId !== undefined ? undefined : await foldCurrentPrompt($)
    if (owner !== undefined && stored.uuid !== undefined) foldOwners.set(stored.uuid, owner)

    return stored
  })

  on('session.append', { door: 'notice' }, async ($, e, next) => {
    const stored = await next(e)
    const owner = stored.uuid === undefined || e.agentId !== undefined ? undefined : await foldCurrentPrompt($)
    if (owner !== undefined && stored.uuid !== undefined) foldOwners.set(stored.uuid, owner)

    return stored
  })

  // `/bps fold [n|all|others]`, `/bps unfold [n|all]`, `/bps reading`,
  // `/bps fold-style heading|summary`; anything else goes on to the panel.
  on('command.run', { command: 'bps' }, async ($, e, next) => {
    // Clicks inside the conversation need the fullscreen layout: keep what this
    // terminal reported, to tell "nothing happens on click" apart from a bug.
    await $.store.set(PRESENTATION, e.presentation)
    const [word = '', target = ''] = squash(e.args).toLowerCase().split(' ')
    if (!FOLD_WORDS.includes(word)) return next(e)

    await syncSession($)
    if (word === 'reading') {
      const isOn = !(await read($, readingMode))
      await foldSetReading($, isOn)

      return { text: isOn ? 'Reading mode on: prompts and final answers only.' : 'Reading mode off.' }
    }
    if (word === 'fold-style') {
      if (target !== 'heading' && target !== 'summary') return { text: 'Use /bps fold-style heading or /bps fold-style summary.' }
      await update($, foldStyleSetting, () => target)
      await $.store.set(FOLD_STYLE, target)
      if (target === 'summary') later($, () => foldSummarise($))

      return { text: `Folded chapters now show ${target === 'summary' ? 'a two-line summary' : 'their heading only'}.` }
    }

    const chapters = chapterList(await read($, marks), await read($, prompts))
    const isEverything = word === 'unfold' && (target === '' || target === 'all')
    const ids = isEverything ? await read($, foldedChapters) : foldTargets(target, chapters)
    if (typeof ids === 'string') return { text: ids }

    await foldSet($, ids, word === 'fold')
    const count = `${ids.length} chapter${ids.length === 1 ? '' : 's'}`
    if (isEverything) {
      const topics = await read($, foldedTopics)
      await update($, foldedTopics, () => [])

      return { text: ids.length + topics.length === 0 ? 'Nothing is folded.' : 'Unfolded everything.' }
    }

    return { text: word === 'fold' ? `Folded ${count}.` : `Unfolded ${count}.` }
  })

  // The /bp row in the transcript: a magenta rule so it stands out when scrolling by.
  on('ui.render', { component: 'CommandOutput', props: { command: 'bp' } }, async ($, e, next) => {
    const found = MARK_TEXT.exec(e.props.text)
    if (found === null || e.props.isErrored) return next(e)

    const id = Number(found[1])
    markRows.set(id, e.requestId)

    const { Box, Text, Button } = $.ui.resolve(e)
    if (!(await foldIsShown($, 'command', foldOwnerOf(e.requestId)))) return <Box display="none" />

    const all = await read($, marks)
    const mark = all.find(one => one.id === id && one.kind === 'manual')
    const label = mark?.label ?? squash((found[2] ?? '').replace(/<\/[^>]*>\s*$/, ''))
    const isRemoved = mark?.isRemoved === true
    const width = Math.max(24, (e.viewport?.columns ?? 80) - 2)
    const isFolded = mark !== undefined && !isRemoved && (await read($, foldedChapters)).includes(mark.id)
    const controls = mark !== undefined && !isRemoved && (
      <Box flexDirection="row" gap={1}>
        <Button key="bp-recall" dimColor label={ACTIONS.recall} onPress={() => recallRow($, { kind: 'mark', mark, isNested: false })} />
        <Button key="bp-remove" dimColor label={ACTIONS.remove} onPress={() => foldRemoveMark($, mark.id)} />
      </Box>
    )

    if (isFolded) {
      const said = await read($, prompts)
      const scope = foldView(all, said, [mark.id]).scopes.get(mark.id) ?? []
      const tools = foldToolCount(scope)

      return (
        <Box flexDirection="row" gap={1}>
          <Button key="bp-fold" dimColor label={ACTIONS.unfold} onPress={() => foldSet($, [mark.id], false)} />
          <Text color="magenta" bold wrap="truncate-end">
            {`◆ ${clip(foldedLine(mark, scope.length, tools), Math.max(16, width - 52))}`}
          </Text>
          {controls}
        </Box>
      )
    }

    const body = clip(isRemoved ? `${label} (removed)` : label, Math.max(8, width - 52))
    const rule = '─'.repeat(Math.max(2, width - body.length - 48))

    return (
      <Box flexDirection="row" gap={1}>
        {mark !== undefined && !isRemoved && (
          <Button key="bp-fold" dimColor label={ACTIONS.fold} onPress={() => foldBreakpoint($, mark)} />
        )}
        <Text color="magenta" bold dimColor={isRemoved} wrap="truncate-end">
          {`◆ ${body}`}
        </Text>
        <Text color="magenta" dimColor wrap="truncate-end">
          {rule}
        </Text>
        {controls}
      </Box>
    )
  })

  // Any other command's output belongs to its prompt, and folds with it.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command === 'bp') return next(e)
    if (await foldIsShown($, 'command', foldOwnerOf(e.requestId))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  // A prompt that opens a chapter gets the chapter's title drawn above it,
  // with its controls; a folded chapter draws as that one line.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer' && e.props.origin.kind !== 'bridge') return next(e)

    const key = rowKey(e.props.text)
    promptRows.set(key, e.requestId)

    const all = await read($, marks)
    const said = await read($, prompts)
    const prompt = said.find(one => one.uuid === e.requestId) ?? said.find(one => one.text === key)
    const chapter = all.find(
      one =>
        one.kind === 'auto' &&
        one.isRemoved !== true &&
        (one.anchor === e.requestId || (one.anchorText !== '' && one.anchorText === key)),
    )
    const folded = await read($, foldedChapters)
    const topics = await read($, foldedTopics)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, (e.viewport?.columns ?? 80) - 2)
    let topicLine: RenderElement | undefined

    if (!e.props.isExpanded && prompt !== undefined && (folded.length > 0 || topics.length > 0)) {
      const view = foldView(all, said, folded, topics)
      const opens = view.openers.get(prompt.uuid)

      if (opens !== undefined) {
        const scope = view.scopes.get(opens.id) ?? []
        const tools = foldToolCount(scope)
        const style = await read($, foldStyleSetting)
        const summary = style === 'summary' ? summaryLines(opens.summary ?? '') : []

        return (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Button key="fold-open" dimColor label={ACTIONS.unfold} onPress={() => foldSet($, [opens.id], false)} />
              <Text color="cyan" bold wrap="truncate-end">
                {`◇ ${clip(foldedLine(opens, scope.length, tools), Math.max(16, width - 52))}`}
              </Text>
              <Button
                key="fold-recall"
                dimColor
                label={ACTIONS.recall}
                onPress={() => recallRow($, { kind: 'chapter', mark: opens, isOpen: false, sections: 0 })}
              />
              <Button key="fold-rename" dimColor label={ACTIONS.rename} onPress={() => foldRename($, opens)} />
            </Box>
            {summary.map(line => (
              <Text dimColor wrap="truncate-end">
                {`    ${line}`}
              </Text>
            ))}
            {style === 'summary' && summary.length === 0 && <Text dimColor>    Summing up…</Text>}
          </Box>
        )
      }
      if (view.hidden.has(prompt.uuid) || view.topicHidden.has(prompt.uuid)) return <Box display="none" />

      const scope = view.topics.get(prompt.uuid)
      if (scope !== undefined) {
        const title = prompt.title || clip(prompt.text, 60)
        const answer = [...scope].reverse().find(one => one.answerTitle !== undefined)?.answerTitle

        topicLine = (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" gap={1}>
              <Button key="topic-open" dimColor label={ACTIONS.unfold} onPress={() => foldTopic($, prompt.uuid, false)} />
              <Text bold wrap="truncate-end">
                {`› ${clip(foldedTopicLine(title, scope, foldToolCount(scope)), Math.max(16, width - 36))}`}
              </Text>
              <Button
                key="topic-recall"
                dimColor
                label={ACTIONS.recall}
                onPress={() => recallRow($, { kind: 'section', prompt, title, isNested: false })}
              />
            </Box>
            {answer !== undefined && (
              <Text color="green" dimColor wrap="truncate-end">
                {`    ↳ ${answer}`}
              </Text>
            )}
          </Box>
        )
      }
    }

    // Every sub-topic's prompt gets a Fold button that folds the exchange where it stands.
    const hasArrow = !e.props.isExpanded && prompt !== undefined && opensTopic(prompt, chapter !== undefined)
    const row = async (): Promise<RenderElement> =>
      topicLine ??
      (hasArrow && prompt !== undefined ? (
        <Box flexDirection="row">
          <Button key="topic-fold" dimColor label={ACTIONS.fold} onPress={() => foldTopic($, prompt.uuid, true)} />
          <Box flexDirection="column" flexGrow={1} marginLeft={1}>
            {await next(e)}
          </Box>
        </Box>
      ) : (
        await next(e)
      ))

    if (chapter === undefined) return row()

    const title = clip(chapter.label, Math.max(8, width - 56))
    const heading: RenderElement = (
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button key="fold-close" dimColor label={ACTIONS.fold} onPress={() => foldSet($, [chapter.id], true)} />
        <Text color="cyan" bold wrap="truncate-end">
          {`◇ ${title}`}
        </Text>
        <Text color="cyan" dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(2, width - title.length - 52))}
        </Text>
        <Button
          key="fold-recall"
          dimColor
          label={ACTIONS.recall}
          onPress={() => recallRow($, { kind: 'chapter', mark: chapter, isOpen: true, sections: 0 })}
        />
        <Button key="fold-rename" dimColor label={ACTIONS.rename} onPress={() => foldRename($, chapter)} />
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading}
        {await row()}
      </Box>
    )
  })

  // Claude's text. A final answer gets a Star that keeps it as a breakpoint; in
  // reading mode the text in between goes; in a folded chapter all of it does.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.text === '') return next(e)
    const key = rowKey(e.props.text)
    answerRows.set(key, e.requestId)

    const said = await read($, prompts)
    const answered = said.find(one => one.answer === e.requestId) ?? said.find(one => one.answerText === key)
    const owner = foldOwnerOf(e.requestId, e.props.text) ?? answered?.uuid
    const { Box, Button } = $.ui.resolve(e)
    if (!(await foldIsShown($, 'text', owner, answered !== undefined))) return <Box display="none" />
    if (answered === undefined) return next(e)

    const isStarred = (await read($, marks)).some(
      one => one.kind === 'star' && one.isRemoved !== true && one.after === answered.uuid && (one.anchor === e.requestId || one.anchorText === key),
    )

    const body: RenderElement = (
      <Box flexDirection="column" flexGrow={1}>
        {await next(e)}
        <Box flexDirection="row">
          <Button
            key="star"
            dimColor={!isStarred}
            label={isStarred ? ACTIONS.starred : ACTIONS.star}
            onPress={() => foldToggleStar($, answered, e.requestId, e.props.text)}
          />
        </Box>
      </Box>
    )
    if (!isStarred) return body

    // A starred answer carries a yellow bar down its left edge: a one-column
    // Box with a background, stretched to the answer's whole height.
    return (
      <Box flexDirection="row" alignItems="stretch">
        <Box key="star-bar" width={1} backgroundColor="yellow" />
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          {body}
        </Box>
      </Box>
    )
  })

  // Tool rows: hidden in a folded chapter, and in reading mode once their
  // exchange has its answer.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (await foldIsShown($, 'tool', foldOwnerOf(e.props.tool_use_id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (await foldIsShown($, 'tool', foldOwnerOf(e.props.tool_use_id))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const first = e.props.calls.find(one => one.tool_use_id !== undefined)?.tool_use_id
    const owner = first === undefined ? foldOwnerOf(e.requestId) : foldOwnerOf(first)
    if (await foldIsShown($, 'tool', owner)) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (await foldIsShown($, 'duration', foldOwnerOf(e.requestId))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })
}
