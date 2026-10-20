# ◇ breakpoints

**A table of contents for long Claude Code conversations.**

A long session turns into a wall of text. Somewhere up there is the decision
you made an hour ago, the answer you want to reuse, the point where things went
sideways. Scrolling for it is slow, and asking Claude to "remember what we said
about X" costs tokens and is never quite word for word.

breakpoints watches the conversation as it happens and builds an outline of it:
**chapters**, **sub-topics** and **what Claude answered**, labelled for you
after every turn. From that outline you can jump anywhere, fold away what you're
done with, bring an old exchange back into context word for word, search every
past conversation, and export a chapter to markdown.

```
 [Outline]  Breakpoints 6   Fold all   Recall   Edit   Auto on            Close
 ────────────────────────────────────────────────────────────────────────────
 ▸ ◇ Partner sign-up wizard (6)                       $2.10 · 41 min · 3h ago
 ▾ ◇ Captcha on the join form                          $0.84 · 18 min · 2h ago
     › Pick a captcha provider                         $0.22 · 4 min  · 2h ago
       ↳ Friendly Captcha, EU endpoint, no cookies
     › Wire the widget into step 2                     $0.40 · 9 min  · 2h ago
       ↳ Loads only when /partner/config says so
         ☆ The CSP needs *.frcapi.com and wasm-unsafe-eval
   ◆ before the refactor                                                1h ago
   ⇊ compacted                                                         50m ago
 ▾ ◇ Rate limits for sign-up                           $0.31 · 6 min  · 12m ago
     › Tighter cap than PartnerConfig                                   12m ago
 ────────────────────────────────────────────────────────────────────────────
 ◇ chapter · › sub-topic · ↳ answer · ☆ starred · ◆ your /bp · ⇊ compacted …
```

---

## Quick start

```bash
# Load it for one session
claude --plugin-dir ~/claude-mods/breakpoints

# …or for every session (this is how the a11 / fishingbeats aliases do it)
export CLAUDE_CODE_PLUGIN_DIRS=~/claude-mods/breakpoints
```

Then just work. After a few turns:

| Do this | To get |
|---|---|
| `/bps` (or click **◇ Outline** under the prompt) | the outline pane |
| `/bp before the refactor` | a named bookmark at this exact point |
| `Enter` on any row in the pane | a jump straight to it |
| `r`, then pick a row | that exchange, word for word, attached to your next message |
| `/bps search captcha` | every past conversation in this project that mentions it |

> **Jumping and clicking need the fullscreen layout.** If a jump says
> "needs the fullscreen layout", start Claude Code with
> `CLAUDE_CODE_NO_FLICKER=1`. Everything else works on the main screen too.

---

## What's in the outline

| Glyph | What it is | Where it comes from |
|---|---|---|
| `◇` | **Chapter**: a stretch of the conversation about one thing | labelled automatically |
| `›` | **Sub-topic**: one prompt that started something new | labelled automatically |
| `↳` | **Answer**: a one-line gist of what Claude replied | labelled automatically |
| `☆` | **Starred answer**: one you marked as worth keeping | the ☆ Star button under an answer |
| `◆` | **Breakpoint**: your own bookmark | `/bp [label]` |
| `⇊` | **Compaction**: where `/compact` squashed the history | read from the transcript |
| `⌘` | **Command**: a slash command you ran (dim, a hint only) | read from the transcript |

Chapters also show **what they cost and how long they took** (`$0.84 · 18 min`),
so you can see where the session's money went. On a narrow pane those figures
drop out to keep the titles readable.

When auto-labelling is on, the **status line** shows the chapter you're in now:
`◇ Captcha on the join form`.

### How the labels get there

After each turn, one small **Haiku** call reads the new exchange and decides:
does this start a new chapter, is it a new sub-topic or a follow-up, and what
did Claude answer, in one line. It runs in the background and never holds up
your turn. Exchanges from before the mod was loaded (or from a resumed
conversation) are read back from the transcript file and labelled too, so the
outline always covers the whole conversation.

Untitled rows show dimmed until their label lands. Press `a` in the pane to
switch auto-labelling off. Your own `/bp` marks keep working either way.

---

## Commands

### `/bp [label]`

Drops a breakpoint at the latest point of the conversation. Without a label it
borrows the latest exchange's title.

