# Claude Code bridge (fork design)

This fork removes LearnHarness's own model engine. All model work is done by
the learner's own **Claude Code**, running in a terminal embedded in the
desktop app, through LearnHarness tools served over MCP. The app keeps the
method (prompts), the GUI, the record formats and the deterministic tool
logic; it never calls a model provider itself.

## Shape

```
GUI (chat · question dock · plan · graph · practice)   ← unchanged views
   ▲ pi AgentEvent stream (same wire as before)         │ ChatInput (same POST /api/chat)
   │                                                     ▼
chat-handler → BridgeAgent (per turn)  ⇄  ClaudeSession (per chat, globalThis)
                                              ▲ MCP tool calls / blocking waits
                                              │
/api/mcp?chat=<id>  (streamable HTTP, Bearer per-launch MCP token)
                                              ▲
Embedded terminal (node-pty in Electron main) → `claude` with the pre-wired launch
```

### Turns

A GUI "turn" is the span from one learner input to Claude's next blocking
call. The handler keeps its write-ahead persist, liveness, 409 guard,
`runPiTurn` stream and `onFinish` persist; only the agent is replaced:

- `BridgeAgent` implements the subset `runPiTurn` uses — `state.messages`,
  `subscribe`, `continue()`, `abort()`. `continue()` resolves when Claude
  blocks again (a question tool or `wait_for_learner`) or goes idle.
- Each Claude tool call becomes native messages exactly as the old engine
  wrote them: an assistant message with a `toolCall` block (provider
  `claude-code`, zero usage), then a `toolResult` for executed tools.
- **Question tools** (quiz/recall/explain/ask_user_question/problem) persist
  the call with no result and settle the turn; the MCP call stays open. The
  learner's `answer` input appends the result (unchanged input-events code)
  and the new turn resolves the open MCP call with that result's text.
- **`wait_for_learner`** is bridge mechanics, never persisted. A `text`
  input appends the user message and resolves it with the text.
- Open MCP calls send `notifications/progress` every 30s so Claude Code's
  5-minute HTTP idle timeout never fires while the learner thinks.
- A `Stop` hook posts to `/api/claude-hook/stop`; if Claude stopped without
  blocking, the hook answers `decision: block` telling it to end every reply
  with `wait_for_learner` or a question tool.

### Method

The composed system prompt (shared base + prober + teacher fragments, or the
practice set) is written to a file and passed with
`--append-system-prompt-file`, so it survives Claude Code's compaction.
`probe_done` switches phase (the record's existing `probe_done` seam); its
result tells Claude it is now the teacher. After a compaction or a resume
whose transcript was cleaned up, `resume_session` returns this session's plan,
phase and a compact recent history — this session only.

### Launch (pre-wired terminal)

- `claude --restricted --strict-mcp-config --mcp-config <file>`
  `--tools Read,Glob,Grep,WebSearch,WebFetch,<lh tools>` `--allowedTools <same>`
  `--settings <file>` `--append-system-prompt-file <file>`
  `--session-id <uuid>` (first launch) / `--resume <uuid>` (later), first
  message = the learner's topic.
- Settings: `autoMemoryEnabled: false`, `disableClaudeAiConnectors: true`,
  `permissions.deny` for the LH data dir, `auth.json`, `.env*`,
  `*-credentials.json`; the Stop hook.
- Working directory: an empty per-app folder (no CLAUDE.md); `--add-dir` home
  so notes and PDFs are readable.
- On exit the pty falls back to a shell. `--bare` is not used (it refuses
  subscription login).

### Background work → Claude

| Old agent | Now |
|---|---|
| extractor + auditor | `graph_extract_next` → `graph_submit_findings` → graph readers → `graph_submit_links`; the deterministic merger writes the ledgers. Run by Claude at session end or on request — never automatically, the app cannot start Claude |
| notes import | the import dialog QUEUES uploads (`data/claude/notes-queue/`); `graph_import_notes` (no path = next queued file, or a path) runs the same flow |
| researcher / pdf reader | Claude's own WebSearch/WebFetch/Read, then `deliver_research` / `deliver_pdf_brief` |
| demo builder / visual maker | `test_demo` → `deliver_demo` (re-tested, refused if failing); `preview_visual` (returns the rendered PNG) → `deliver_visual` |
| practice agent | the practice prompts + `problem` / `conclude` over the same bridge |
| compaction summarizer | Claude Code's own compaction + `resume_session` |

Removed with the engine: pi-ai / pi-agent-core runtime, model slots and
picker, provider keys and subscription logins, cost accounting, the wake
pipeline. Kept: the Deepgram key (dictation) in `auth.json`.

## Running it

- Desktop (development): `npm run desktop:dev` — Next on 127.0.0.1:3000 plus the Electron shell; open a session and the terminal pane starts Claude Code.
- Browser-only `npm run dev` has no embedded terminal; `/api/claude/launch?chat=<id>` returns the argv to run yourself.
- Claude Code must be installed (`claude` on PATH) and signed in. `--bare` is never used: it refuses subscription login.
- Conversations resume with `--resume` while Claude Code still keeps the transcript (its own cleanup applies); afterwards a fresh conversation starts and `resume_session` rebuilds this session's context only.

## Known limits

- The app cannot start or prompt Claude by itself: the manual "extract" button and notes import tell the learner what to ask in the terminal.
- Per-turn token cost and context meters are gone (Claude Code shows its own usage).
- Engine-era features with no Claude Code equivalent were removed: model slots and per-session models, compaction settings, the background job wake pipeline.
