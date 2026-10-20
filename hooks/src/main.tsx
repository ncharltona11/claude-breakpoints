import type { Register } from 'claude-code'

import { registerExport } from './export'
import { paneOnStart, paneOnSubmit, registerPane } from './pane'
import { registerSearch } from './search'
import { registerStats, statsOnStart, statsOnTurn } from './stats'
import { registerTracking, trackingOnEnd, trackingOnStart, trackingOnTurn } from './tracking'
import { registerTranscript, transcriptOnStart } from './transcript'

// The engine allows one matcher-less hook per event per plugin, and follows
// `$` only into functions named at the top of the file. So the events several
// modules need are hooked here once, each module's part a named call. Hooks
// with a matcher (a render site, `/bps <word>`) live in the modules; for one
// shared matcher the first registered answers first, which is why the panel,
// whose /bps takes every argument the others pass on, registers last.
export const register: Register = (on, options) => {
  registerTracking(on)
  registerTranscript(on)
  registerStats(on)
  registerSearch(on)
  registerExport(on, options)
  registerPane(on)

  on('session.start', async ($, e, next) => {
    await trackingOnStart($)
    await transcriptOnStart($)
    await paneOnStart($)
    await statsOnStart($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    trackingOnEnd($, e)

    return ended
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    trackingOnTurn($, e)
    statsOnTurn($, e)

    return done
  })

  on('prompt.submit', ($, e, next) => paneOnSubmit($, e, next))
}
