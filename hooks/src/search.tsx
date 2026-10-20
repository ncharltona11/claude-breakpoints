import { atom, read, update } from 'claude-code'
import type { FsEntry, On, RenderSurface } from 'claude-code'

import type { BreakpointSearchHit } from '../../types'
import { clip, squash } from '../outline'
import {
  SEARCH_SCRIPT,
  parseSearchOutput,
  searchDate,
  searchHits,
  searchPrefilter,
  searchSessionOf,
  searchWords,
} from '../search-lib'
import type { SearchFile, SearchSaved } from '../search-lib'
import { SESSIONS, jumpToAnswer, jumpToPrompt, marks, prompts, session, syncSession } from './core'
import type { Dollar } from './core'

const SEARCH_PANE = 'bp-search'
// A search reads about 40 MB a second of transcript: the newest files that
// fit both limits are searched, the rest named in the note.
const SEARCH_FILES = 150
const SEARCH_BYTES = 600_000_000
const SEARCH_ROOM = 160
const SEARCH_GLYPH: Record<BreakpointSearchHit['kind'], string> = {
  chapter: '◇',
  topic: '›',
  mark: '◆',
  prompt: '>',
  answer: '↳',
}

const searchQuery = atom({ plugin: 'breakpoints', key: 'searchQuery' } as const, '')
const searchFound = atom({ plugin: 'breakpoints', key: 'searchHits' } as const, [])
const searchBusy = atom({ plugin: 'breakpoints', key: 'isSearching' } as const, false)
const searchNote = atom({ plugin: 'breakpoints', key: 'searchNote' } as const, '')

// The folder Claude Code keeps every project's transcripts in.
async function searchProjectsDir($: Dollar): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')

  return `${(configured ?? `${home}/.claude`).replace(/^~/, home).replace(/\/$/, '')}/projects`
}

// This project's transcript folders: the start directory's, and the working
// directory's when it differs, each with every non-alphanumeric as "-".
async function searchHereDirs($: Dollar): Promise<string[]> {
  const projects = await searchProjectsDir($)
  const dirs = new Set([await $.session.root(), await $.session.cwd()].map(dir => `${projects}/${dir.replace(/[^A-Za-z0-9]/g, '-')}`))
  const found: string[] = []
  for (const dir of dirs) {
    if (await $.fs.exists(dir)) found.push(dir)
  }

  return found
}

async function searchAllDirs($: Dollar): Promise<string[]> {
  const projects = await searchProjectsDir($)
  let entries: FsEntry[] = []
  try {
    entries = await $.fs.list(projects)
  } catch {
    return []
  }

  return entries.filter(one => one.kind === 'dir').map(one => `${projects}/${one.name}`)
}

// Transcript files in the folders, newest first.
async function searchListFiles($: Dollar, dirs: readonly string[]): Promise<{ path: string; mtime: number; size: number }[]> {
  const files: { path: string; mtime: number; size: number }[] = []
  for (const dir of dirs) {
    let entries: FsEntry[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const one of entries) {
      if (one.kind === 'file' && one.name.endsWith('.jsonl')) {
        files.push({ path: `${dir}/${one.name}`, mtime: one.mtimeMs, size: one.size })
      }
    }
  }

  return files.sort((a, b) => b.mtime - a.mtime)
}

