import { atom, read, update } from 'claude-code'
import type { On, PromptSubmitInput, PromptSubmitResult, RenderElement } from 'claude-code'

import type { BreakpointMark, BreakpointPrompt } from '../../types'
import { MARK_COLOR, MARK_GLYPH, buildOutline, clip, filterOutline, orderedMarks, squash } from '../outline'
import type { OutlineRow } from '../outline'
import { chapterTotal, currentChapter, formatStats, sectionTotal } from '../stats-lib'
import {
  AUTO,
  PANE,
  TITLE,
  ago,
  auto,
  busy,
  enqueue,
  filter,
  isRecalling,
  jumpToAnswer,
  jumpToMark,
  jumpToPrompt,
  lastJump,
  later,
  marks,
  nextId,
  persist,
  prompts,
  recall,
  recallRow,
  session,
  syncSession,
  tab,
  toggled,
} from './core'
import { statsRefreshStatus } from './stats'
import { catchUp, caughtUp, labelPending, resetOutline } from './tracking'
import type { Dollar } from './core'

let paneOverflows = false

// The panel's keyboard toggle. A mod cannot add a keybinding action of its
// own; a Button can stand in for an engine action instead, and the person's
// key for that action presses it while it is drawn. This one only does
// anything in the diff panel, so outside it the key is free for ours.
// keybindings.json binds it (Global): "ctrl+x o": "app:toggleDiffNoiseFilter".
const PANE_TOGGLE_ACTION = 'app:toggleDiffNoiseFilter'
const PANE_TOGGLE_KEY = 'ctrl+x o'

const paneIsEditing = atom({ plugin: 'breakpoints', key: 'isEditing' } as const, false)
const paneRenaming = atom({ plugin: 'breakpoints', key: 'renaming' } as const, 0)

// Below this the panel drops the time and cost figures to keep the titles.
const PANE_STATS_WIDTH = 56

// Edit mode: a chapter renamed by hand keeps its name when labelling runs.
async function paneRename($: Dollar, id: number, value: string): Promise<void> {
  const label = clip(squash(value), 60)
  if (label !== '') {
    await update($, marks, list => list.map(one => (one.id === id ? { ...one, label, isRenamed: true } : one)))
    await persist($)
  }
  await update($, paneRenaming, () => 0)
  await statsRefreshStatus($)
}

// Merging a chapter takes its heading away: its exchanges join the chapter above.
async function paneMerge($: Dollar, id: number): Promise<void> {
  await update($, marks, list => list.map(one => (one.id === id ? { ...one, isRemoved: true } : one)))
  await persist($)
  await statsRefreshStatus($)
}

// A sub-topic becomes the first of a new chapter, named after it, and starts
// open. A heading merged away earlier at the same prompt is brought back
// rather than doubled.
async function paneSplit($: Dollar, prompt: BreakpointPrompt, title: string): Promise<void> {
  const at = await $.clock.now()
  let id = 0
  await update($, marks, list => {
    const earlier = list.find(one => one.kind === 'auto' && one.anchor === prompt.uuid)
    id = earlier?.id ?? nextId(list)
    if (earlier !== undefined) {
      return list.map(one => (one === earlier ? { ...one, label: title, isRenamed: true, isRemoved: false } : one))
    }
    const chapter: BreakpointMark = {
      id,
      kind: 'auto',
      label: title,
      anchor: prompt.uuid,
      anchorText: prompt.text,
      after: '',
      at,
      isRenamed: true,
    }

    return [...list, chapter]
  })
  // Only the last chapter starts open, and `toggled` flips the rest.
  const isLast = currentChapter(await read($, marks), await read($, prompts))?.id === id
  await update($, toggled, list => [...list.filter(one => one !== id), ...(isLast ? [] : [id])])
  await persist($)
  await statsRefreshStatus($)
}

