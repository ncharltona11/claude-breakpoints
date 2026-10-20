import { read, update } from 'claude-code'
import type { On, SessionEndInput, TurnCompleteInput } from 'claude-code'

import type { BreakpointPrompt } from '../../types'
import { chapterBefore, clip, isComplete, isSameTitle, labelRequest, parseLabels, repeatedChapters, squash, textOf, withEvents } from '../outline'
import type { FoundAnswer, FoundEvent, Label } from '../outline'
import {
  AUTO,
  BATCH,
  MARK_TEXT,
  OUTLINE_VERSION,
  answerRows,
  askHaiku,
  auto,
  busy,
  enqueue,
  later,
  markRows,
  marks,
  nextId,
  persist,
  promptRows,
  prompts,
  readTranscript,
  rowKey,
  session,
  syncSession,
} from './core'
import type { Dollar } from './core'

export const caughtUp = new Set<string>()

// The last text Claude wrote in the main conversation: at the end of a turn,
// that turn's answer.
let latestAnswer: FoundAnswer | undefined

// A re-read of the transcript for compactions and commands is waiting.
let isEventReadPending = false

// Compactions become breakpoints and slash commands hints, read from the
// transcript file (`events`, when the caller has read it already).
export async function refreshEvents($: Dollar, events?: readonly FoundEvent[]): Promise<void> {
  const id = await read($, session)
  if (id === '') return
  const found = events ?? (await readTranscript($, id)).events
  if (found.length === 0) return

  let isChanged = false
  await update($, marks, list => {
    const next = withEvents(list, found)
    isChanged = next !== list

    return isChanged ? [...next] : list
  })
  if (isChanged) await persist($)
}

// Rows reach the file a moment after they are appended, so the read waits;
// several rows in a row (a command and what it printed) share one read.
export function refreshEventsSoon($: Dollar, delayMs: number): void {
  if (isEventReadPending) return
  isEventReadPending = true
  void $.clock.after(delayMs, () =>
    enqueue($, async () => {
      isEventReadPending = false
      await refreshEvents($)
    }),
  )
}

// Prompts and answers from before the mod was loaded (or in a resumed
// conversation it never saw) are read back from the transcript file, so the
// outline covers the whole conversation. Answers it found, by prompt.
export async function backfill($: Dollar, id: string): Promise<Map<string, string>> {
  const found = await readTranscript($, id)
  if (found.prompts.length === 0) return new Map()

  await update($, prompts, list => {
    const recorded = new Map(list.map(one => [one.uuid, one]))
    const known = new Set(found.prompts.map(one => one.uuid))
    const merged = [
      ...found.prompts.map(one => {
        const answer = found.answers.get(one.uuid)
        const fromFile = answer ? { answer: answer.uuid, answerText: rowKey(answer.text) } : {}

        return { ...fromFile, ...one, ...recorded.get(one.uuid) }
      }),
      ...list.filter(one => !known.has(one.uuid)),
    ]

    return merged.map((one, index) => ({ ...one, n: index + 1 }))
  })
  await persist($)
  await refreshEvents($, found.events)

  return new Map([...found.answers].map(([uuid, answer]) => [uuid, answer.text]))
}

export async function applyLabels(
  $: Dollar,
  batch: readonly BreakpointPrompt[],
  labels: readonly Label[],
  hasNoChapter: boolean,
): Promise<void> {
  const byN = new Map(labels.map(one => [one.n, one]))
  const at = await $.clock.now()
  const opened: { prompt: BreakpointPrompt; label: string }[] = []

  for (const [index, prompt] of batch.entries()) {
    // Titled before, and answered again since: only its answer is summarised anew.
    if (prompt.title !== undefined) continue
    const label = byN.get(prompt.n)
    const section = label?.section ?? clip(prompt.text, 48)
    const chapter = label?.chapter || (hasNoChapter && index === 0 ? section || clip(prompt.text, 40) : '')
    if (chapter !== '') opened.push({ prompt, label: chapter })
  }

  await update($, prompts, list =>
    list.map(one => {
      if (!batch.some(prompt => prompt.uuid === one.uuid)) return one
      const label = byN.get(one.n)
      const title = one.title ?? (label ? label.section : clip(one.text, 48))
      const answer = label?.answer ?? ''

      return { ...one, title, ...(answer === '' ? {} : { answerTitle: answer }), isLabelled: true }
    }),
  )
  const said = await read($, prompts)
  await update($, marks, list => {
    const next = [...list]
    for (const { prompt, label } of opened) {
      if (next.some(one => one.kind === 'auto' && one.anchor === prompt.uuid)) continue
      const current = chapterBefore(next, said, prompt.uuid)
      if (current !== undefined && isSameTitle(current.label, label)) continue
      next.push({ id: nextId(next), kind: 'auto', label, anchor: prompt.uuid, anchorText: prompt.text, after: '', at })
    }

    return next
  })
  await persist($)
}