async function searchRun($: Dollar, query: string, isAll: boolean): Promise<void> {
  const words = searchWords(query)
  const word = searchPrefilter(words)
  const current = await $.session.id()
  const root = await $.session.root()
  const hereDirs = await searchHereDirs($)
  const everyFile = await searchListFiles($, isAll ? await searchAllDirs($) : hereDirs)
  let bytes = 0
  const files = everyFile.slice(0, SEARCH_FILES).filter(one => {
    bytes += one.size

    return bytes <= SEARCH_BYTES || one === everyFile[0]
  })
  const isHere = (path: string) => hereDirs.some(dir => path.startsWith(`${dir}/`))

  let found: SearchFile[] = []
  let isCut = false
  if (word !== '' && files.length > 0) {
    const run = await $.process.run(['sh', '-c', SEARCH_SCRIPT, 'sh', word, ...files.map(one => one.path)], { timeoutMs: 60_000 })
    found = parseSearchOutput(run.stdout)
    isCut = run.isStdoutTruncated
  }

  // Whose stored outline may answer: conversations in the folders searched,
  // and this one, whose outline is read live rather than from its last save.
  const places = new Map(files.map(one => [searchSessionOf(one.path), { cwd: isHere(one.path) ? root : '', title: '' }]))
  places.set(current, { cwd: root, title: '' })
  const outlines = new Map<string, SearchSaved>()
  const known = ((await $.store.get(SESSIONS)) as string[] | undefined) ?? []
  for (const id of known) {
    if (!places.has(id) || id === current) continue
    const saved = (await $.store.get(`s:${id}`)) as SearchSaved | undefined
    if (saved !== undefined) outlines.set(id, saved)
  }
  outlines.set(current, { marks: await read($, marks), prompts: await read($, prompts) })

  const here = new Set(files.filter(one => isHere(one.path)).map(one => searchSessionOf(one.path)))
  here.add(current)
  const hits = searchHits({ files: found, outlines, words, places, room: SEARCH_ROOM }).map(hit =>
    here.has(hit.sessionId) ? { ...hit, cwd: root } : hit,
  )

  const scope = isAll ? 'every project' : 'this project'
  const notes = [`${hits.length === 0 ? 'No' : hits.length} hit${hits.length === 1 ? '' : 's'} in ${scope}`]
  if (everyFile.length > files.length) notes.push(`newest ${files.length} of ${everyFile.length} conversations`)
  if (isCut) notes.push('stopped at 4 MB of matches, add a word to narrow it')
  await update($, searchFound, () => hits)
  await update($, searchNote, () => notes.join(' · '))
}