export async function paneOnStart($: Dollar): Promise<void> {
  await $.command.register({
    name: 'bp',
    description: 'Set a breakpoint at this point of the conversation',
    argumentHint: '[label]',
  })
  await $.command.register({
    name: 'bps',
    description: 'Outline of this conversation: jump, recall, fold, search past conversations, export',
    argumentHint: '[n | filter | search … | export … | fold … | unfold … | reading | redo]',
    immediate: true,
  })
}

// What was recalled rides along with the person's next message, unseen.
export async function paneOnSubmit(
  $: Dollar,
  e: PromptSubmitInput,
  next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>,
): Promise<PromptSubmitResult> {
  const isPersons = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
  const pinned = isPersons && !e.text.trimStart().startsWith('/') ? await read($, recall) : []
  if (pinned.length === 0) return next(e)

  const entered = await next({ ...e, context: [...(e.context ?? []), ...pinned.map(one => one.text)] })
  if (entered.drop === undefined) await update($, recall, () => [])

  return entered
}

// Opens the panel, or closes it when it is up: the hint line's Outline
// button and the toggle key.
export async function paneToggle($: Dollar): Promise<void> {
  if ((await $.ui.panes()).some(one => one.id === PANE)) {
    await $.ui.close({ id: PANE })

    return
  }
  await syncSession($)
  await update($, filter, () => '')
  await update($, isRecalling, () => false)
  await update($, paneRenaming, () => 0)
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

export const registerPane = (on: On) => {
  // The hint line under the prompt is always on screen: it carries the
  // Outline button, which the toggle key presses too.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1}>{await next(e)}</Box>
        <Button key="bps-toggle" dimColor label="◇ Outline" action={PANE_TOGGLE_ACTION} onPress={() => paneToggle($)} />
      </Box>
    )
  })

  on('command.run', { command: 'bp' }, async ($, e) => {
    await syncSession($)
    const all = await read($, marks)
    const latest = (await read($, prompts)).at(-1)
    const id = nextId(all)
    const label = clip(squash(e.args), 80) || (latest ? clip(latest.title || latest.text, 60) : `Breakpoint ${id}`)
    const mark: BreakpointMark = {
      id,
      kind: 'manual',
      label,
      anchor: '',
      anchorText: '',
      after: latest?.uuid ?? '',
      at: await $.clock.now(),
    }

    await update($, marks, list => [...list, mark])
    await persist($)

    return { text: `◆ Breakpoint ${id} · ${label}` }
  })

  on('command.run', { command: 'bps' }, async ($, e) => {
    await syncSession($)

    later($, () => catchUp($))
    const args = squash(e.args)
    const isNumber = /^\d+$/.test(args)

    if (args === 'redo') {
      await resetOutline($)
      caughtUp.delete(await read($, session))
      later($, () => catchUp($))
      $.ui.toast('Redoing the outline of this conversation…')
    }

    if (isNumber) {
      // Command hints are not numbered: they live in the outline only.
      const live = (await read($, marks)).filter(one => one.isRemoved !== true && one.kind !== 'command')
      const mark = orderedMarks(live, await read($, prompts))[Number(args) - 1]

      if (mark !== undefined) {
        await jumpToMark($, mark, e.presentation.isFullscreen)

        return {}
      }
      $.ui.toast(`There is no entry ${args} in the breakpoints list.`)
    }

    await update($, filter, () => (isNumber || args === 'redo' ? '' : args))
    await update($, isRecalling, () => false)
    await update($, paneRenaming, () => 0)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })

    if (!opened.isPlaced) {
      $.ui.toast(`The breakpoints list is waiting for room: ${opened.reason}`)
    } else if (paneOverflows && (await read($, tab)) !== 'marks') {
      await $.ui.scroll({ in: PANE, to: 'end' })
    }

    return {}
  })


  // What will ride along with the next message, above the prompt box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const pinned = await read($, recall)
    if (pinned.length === 0 || e.props.hasSurvey) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const size = pinned.reduce((sum, one) => sum + one.text.length, 0)
    const names = pinned.map(one => `${one.glyph} ${one.label} (${one.what})`).join(' · ')

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="green" bold>
          ↩ Recalled for your next message:
        </Text>
        <Text wrap="truncate-end">{names}</Text>
        <Text dimColor>{`${Math.max(1, Math.round(size / 1000))}k chars`}</Text>
        <Box flexGrow={1} />
        <Button key="recall-drop" plain dimColor label="✕ drop" onPress={() => update($, recall, () => [])} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const said = await read($, prompts)
    const all = (await read($, marks)).filter(one => one.isRemoved !== true)
    const listed = orderedMarks(
      all.filter(one => one.kind !== 'command'),
      said,
    )
    const current = (await read($, tab)) === 'marks' ? 'marks' : 'outline'
    const query = (await read($, filter)).toLowerCase()
    const folded = await read($, toggled)
    const last = await read($, lastJump)
    const isAuto = await read($, auto)
    const working = await read($, busy)
    const picking = await read($, isRecalling)
    const editing = await read($, paneIsEditing)
    const renaming = await read($, paneRenaming)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const hasStats = width >= PANE_STATS_WIDTH
    const isFullscreen = e.viewport?.isFullscreen
    const position = new Map(listed.map((mark, at) => [mark.id, at + 1]))
    const firstChapter = listed.find(one => one.kind === 'auto')
    const chapterAnchors = new Set(all.filter(one => one.kind === 'auto').map(one => one.anchor))

    const rows: OutlineRow[] =
      current === 'outline'
        ? query === ''
          ? buildOutline(all, said, folded)
          : filterOutline(all, said, query)
        : listed
            .filter(one => query === '' || one.label.toLowerCase().includes(query))
            .map(mark => ({ kind: 'mark' as const, mark, isNested: false }))
    paneOverflows = rows.length + 6 > e.props.scroll.bodyRows

    const line = (
      key: string,
      jumpKey: string,
      indent: number,
      glyph: string,
      color: string,
      label: string,
      age: string,
      onPress: () => void,
      extra: {
        hotkey?: string
        isDim?: boolean
        stats?: string
        lead?: RenderElement
        tail?: RenderElement
        tailWidth?: number
      } = {},
    ) => {
      const stats = hasStats ? (extra.stats ?? '') : ''
      const room = width - indent - age.length - (stats === '' ? 0 : stats.length + 3) - (extra.tailWidth ?? 0) - 10

      return (
        <Box key={`row-${key}`} flexDirection="row">
          <Text color={color}>
            {last === jumpKey ? '▸' : ' '}
            {' '.repeat(indent)}
          </Text>
          {extra.lead}
          <Text color={color}>{glyph} </Text>
          <Button
            key={key}
            plain
            {...(extra.isDim === true ? { dimColor: true } : {})}
            {...(extra.hotkey !== undefined ? { hotkey: extra.hotkey } : {})}
            label={clip(label, Math.max(8, room))}
            onPress={onPress}
          />
          <Box flexGrow={1} />
          {stats !== '' && <Text dimColor> {stats} ·</Text>}
          <Text dimColor> {age}</Text>
          {extra.tail}
        </Box>
      )
    }

    const removeButton = (mark: BreakpointMark) => (
      <Button
        key={`del-${mark.id}`}
        plain
        dimColor
        label=" ✕"
        onPress={async () => {
          await update($, marks, list => list.map(one => (one.id === mark.id ? { ...one, isRemoved: true } : one)))
          await persist($)
        }}
      />
    )

    // Edit mode on a chapter: rename it, or take its heading away. The first
    // chapter has none above to merge into, so its heading is just removed.
    const chapterTools = (mark: BreakpointMark) => (
      <Box key={`tools-${mark.id}`} flexDirection="row">
        <Button key={`rename-${mark.id}`} plain dimColor label=" rename" onPress={() => update($, paneRenaming, () => mark.id)} />
        <Button
          key={`merge-${mark.id}`}
          plain
          dimColor
          label={mark.id === firstChapter?.id ? ' ✕' : ' merge ↑'}
          onPress={() => paneMerge($, mark.id)}
        />
      </Box>
    )

    const renameRow = (mark: BreakpointMark) =>
      Input === undefined ? undefined : (
        <Box key={`row-rename-${mark.id}`} flexDirection="row">
          <Text color="cyan">  ◇ </Text>
          <Input key="rename" value={mark.label} submitLabel="Save" autoFocus onSubmit={value => paneRename($, mark.id, value)} />
          <Button key="rename-cancel" plain dimColor label=" cancel" onPress={() => update($, paneRenaming, () => 0)} />
        </Box>
      )

    const drawRow = (row: OutlineRow) => {
      if (row.kind === 'chapter') {
        const id = row.mark.id
        if (renaming === id && Input !== undefined) return renameRow(row.mark)

        const fold = (
          <Button
            key={`fold-${id}`}
            plain
            dimColor
            label={row.isOpen ? '▾' : '▸'}
            onPress={() => update($, toggled, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))}
          />
        )
        const count = row.isOpen || row.sections === 0 ? '' : ` (${row.sections})`

        return line(
          `c-${id}`,
          `mark:${id}`,
          0,
          ' ◇',
          'cyan',
          `${row.mark.label}${count}`,
          ago(now - row.mark.at),
          () => (picking ? recallRow($, row) : jumpToMark($, row.mark, isFullscreen)),
          {
            lead: fold,
            stats: formatStats(chapterTotal(row.mark, all, said)),
            ...(editing ? { tail: chapterTools(row.mark), tailWidth: 16 } : {}),
          },
        )
      }
      if (row.kind === 'section') {
        const canSplit = editing && !chapterAnchors.has(row.prompt.uuid)

        return line(
          `s-${row.prompt.n}`,
          `prompt:${row.prompt.uuid}`,
          row.isNested ? 3 : 0,
          '›',
          'white',
          row.title,
          ago(now - row.prompt.at),
          () => (picking ? recallRow($, row) : jumpToPrompt($, row.prompt, isFullscreen)),
          {
            isDim: row.prompt.isLabelled !== true,
            stats: formatStats(sectionTotal(row.prompt, all, said)),
            ...(canSplit
              ? {
                  tail: (
                    <Button
                      key={`split-${row.prompt.n}`}
                      plain
                      dimColor
                      label=" split here"
                      onPress={() => paneSplit($, row.prompt, row.title)}
                    />
                  ),
                  tailWidth: 11,
                }
              : {}),
          },
        )
      }
      if (row.kind === 'answer') {
        return line(
          `a-${row.prompt.n}`,
          `answer:${row.prompt.uuid}`,
          row.isNested ? 5 : 2,
          '↳',
          'green',
          row.title,
          '',
          () => (picking ? recallRow($, row) : jumpToAnswer($, row.prompt, isFullscreen)),
          { isDim: true },
        )
      }

      if (row.mark.kind === 'auto' && renaming === row.mark.id && Input !== undefined) return renameRow(row.mark)

      const number = position.get(row.mark.id) ?? 0
      const isFlat = current === 'marks'
      const hasHotkey = isFlat && number >= 1 && number <= 9
      const isStar = row.mark.kind === 'star'
      // A star sits under the answer it stars.
      const indent = isFlat ? 0 : isStar ? (row.isNested ? 7 : 4) : row.isNested ? 3 : 0

      return line(
        `m-${row.mark.id}`,
        `mark:${row.mark.id}`,
        indent,
        MARK_GLYPH[row.mark.kind],
        MARK_COLOR[row.mark.kind],
        isFlat && !hasHotkey ? `${number}: ${row.mark.label}` : row.mark.label,
        ago(now - row.mark.at),
        () => (picking ? recallRow($, row) : jumpToMark($, row.mark, isFullscreen)),
        {
          ...(hasHotkey ? { hotkey: String(number) } : {}),
          ...(row.mark.kind === 'command' ? { isDim: true } : {}),
          tail: removeButton(row.mark),
          tailWidth: 2,
        },
      )
    }

    const empty =
      query !== ''
        ? `Nothing matches "${query}".`
        : current === 'marks'
          ? 'No breakpoints yet. Type /bp to mark the latest point, or /bp <label> to name it.'
          : 'Nothing in this conversation yet.'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button
            key="tab-outline"
            hotkey="o"
            variant={current === 'outline' ? 'primary' : 'secondary'}
            label="Outline"
            onPress={async () => {
              await update($, tab, () => 'outline')
              if (paneOverflows) await $.ui.scroll({ in: PANE, to: 'end' })
            }}
          />
          <Button
            key="tab-marks"
            hotkey="b"
            variant={current === 'marks' ? 'primary' : 'secondary'}
            label={`Breakpoints ${listed.length}`}
            onPress={() => update($, tab, () => 'marks')}
          />
          {current === 'outline' && (
            <Button
              key="fold-all"
              hotkey="f"
              dimColor
              label="Fold all"
              onPress={() =>
                update($, toggled, () => {
                  const chapters = buildOutline(all, said, [], true).flatMap(row => (row.kind === 'chapter' ? [row.mark.id] : []))
                  const lastChapter = chapters.at(-1)

                  return lastChapter === undefined ? [] : [lastChapter]
                })
              }
            />
          )}
          <Button
            key="recall-mode"
            hotkey="r"
            variant={picking ? 'primary' : 'secondary'}
            label={picking ? 'Recall: pick one' : 'Recall'}
            onPress={() => update($, isRecalling, value => !value)}
          />
          <Button
            key="edit-mode"
            hotkey="e"
            variant={editing ? 'primary' : 'secondary'}
            label="Edit"
            onPress={async () => {
              await update($, paneIsEditing, value => !value)
              await update($, paneRenaming, () => 0)
            }}
          />
          <Button
            key="auto"
            hotkey="a"
            dimColor={!isAuto}
            label={`Auto ${isAuto ? 'on' : 'off'}`}
            onPress={async () => {
              const isOn = await update($, auto, value => !value)
              await $.store.set(AUTO, isOn)
              await statsRefreshStatus($)
              if (isOn) enqueue($, () => labelPending($, new Map()))
            }}
          />
          {query !== '' && (
            <Button
              key="clear-filter"
              hotkey="x"
              dimColor
              label={`× ${clip(query, 16)}`}
              onPress={() => update($, filter, () => '')}
            />
          )}
          <Box flexGrow={1} />
          <Button
            key="close"
            role="dismiss"
            hotkey="q"
            dimColor
            label="Close"
            action={PANE_TOGGLE_ACTION}
            onPress={() => $.ui.close({ id: PANE })}
          />
        </Box>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(width)}
        </Text>
        {picking && (
          <Text color="green" wrap="wrap">
            ↩ Pick what to bring back: it rides along, word for word, with your next message. r cancels.
          </Text>
        )}
        {editing && (
          <Text color="cyan" wrap="wrap">
            ✎ Rename or merge a chapter, or split one at a sub-topic. e ends.
          </Text>
        )}
        {working !== '' && <Text color="cyan">◇ {working}</Text>}
        {rows.length === 0 && <Text dimColor>{empty}</Text>}
        {rows.map(drawRow)}
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(width)}
        </Text>
        <Text dimColor wrap="truncate-end">
          {`◇ chapter · › sub-topic · ↳ answer · ☆ starred · ◆ your /bp · ⇊ compacted · ⌘ command · Enter jumps · r recalls · e edits · Esc or ${PANE_TOGGLE_KEY} closes`}
        </Text>
      </Box>
    )
  })
}