```
/bp
/bp working version before I touch the cache
```

In the transcript it draws as a magenta rule you can't miss while scrolling,
with **▼ Fold**, **↩ Recall** and **✕ Remove** buttons on it.

### `/bps …`

| Command | What it does |
|---|---|
| `/bps` | Open the outline pane |
| `/bps <n>` | Jump straight to entry *n* of the Breakpoints tab |
| `/bps <words>` | Open the pane filtered to rows matching *words* |
| `/bps search <words>` | Search past conversations in **this project** |
| `/bps search --all <words>` | Search **every project** |
| `/bps fold [n \| all \| others]` | Fold chapter *n*, every chapter, or all but the newest |
| `/bps unfold [n \| all]` | Unfold one chapter, or everything |
| `/bps fold-style heading` | Folded chapters show their title only (default) |
| `/bps fold-style summary` | Folded chapters show a two-line Haiku summary |
| `/bps reading` | Toggle **reading mode**: prompts and final answers only |
| `/bps export [n \| words \| all] [--summary]` | Write a chapter (newest by default) or the whole conversation to markdown |
| `/bps redo` | Throw away the automatic labels and relabel the whole conversation |

---

## The pane

Open it with `/bps`, the **◇ Outline** button under the prompt, or
`ctrl+x o` (see [the keyboard toggle](#keyboard-toggle)).

| Key | Action |
|---|---|
| `o` / `b` | **Outline** tab (the tree) / **Breakpoints** tab (a flat, numbered list of chapters, stars, `/bp`s and compactions) |
| `1`–`9` | In the Breakpoints tab: jump to that entry |
| `Enter` | Jump to the selected row |
| `▸` / `▾` | Collapse or expand a chapter in the pane (only the newest starts expanded) |
| `f` | Fold all: collapse every chapter in the pane |
| `r` | **Recall** mode: the next row you pick is brought back (see below) |
| `e` | **Edit** mode: rename, merge or split chapters |
| `a` | Auto-labelling on/off |
| `x` | Clear the filter |
| `q` / `Esc` | Close |

The `▸` in the left margin marks where you jumped last.

### Edit mode (`e`)

The model's chapter boundaries won't always match how you think about the work.
In edit mode:

- **rename** a chapter. A renamed chapter keeps its name even through `/bps redo`.
- **merge ↑** a chapter into the one above it (its heading goes away).
- **split here** on any sub-topic to start a new chapter there.

---

## Recall: bring an old exchange back, word for word

Press `r` in the pane, then pick a chapter, sub-topic, answer or breakpoint.
The prompts and Claude's final answers from that part of the conversation are
pulled **verbatim from the transcript file** and attached, invisibly, to your
next message. A green band above the prompt shows what's riding along:

```
↩ Recalled for your next message: ◇ Captcha on the join form (chapter, 3 exchanges) · 4k chars   ✕ drop
```

If the prompt box is empty it is pre-filled with `Re ◇ "Captcha on the join form": `
so you can carry straight on. You can stack up to four recalls; `✕ drop` clears
them. They're sent once, then cleared.

This is the cheap, exact alternative to "scroll up and copy" or "do you
remember when we…". It's especially useful after a `/compact`, when the details
are gone from Claude's context but still in the file.

Every chapter heading and breakpoint in the transcript has its own
**↩ Recall** button too.

---

## Folding the conversation itself

Folding works on **the transcript**, not just the pane. A folded chapter
collapses to one line in the conversation:

```
▶ Unfold   ◇ Partner sign-up wizard · 6 exchanges · 41 tool calls   ↩ Recall   ✎ Rename
```

- Every chapter heading in the transcript has **▼ Fold**.
- Every sub-topic prompt has its own **▼ Fold**, for smaller cuts.
- A `/bp` folds like an editor region: everything after it up to the next
  breakpoint or chapter.
- With `/bps fold-style summary`, folded chapters get a two-line summary
  ("what was asked, what was decided or built") written by Haiku.

### Reading mode

`/bps reading` hides every tool call, tool result, turn timer and the text
Claude writes along the way, and keeps just **your prompts and Claude's final
answers**. An exchange that's still running always shows in full. It's the
fastest way to reread a long session. The setting is remembered across sessions.

### Stars

Every final answer gets a **☆ Star** button. A starred answer gets a yellow bar
down its left edge, and appears in the outline and the Breakpoints list under
the exchange it answered.

---

## Search past conversations

```
/bps search rate limit signup
/bps search --all friendly captcha
```

This searches chapter and sub-topic titles, breakpoints, your prompts and
Claude's answers across saved transcripts. Results are grouped by conversation
and dated:

```
Search: friendly captcha
4 hits in this project · newest 150 of 212 conversations
─────────────────────────────────────────────────────────
Oct 18 · Partner sign-up wizard · this conversation
  ◇ Captcha on the join form
  ↳ Friendly Captcha, EU endpoint, no cookies          ◇ Captcha on the join form
Oct 12 · Partner portal v2 spec
  > should we use hcaptcha or friendly captcha          ◇ Spam protection
```

Opening a hit:

- **in this conversation**: jumps to it.
- **in another conversation in this project**: fills the prompt with
  `/resume <id>`; press Enter.
- **in another project**: copies `cd '<dir>' && claude --resume <id>` to the
  clipboard.

Search reads the newest 150 conversations (up to about 600 MB of transcript)
and says so in the note line when there are more.

---

## Export to markdown

```
/bps export                      # the newest chapter
/bps export 3                    # chapter 3
/bps export captcha              # the chapter whose title matches
/bps export all --summary        # the whole conversation, with a Haiku summary on top
```

Prompts and final answers are written **word for word**, under an outline of
the exported part. Files land in `docs/conversations/<yyyy-mm-dd>-<title>.md`
under the project root. Change that folder with the plugin's `exportDir`
option: a path relative to the project root, an absolute path, or one under `~/`.

## It survives `/compact`

When the conversation is compacted, the summary tends to flatten everything
into one paragraph. breakpoints adds the outline (chapters, sub-topics and
answer titles, trimmed to about 6,000 characters) as a second message right
after the summary, so Claude keeps the table of contents even though it's lost
the details. Pair it with **Recall** to bring any of those details back.

The compaction itself shows up as a `⇊` breakpoint.

---

## Setup notes

### Keyboard toggle

A mod can't register its own keybinding action, so the pane borrows one that
otherwise only does anything inside the diff panel. Add this to your account's
`keybindings.json` and `ctrl+x o` opens and closes the outline:

```json
{
  "bindings": [
    { "context": "Global", "bindings": { "ctrl+x o": "app:toggleDiffNoiseFilter" } }
  ]
}
```

### Where data lives

Outlines, breakpoints, stars and settings are saved per account in
`<config dir>/plugins/store/breakpoints_inline-*.json`, keyed by session id.
They don't depend on where the plugin folder sits, so moving the folder keeps
everything. Nothing leaves your machine except the small Haiku labelling,
summary and export-summary calls.

### Cost

One short Haiku call per turn for labels, plus one per folded chapter when
`fold-style summary` is on, and one per `export --summary`. Turn auto-labelling
off with `a` in the pane if you'd rather not.

---

## Developing

```
hooks/src/*.tsx        the mod, split by feature (core, tracking, transcript, stats, search, export, pane, main)
hooks/register.tsx     GENERATED: the bundle the engine loads. Don't edit by hand.
hooks/*.ts             pure, $-free logic (outline, fold, search, export, stats), imported normally
types/index.d.ts       plugin state and data shapes
tests/                 the test suite
tools/bundle.py        joins hooks/src/*.tsx into hooks/register.tsx
```

Edit a source in `hooks/src/`, then rebuild the bundle and run the tests:

```bash
python3 tools/bundle.py
CLAUDE_CONFIG_DIR=~/claude-accounts/fishingbeats claude plugin test ~/claude-mods/breakpoints
```

Sessions started with the plugin dir **watch the folder and reload on save**,
so a broken bundle breaks every open session at once. Run the tests before you
save over `register.tsx`.

**Why the bundle?** The function-hooks engine only follows `$` into functions
declared at the top level of the *same file*, never across an import, and each
plugin gets just one matcher-less hook per event. So every `$`-taking function
has to end up in one file, and `main.tsx` owns `session.start`, `turn.complete`
and the rest, calling each module by name. The pure libraries stay as real
imports.

To force every saved outline to be relabelled after changing the labelling
prompt, bump `OUTLINE_VERSION` in `hooks/src/core.tsx`.
