import type { BreakpointMark, BreakpointPrompt } from '../types'
import { chapterScope, clip, sectionScope } from './outline'

export type StatsTotal = { durationMs: number; tokens: number; costUsd?: number }

type StatsUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Every token a turn's requests processed, cache reads included.
export const usageTokens = (usage: StatsUsage | undefined) =>
  usage === undefined
    ? 0
    : usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

export function statsTotal(said: readonly BreakpointPrompt[]): StatsTotal {
  const durationMs = said.reduce((sum, one) => sum + (one.durationMs ?? 0), 0)
  const tokens = said.reduce((sum, one) => sum + (one.tokens ?? 0), 0)
  const priced = said.filter(one => one.costUsd !== undefined)
  const costUsd = priced.length === 0 ? undefined : priced.reduce((sum, one) => sum + (one.costUsd ?? 0), 0)

  return costUsd === undefined ? { durationMs, tokens } : { durationMs, tokens, costUsd }
}

export const chapterTotal = (mark: BreakpointMark, all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]) =>
  statsTotal(chapterScope(mark, all, said))

export const sectionTotal = (prompt: BreakpointPrompt, all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]) =>
  statsTotal(sectionScope(prompt, all, said))

// Durations read "25 min" so they never look like the "25m ago" beside them.
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`

  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01'

  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tok`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k tok`

  return `${(tokens / 1_000_000).toFixed(1)}M tok`
}

// "$0.80 · 25 min": dollars where the session priced them, tokens otherwise;
// empty when the exchanges have no figures yet (sent before stats existed).
export function formatStats(total: StatsTotal): string {
  if (total.durationMs === 0 && total.tokens === 0 && total.costUsd === undefined) return ''
  const spent = total.costUsd !== undefined ? formatCost(total.costUsd) : total.tokens > 0 ? formatTokens(total.tokens) : ''

  return [spent, total.durationMs > 0 ? formatDuration(total.durationMs) : ''].filter(Boolean).join(' · ')
}

// The chapter the conversation is in now: the one opened latest.
export function currentChapter(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): BreakpointMark | undefined {
  const index = new Map(said.map((one, at) => [one.uuid, at]))

  return all
    .filter(one => one.kind === 'auto' && one.isRemoved !== true && index.has(one.anchor))
    .sort((a, b) => (index.get(a.anchor) ?? 0) - (index.get(b.anchor) ?? 0))
    .at(-1)
}

export function statusText(all: readonly BreakpointMark[], said: readonly BreakpointPrompt[]): string | undefined {
  const chapter = currentChapter(all, said)

  return chapter === undefined ? undefined : `◇ ${clip(chapter.label, 50)}`
}