// A hit in this conversation jumps there; one in another fills the prompt with
// /resume, or, in another project, copies the command that resumes it there.
async function searchOpen($: Dollar, hit: BreakpointSearchHit, surface: RenderSurface, isFullscreen: boolean | undefined): Promise<void> {
  if (hit.sessionId === (await $.session.id())) {
    const prompt = (await read($, prompts)).find(one => one.uuid === hit.uuid)
    if (prompt === undefined) {
      $.ui.toast('That part of this conversation is not in its outline yet.')

      return
    }
    if (hit.kind === 'answer') await jumpToAnswer($, prompt, isFullscreen)
    else await jumpToPrompt($, prompt, isFullscreen)

    return
  }

  if (hit.cwd !== (await $.session.root())) {
    const command =
      hit.cwd === ''
        ? `claude --resume ${hit.sessionId}`
        : `cd '${hit.cwd.replace(/'/g, `'\\''`)}' && claude --resume ${hit.sessionId}`
    const copied = await $.ui.copy({ text: command, surface })
    $.ui.toast(
      copied.isCopied
        ? `That conversation is in ${hit.project || 'another project'}: copied the command that resumes it.`
        : `That conversation is in ${hit.project || 'another project'}. Resume it with: ${command}`,
    )

    return
  }

  await $.prompt.fill({ text: `/resume ${hit.sessionId}` })
  await $.ui.close({ id: SEARCH_PANE })
  $.ui.toast(`Press Enter to resume "${clip(hit.title, 40)}".`)
}

export const registerSearch = (on: On) => {
  // `/bps search <words>`, `/bps search --all <words>`; every other /bps
  // argument goes on to the panel.
  on('command.run', { command: 'bps' }, async ($, e, next) => {
    const asked = /^search(?:\s+(.*))?$/i.exec(squash(e.args))
    if (asked === null) return next(e)

    const rest = asked[1] ?? ''
    const isAll = /(^|\s)--all(\s|$)/.test(rest)
    const query = squash(rest.replace(/(^|\s)--all(?=\s|$)/g, ' '))
    if (searchWords(query).length === 0) {
      $.ui.toast('Type /bps search <words>, or /bps search --all <words> for every project.')

      return {}
    }

    await syncSession($)
    await update($, searchQuery, () => query)
    await update($, searchFound, () => [])
    await update($, searchNote, () => `Searching ${isAll ? 'every project' : 'this project'}…`)
    await update($, searchBusy, () => true)
    const opened = await $.ui.open({ id: SEARCH_PANE, title: 'Search', focus: true, closeOnEscape: true })
    if (!opened.isPlaced) $.ui.toast(`The search results are waiting for room: ${opened.reason}`)

    try {
      await searchRun($, query, isAll)
    } catch (error) {
      await update($, searchNote, () => `The search failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await update($, searchBusy, () => false)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: SEARCH_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const query = await read($, searchQuery)
    const hits = await read($, searchFound)
    const isBusy = await read($, searchBusy)
    const note = await read($, searchNote)
    const current = await read($, session)
    const now = await $.clock.now()
    const width = Math.max(24, e.props.bodyColumns)
    const isFullscreen = e.viewport?.isFullscreen
    const isManyProjects = new Set(hits.map(hit => hit.project)).size > 1

    const groups: { sessionId: string; hits: { hit: BreakpointSearchHit; index: number }[] }[] = []
    for (const [index, hit] of hits.entries()) {
      const group = groups.at(-1)
      if (group !== undefined && group.sessionId === hit.sessionId) group.hits.push({ hit, index })
      else groups.push({ sessionId: hit.sessionId, hits: [{ hit, index }] })
    }

    const drawGroup = (group: (typeof groups)[number]) => {
      const first = group.hits[0]?.hit
      const latest = Math.max(...group.hits.map(one => one.hit.at))
      const where = [
        searchDate(latest, now),
        clip(first?.title || 'Untitled conversation', Math.max(12, width - 30)),
        ...(isManyProjects && first?.project ? [first.project] : []),
        ...(group.sessionId === current ? ['this conversation'] : []),
      ].filter(one => one !== '')

      return (
        <Box key={`group-${group.sessionId}`} flexDirection="column">
          <Text bold color={group.sessionId === current ? 'cyan' : 'white'} wrap="truncate-end">
            {where.join(' · ')}
          </Text>
          {group.hits.map(({ hit, index }) => {
            const chapter = hit.kind !== 'chapter' && hit.chapter !== '' ? `◇ ${clip(hit.chapter, Math.floor(width / 3))}` : ''
            const room = Math.max(8, width - chapter.length - 8)

            return (
              <Box key={`row-hit-${index}`} flexDirection="row">
                <Text color={hit.kind === 'answer' ? 'green' : hit.kind === 'mark' ? 'magenta' : 'cyan'}>
                  {`  ${SEARCH_GLYPH[hit.kind]} `}
                </Text>
                <Button
                  key={`hit-${index}`}
                  plain
                  {...(hit.kind === 'answer' ? { dimColor: true } : {})}
                  label={clip(hit.text, room)}
                  onPress={pressed => searchOpen($, hit, pressed.surface, isFullscreen)}
                />
                <Box flexGrow={1} />
                <Text dimColor>{chapter === '' ? '' : ` ${chapter}`}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold wrap="truncate-end">{`Search: ${clip(query, Math.max(8, width - 16))}`}</Text>
          <Box flexGrow={1} />
          <Button key="search-close" role="dismiss" hotkey="q" dimColor label="Close" onPress={() => $.ui.close({ id: SEARCH_PANE })} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {note}
        </Text>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(width)}
        </Text>
        {isBusy && <Text color="cyan">Searching…</Text>}
        {!isBusy && hits.length === 0 && <Text dimColor>{`Nothing found for "${clip(query, 40)}".`}</Text>}
        {groups.map(drawGroup)}
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(width)}
        </Text>
        <Text dimColor wrap="truncate-end">
          ◇ chapter · › sub-topic · ◆ breakpoint · {'>'} your prompt · ↳ Claude's answer · Enter opens · Esc closes
        </Text>
      </Box>
    )
  })
}
