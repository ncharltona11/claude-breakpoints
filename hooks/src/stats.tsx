import { read, update } from 'claude-code'
import type { On, TurnCompleteInput, TurnUsage } from 'claude-code'

import { statusText, usageTokens } from '../stats-lib'
import { auto, marks, persist, prompts } from './core'
import type { Dollar } from './core'

const STATS_STATUS_EVERY = 5000

// The session's running total at the last turn's end, and the status line as
// last drawn. Module memory: after a reload the next turn starts the reading
// again, and the status is drawn afresh.
let statsLastUsd: number | undefined
let statsShownStatus: string | undefined

// Time and cost per exchange and chapter; the current chapter in the status line.
export const registerStats = (on: On) => {
  void on
}

export async function statsOnStart($: Dollar): Promise<void> {
  statsShownStatus = undefined
  await statsRefreshStatus($)
  // Chapters change when labelling lands a few seconds after a turn, on a
  // /resume or from the panel; a light poll keeps the line honest.
  void $.clock.every(STATS_STATUS_EVERY, () => void statsRefreshStatus($))
}

export function statsOnTurn($: Dollar, e: TurnCompleteInput): void {
  if (e.agentId !== undefined) return
  const { durationMs, usage } = e
  void $.clock.after(10, () => void statsRecordTurn($, durationMs, usage))
}

export async function statsRefreshStatus($: Dollar): Promise<void> {
  const text = (await read($, auto)) ? statusText(await read($, marks), await read($, prompts)) : undefined
  if (text === statsShownStatus) return

  statsShownStatus = text
  $.ui.status(text)
}

// Dollars the session spent since the previous turn ended. Before the first
// reading there is nothing to subtract from: on the session's first prompt
// that is $0, otherwise (a resumed session, a reload) the turn goes unpriced.
async function statsSpentSince($: Dollar): Promise<number | undefined> {
  const usd = (await $.session.usage()).cost?.usd
  if (usd === undefined) return undefined

  const before = statsLastUsd ?? ((await $.session.turns()) <= 1 ? 0 : undefined)
  statsLastUsd = usd
  if (before === undefined) return undefined

  // A /clear starts the ledger over.
  return usd >= before ? usd - before : usd
}

// What the turn took goes on the prompt it answered; several turns answering
// one prompt (a background task's report) add up.
async function statsRecordTurn($: Dollar, durationMs: number, usage: TurnUsage | undefined): Promise<void> {
  const latest = (await read($, prompts)).at(-1)
  if (latest === undefined) return

  const spent = await statsSpentSince($)
  const tokens = usageTokens(usage)

  await update($, prompts, list =>
    list.map(one =>
      one.uuid !== latest.uuid
        ? one
        : {
            ...one,
            durationMs: (one.durationMs ?? 0) + durationMs,
            tokens: (one.tokens ?? 0) + tokens,
            ...(spent === undefined ? {} : { costUsd: (one.costUsd ?? 0) + spent }),
          },
    ),
  )
  await persist($)
}