// Titles a run of exchanges in one call. A reply that skips or merges an
// exchange is not trusted: the run is halved and each half asked again, down
// to one exchange, which a reply cannot misnumber.
export async function labelBatch($: Dollar, batch: readonly BreakpointPrompt[], answers: ReadonlyMap<string, string>): Promise<boolean> {
  const said = await read($, prompts)
  const first = said.findIndex(one => one.uuid === batch[0]?.uuid)
  const before = said.slice(0, Math.max(0, first))
  const chapters = (await read($, marks)).filter(one => one.kind === 'auto' && one.isRemoved !== true)
  const chapter = [...before]
    .reverse()
    .map(one => chapters.find(mark => mark.anchor === one.uuid))
    .find(one => one !== undefined)
  const recent = before.flatMap(one => (one.title ? [one.title] : [])).slice(-3)

  const reply = await askHaiku($, labelRequest(chapter?.label ?? '', recent, batch, answers), 60 * batch.length + 200, 120_000)
  if (reply === null) return false

  const labels = parseLabels(reply).filter(one => batch.some(prompt => prompt.n === one.n))
  if (!isComplete(batch, labels) && batch.length > 1) {
    const half = Math.ceil(batch.length / 2)

    return (await labelBatch($, batch.slice(0, half), answers)) && labelBatch($, batch.slice(half), answers)
  }

  await applyLabels($, batch, labels, chapter === undefined)

  return true
}

// Titles every exchange not yet in the outline: its chapter (new or not), its
// sub-topic (or none, for a follow-up) and a line on what Claude answered.
export async function labelPending($: Dollar, answers: ReadonlyMap<string, string>): Promise<void> {
  if (!(await read($, auto))) return
  const pending = (await read($, prompts)).filter(one => one.isLabelled !== true)
  if (pending.length === 0) return

  if (pending.length > 1) await update($, busy, () => `Outlining ${pending.length} prompts…`)
  try {
    for (let start = 0; start < pending.length; start += BATCH) {
      if (!(await labelBatch($, pending.slice(start, start + BATCH), answers))) return
    }
  } finally {
    await update($, busy, () => '')
  }
}

// Forgets every title and chapter the model gave, so the next labelling
// redoes the whole outline. Your own /bp marks stay.
export async function resetOutline($: Dollar): Promise<void> {
  await update($, prompts, list =>
    list.map(({ title, answerTitle, isLabelled, ...rest }) => rest),
  )
  await update($, marks, list => list.filter(one => one.kind !== 'auto'))
  await persist($)
}

export async function catchUp($: Dollar): Promise<void> {
  const id = await $.session.id()
  if (caughtUp.has(id)) return
  caughtUp.add(id)

  const answers = await backfill($, id)

  // Chapters found before outlines existed, or by an older way of labelling,
  // are redone.
  const version = Number((await $.store.get(`v:${id}`)) ?? 0)
  const said = await read($, prompts)
  if (version < OUTLINE_VERSION || !said.some(one => one.isLabelled === true)) {
    await resetOutline($)
    await $.store.set(`v:${id}`, OUTLINE_VERSION)
  }

  // An answer that arrived after its exchange was titled has no summary yet.
  await update($, prompts, list =>
    list.map(one => {
      if (one.isLabelled !== true || one.answer === undefined || one.answerTitle !== undefined) return one
      const { isLabelled, ...rest } = one

      return rest
    }),
  )

  const repeated = repeatedChapters(await read($, marks), await read($, prompts))
  if (repeated.length > 0) {
    await update($, marks, list => list.map(one => (repeated.includes(one.id) ? { ...one, isRemoved: true } : one)))
    await persist($)
  }
  await labelPending($, answers)
}

