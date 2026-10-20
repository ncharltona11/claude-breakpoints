import { read } from 'claude-code'
import type { CommandRunResult, On, PluginOptions, SessionCompactInput, SessionCompactResult } from 'claude-code'

import {
  EXPORT_DIR,
  compactionOutline,
  exportDirectory,
  exportFileName,
  exportMarkdown,
  exportScope,
  exportSummaryRequest,
  parseExportArgs,
  withOutline,
} from '../export-lib'
import type { ExportExchange } from '../export-lib'
import { squash } from '../outline'
import { marks, prompts, readTranscript, session, syncSession } from './core'
import type { Dollar } from './core'
import { refreshEventsSoon } from './tracking'

// The `exportDir` option, relative to the project root unless absolute.
let exportDirOption = EXPORT_DIR

async function exportSummary($: Dollar, title: string, exchanges: readonly ExportExchange[]): Promise<string> {
  const reply = await $.model.complete({ model: 'haiku', prompt: exportSummaryRequest(title, exchanges), maxTokens: 1200, timeoutMs: 90_000 })

  return reply.isAnswered ? reply.text.trim() : `_Summary unavailable (${reply.reason})._`
}

// `/bps export [n|words|all] [--summary]`: a chapter (the newest by default)
// or the whole conversation as markdown, prompts and final answers verbatim.
async function exportCommand($: Dollar, rest: string): Promise<CommandRunResult> {
  await syncSession($)
  const args = parseExportArgs(rest)
  const all = (await read($, marks)).filter(one => one.isRemoved !== true)
  const said = await read($, prompts)
  const scope = exportScope(args, all, said)
  if ('error' in scope) return { text: scope.error }

  const sessionId = await read($, session)
  const found = await readTranscript($, sessionId)
  const exchanges = scope.prompts.map(prompt => ({
    prompt,
    words: found.words.get(prompt.uuid) ?? prompt.text,
    answer: found.answers.get(prompt.uuid)?.text ?? '',
  }))
  const summary = args.withSummary ? await exportSummary($, scope.title, exchanges) : undefined
  const now = await $.clock.now()
  const markdown = exportMarkdown({ scope, all, said, exchanges, sessionId, exportedAt: now, ...(summary === undefined ? {} : { summary }) })

  const root = await $.session.root()
  const dir = exportDirectory(exportDirOption, root, (await $.env.get('HOME')) ?? '')
  let path = exportFileName(dir, scope.title, now, 1)
  for (let attempt = 2; attempt < 100 && (await $.fs.exists(path)); attempt += 1) {
    path = exportFileName(dir, scope.title, now, attempt)
  }
  await $.fs.write(path, markdown)

  const shown = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  const count = `${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}`

  return { text: `Exported "${scope.title}" (${count}${summary === undefined ? '' : ', with a summary'}) to ${shown}` }
}

// After a compaction of the main conversation, the outline stays in it: the
// model keeps the table of contents the summary may have flattened.
async function exportOnCompact(
  $: Dollar,
  e: SessionCompactInput,
  next: (e: SessionCompactInput) => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  const done = await next(e)
  if (done.skip !== undefined || e.agentId !== undefined || e.trigger === 'precompute') return done
  // The compaction itself becomes a breakpoint once its row is in the file.
  refreshEventsSoon($, 3000)

  try {
    await syncSession($)
    const outline = compactionOutline(
      (await read($, marks)).filter(one => one.isRemoved !== true),
      await read($, prompts),
    )

    return outline === null ? done : { ...done, messages: withOutline(done.messages, outline) }
  } catch (error) {
    $.ui.log(`breakpoints: could not keep the outline through compaction: ${String(error)}`, { to: 'debug' })

    return done
  }
}

// Export a chapter to markdown, and keep the outline through /compact.
export const registerExport = (on: On, options: PluginOptions) => {
  exportDirOption = typeof options.exportDir === 'string' && options.exportDir.trim() !== '' ? options.exportDir : EXPORT_DIR

  on('command.run', { command: 'bps' }, async ($, e, next) => {
    const [word = '', ...rest] = squash(e.args).split(' ')

    return word.toLowerCase() === 'export' ? exportCommand($, rest.join(' ')) : next(e)
  })

  on('session.compact', ($, e, next) => exportOnCompact($, e, next))
}
