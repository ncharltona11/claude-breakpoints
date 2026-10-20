// manual: a /bp row (anchor: that row). auto: a chapter (anchor: the prompt it
// opens). star: an answer starred in the transcript (anchor: the answer row,
// anchorText: its rowKey, after: the prompt it answers). compact: a compaction
// (anchor: its boundary row, after: the last prompt before it). command: a
// slash command, a hint in the outline only (anchor: its echo row, after: the
// last prompt before it). The last two are read from the transcript file.
export type BreakpointMark = {
  id: number
  kind: 'manual' | 'auto' | 'star' | 'compact' | 'command'
  label: string
  anchor: string
  anchorText: string
  after: string
  at: number
  isRemoved?: boolean
  // A chapter renamed by hand: relabelling leaves its label alone.
  isRenamed?: boolean
  // A chapter's two-line summary, for folding to a summary in the transcript.
  summary?: string
}

export type BreakpointPrompt = {
  uuid: string
  text: string
  at: number
  n: number
  title?: string
  answer?: string
  answerText?: string
  answerTitle?: string
  isLabelled?: boolean
  // What the exchange cost: wall-clock time of its turn(s), tokens and dollars.
  durationMs?: number
  tokens?: number
  costUsd?: number
}

export type BreakpointTab = 'outline' | 'marks'

export type BreakpointFoldStyle = 'heading' | 'summary'

// One match from searching past conversations: what matched (a chapter or
// sub-topic title, a breakpoint, a prompt or a final answer), the prompt it
// belongs to (uuid), and the conversation it is in.
export type BreakpointSearchHit = {
  sessionId: string
  project: string
  chapter: string
  text: string
  at: number
  kind: 'chapter' | 'topic' | 'mark' | 'prompt' | 'answer'
  uuid: string
  title: string
  cwd: string
}

export type BreakpointRecall = {
  key: string
  glyph: string
  label: string
  what: string
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    breakpoints: {
      session: string
      marks: BreakpointMark[]
      prompts: BreakpointPrompt[]
      tab: BreakpointTab
      filter: string
      lastJump: string
      auto: boolean
      busy: string
      toggled: number[]
      recall: BreakpointRecall[]
      isRecalling: boolean
      // Transcript folding: chapter ids folded in the conversation itself,
      // how a folded chapter draws, and reading mode (prompts and final
      // answers only, everywhere).
      folded: number[]
      // Sub-topics folded in the conversation: the uuid of each one's prompt.
      foldedTopics: string[]
      foldStyle: BreakpointFoldStyle
      isReading: boolean
      // Which prompt every transcript row belongs to: row id (a message uuid
      // or a tool_use_id) to prompt uuid.
      owners: Record<string, string>
      // Editing chapters in the panel: edit mode, and the chapter being renamed.
      isEditing: boolean
      renaming: number
      // Searching past conversations.
      searchQuery: string
      searchHits: BreakpointSearchHit[]
      isSearching: boolean
      // What the last search covered, or why it stopped short.
      searchNote: string
    }
  }
}