// The end of a turn: the prompt that started it gets its answer, and anything
// not yet in the outline is titled.
export async function afterTurn($: Dollar, answer: FoundAnswer | undefined): Promise<void> {
  await syncSession($)
  const latest = (await read($, prompts)).at(-1)
  if (latest === undefined) return

  if (answer !== undefined && answer.uuid !== latest.answer) {
    await update($, prompts, list =>
      list.map(one => {
        if (one.uuid !== latest.uuid) return one
        // A later turn (a background task's report) answered again: the old
        // summary no longer describes it, so the answer is summarised again.
        // The title and chapter stay.
        const { answerTitle, isLabelled, ...rest } = one

        return { ...rest, answer: answer.uuid, answerText: rowKey(answer.text) }
      }),
    )
    await persist($)
  }

  await refreshEvents($)
  await labelPending($, new Map(answer ? [[latest.uuid, answer.text]] : []))
}

// The conversation in view changed (the first sync, a /clear, a /resume).
export function trackingOnSwitch($: Dollar): void {
  latestAnswer = undefined
  later($, () => catchUp($))
}

export async function trackingOnStart($: Dollar): Promise<void> {
  const stored = await $.store.get(AUTO)
  await update($, auto, () => stored !== false)
  await syncSession($)
  later($, () => catchUp($))
}

export function trackingOnEnd($: Dollar, e: SessionEndInput): void {
  if (e.reason === 'clear' || e.reason === 'resume') {
    markRows.clear()
    promptRows.clear()
    answerRows.clear()
    void $.clock.after(1000, () => syncSession($))
  }
}

export function trackingOnTurn($: Dollar, e: TurnCompleteInput): void {
  if (e.agentId === undefined && e.reason === 'answer') {
    const answer = latestAnswer
    later($, () => afterTurn($, answer))
  }
}

export const registerTracking = (on: On) => {
  // Every prompt the person sends is a stop in the outline.
  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const stored = await next(e)
    const isPersons = e.origin.kind === 'composer' || e.origin.kind === 'bridge'

    if (stored.uuid === undefined || e.agentId !== undefined || e.message.isMeta === true || !isPersons) {
      return stored
    }

    try {
      await syncSession($)
      latestAnswer = undefined
      const uuid = stored.uuid
      const text = rowKey(textOf(stored.message.content)) || '(no text)'
      const at = await $.clock.now()
      await update($, prompts, list =>
        list.some(one => one.uuid === uuid) ? list : [...list, { uuid, text, at, n: (list.at(-1)?.n ?? 0) + 1 }],
      )
      await persist($)
    } catch (error) {
      $.ui.log(`breakpoints: could not record a prompt: ${String(error)}`, { to: 'debug' })
    }

    return stored
  })

  // Claude's text in the main conversation; the last of a turn is its answer.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    const text = stored.uuid === undefined ? '' : squash(textOf(stored.message.content))

    if (stored.uuid !== undefined && e.agentId === undefined && text !== '') {
      latestAnswer = { uuid: stored.uuid, text }
    }

    return stored
  })

  // The /bp output row is the breakpoint's anchor: keep the id it was stored
  // under. Any other command is a hint in the outline, read from the file.
  on('session.append', { door: 'command' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId === undefined) refreshEventsSoon($, 1500)
    const found = stored.uuid === undefined ? null : MARK_TEXT.exec(textOf(stored.message.content))

    if (found === null || stored.uuid === undefined || e.agentId !== undefined) {
      return stored
    }

    try {
      const id = Number(found[1])
      const uuid = stored.uuid
      await update($, marks, list =>
        list.map(one => (one.id === id && one.kind === 'manual' && one.anchor === '' ? { ...one, anchor: uuid } : one)),
      )
      await persist($)
    } catch (error) {
      $.ui.log(`breakpoints: could not anchor a breakpoint: ${String(error)}`, { to: 'debug' })
    }

    return stored
  })
}
