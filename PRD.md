# dwiw — Product Requirements Document

> **Name:** `dwiw` — *do what I want*. The classic Unix/Lisp term for a system that infers your intent instead of taking you literally.
> **Status:** design locked.
> **One-liner:** A shell-agnostic overlay that lets you type normal commands *or* natural language on the same line — commands run instantly and natively, natural language is handled by an AI agent — with no mode switch and no required prefix. As instant as a normal shell.

---

## 1. Vision & thesis

Today you either use a shell (fast, native, no intelligence) or an AI tool (intelligent, but a separate mode/app/prefix you opt into). `dwiw` collapses them into **one input line**:

- Type `ls`, `git status`, `z foo` → resolves and execs **natively, instantly, model never consulted.**
- Type `Summarize the big files here` or `why did that fail?` → routed to an AI agent that proposes (or performs) the work.
- **No mode switch. No mandatory prefix. No perceptible latency on real commands.**

The non-negotiable property: **it must feel exactly like your normal shell.** Any design that taxes ordinary commands with inference, startup cost, or a ritual prefix is rejected.

### Why this is unoccupied
We surveyed 8 existing implementations (butterfish, nl-sh, aichat, shell_gpt, open-interpreter, ai-shell, yai, mods) + Warp + Copilot CLI. Findings:
- Every required capability exists **individually** — free routing, seamless line, real shell, deep agent, local models — but **no project combines them on one line.**
- **Nobody routes on capability resolution.** Everyone routes on an explicit signal: orthography (butterfish), a `.`/flag/hotkey (aichat/shell_gpt/ai-shell), or an always-on LLM (yai). Routing on *whether the token actually resolves* is the unclaimed insight.
- **Nobody auto-escalates local↔cloud.** All treat model choice as static config.

**Closest prior art: butterfish** (MIT, Go) — a real PTY overlay with a free router and a real agent loop. It got the *architecture* right but routes on a crude orthographic trick (uppercase first letter) instead of capability resolution, and is OpenAI-only. **`dwiw` is butterfish's category, done with a real resolution-based router and a model-agnostic, pluggable brain.** Butterfish is our plumbing + UX reference.

---

## 2. Locked decisions

| Area | Decision |
|---|---|
| **Foundation** | Shell-agnostic **PTY overlay** (butterfish technique). NOT a fish fork, NOT a from-scratch shell. Wraps the user's existing shell. |
| **Language** | **Bun/TypeScript** primary (overlay + brain, one repo, fits Bun-only rule, pi integration). **Plain C** as a *surgical* escape hatch for the low-level PTY / hot-path inner loop — only if profiling shows Bun adds perceptible latency. Start pure Bun. |
| **Router** | **Deterministic, no ML model.** Capitalization (natural prior) + in-process capability resolution + word-list scoring + keyword lists. Microsecond hashset lookups. |
| **Brain** | Own Bun process **composed from pi's packages** (`pi-ai`, `pi-agent-core`, selected `coding-agent` tools), over stdio JSON-RPC. Not the opaque `pi` CLI. |
| **Models** | **Cloud-first in v1** (configurable provider/model, sensible default). Local-first + auto-escalation = later milestone. |
| **Brain behavior** | **One-shot proposal** primary. Multi-step agent available via a configurable, low-invasive depth trigger (see §6). |
| **Proposal UX** | **Inline-populate** the proposed command into the editable shell line (butterfish style) by default. **Configurable** to a clack-style Run/Revise/Cancel menu. |
| **Execution** | AI-proposed commands run **in the user's real shell session** (cwd/env/history persist). |
| **Interaction** | One-shot intents resolve **foreground** (stream inline). Multi-step agent tasks are **backgroundable like shell jobs** — keep working, get notified on completion (see §6). |
| **Safety** | **Configurable; default non-invasive.** Proposals run on plain Enter (sudo-philosophy: choosing to run = intent). Destructive-guard + explicit y/N are **opt-in** via config. OS sandboxing deferred. |
| **Context** | **Inject shell context** (recent history + last command output) into the brain. Conversation context comes free from pi's stateful session. |
| **Plugins** | **Full public plugin system in v1** (API + loader + docs), built on pi's extension mechanism. Native plugins dogfood the same API. |
| **v1 built-ins** | Shell-context injection, Memory. |
| **Platform** | macOS first (darwin); Linux close behind (PTY approach is portable). Target shells: **fish first**, then zsh/bash. |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  dwiw OVERLAY  (Bun; C for hot path if needed)                │
│                                                                │
│  • spawns user's $SHELL (fish/zsh/bash) as a child over a PTY  │
│  • intercepts stdin/stdout, buffers history + last output      │
│  • owns an in-process RESOLUTION TABLE synced from the shell   │
│    ($PATH binaries + aliases + functions + builtins)           │
│                                                                │
│   on Enter ─► ROUTER (deterministic, µs) ─┐                    │
│                                           │                    │
│      resolves / parses as command ────────┼─► child $SHELL     │
│                                           │   (native exec,    │
│      looks like intent ───────────────────┘   job control,     │
│                    │                          pipes — free)    │
│                    ▼                                            │
│              BRAIN (stdio JSON-RPC)                             │
└────────────────────┼───────────────────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  dwiw BRAIN  (Bun; composed from pi packages)                 │
│  • pi-ai          → multi-provider LLM client (cloud v1)       │
│  • pi-agent-core  → plan-execute-observe loop                  │
│  • coding-agent   → selected tools (bash, read, edit, …)       │
│  • PLUGIN HOST    → loads native + third-party plugins         │
│       native: shell-context, memory                            │
│  • returns: proposed command(s) | agent actions | text         │
└──────────────────────────────────────────────────────────────┘
```

**Why overlay + own resolution table:** an overlay doesn't get capability resolution for free (the child shell owns it). We fix butterfish's mistake (orthographic routing) and nl-sh's mistake (a `command -v` subprocess *per line*) by maintaining our **own in-process table**, synced from the shell at startup and refreshed on change. Resolution is then a hashset lookup — microseconds, never a subprocess, never the model.

---

## 4. The router (deterministic, instant)

Runs on every Enter, over the full line buffer. **No inference. No model. Hashset lookups + counting over a handful of tokens** — orders of magnitude under the shell's own fork+exec cost.

### Signal pipeline (first decisive signal wins)
1. **Pass-through guards** — empty line, or an interactive child process is running (vim/ssh/less) → forward untouched.
2. **Explicit overrides** (optional, configurable, highest priority) — a dedicated key or configured cue forces command / intent / agent. For users who want determinism. Never *required*.
3. **Capitalization prior** — first char uppercase **and** first token is **not** a known command → **intent.** *(butterfish's natural convention: prose is capitalized, commands aren't. Single-byte check.)*
4. **Resolution fast path** — first token (lowercased) resolves as builtin/alias/function/`$PATH` binary **and** the line parses like a command (flags/paths/syntax) → **command**, exec natively. Covers `ls -la`, `git status`, `z foo`, `codex build this`.
5. **Keyword lists** (Warp-validated) — agent CLIs (`claude`, `codex`, `gemini`, `pi`, …) → **command** (so we never hijack them); known toolchain-verb collisions handled explicitly.
6. **Word-list scoring** — for the ambiguous middle: count tokens that are English-dictionary (NL signal) vs command-dictionary/shell-syntax (command signal), skipping the first token if it's a command. Token-count-scaled thresholds (≤2 tokens: unanimous; ≤4: ~70%; 5+: ~50%). Decides command vs intent. Catches lowercase prose ("show me big files") **and** prevents capitalized-command misfires.
7. **Default** — unresolved first token → intent; resolved-but-prose-scored → intent.

### Ambiguous-resolved safety rule
When the first token **resolves** but the line scores **prose-like** (the dangerous middle), **never auto-execute.** Populate it into the editable line and wait for Enter (or treat as intent). Clear commands (`ls`, `git status`) still run instantly; only the genuinely-ambiguous ones pause. Rationale: an intent→shell misroute that *already ran* can't be undone — this eliminates that entire error class.

### Design principles
- **Capitalization is sufficient, not necessary.** Capitalize and just talk (the butterfish feel), *or* type lowercase prose and the scorer still routes it. Either works.
- **Cheap to override, not perfect to predict.** Genuine ambiguity is information-theoretic — a tie-breaker must exist. Make misroutes a **one-key correction** (flip command↔intent, re-run), not a re-typed line. Recovery, not a prefix tax.
- **Assets, not a runtime:** word-lists (English dict + StackOverflow/tech terms) and the command dict (free from `$PATH` + shell completions). Static data, loaded once.

### Non-goal (explicit)
- **No BERT-Tiny / ONNX classifier.** Warp's deterministic word-scorer (their model's own panic-fallback) is proof the deterministic path suffices. An inference engine on shell startup / the hot path violates the instant-as-a-normal-shell requirement. The tiny model may return *later* as an opt-in, lazy-loaded adjudicator — off by default, never on the hot path.

---

## 5. The brain (pi-composed, RPC)

A long-lived Bun process, spawned once by the overlay, addressed over stdio JSON-RPC.

- **Composition:** import `@earendil-works/pi-ai` (LLM client, multi-provider), `@earendil-works/pi-agent-core` (the agent loop), and selected `coding-agent` tools. We control the prompt, model choice, tool surface, and streaming — not a black-box CLI.
- **Protocol:** JSON lines. Overlay → brain: `{ type: "prompt", message, context, mode }`. Brain → overlay: streamed events (`proposal`, `agent_action`, `text`, `done`).
- **Models:** cloud-first, provider-agnostic via pi-ai. Configurable; ship a sensible default. **Local + tiering is deferred (cloud-first now), designed-for** — model is chosen per request, so escalation is a later policy layer, not a rearchitecture.
- **Execution of proposals:** routed back into the **user's real shell session** (pi's bash-tool `BashOperations` delegation supports redirecting execution), so the agent shares cwd/env/history with the user. No detached subprocess with its own state.
- **Safety:** configurable, **default non-invasive** — proposals populate the editable line and run on plain **Enter** (sudo-philosophy: if you choose to run it, you meant it). Optional, opt-in: a **destructive-guard** (extra confirm on `rm -rf`/`dd`/force-push/redirects) and full **y/N** mode. No OS sandbox in v1.

---

## 6. Agent depth (better than `!`)

One-shot is primary. Escalating to a multi-step agent must be **low-invasive and not failure-prone** — so it's **layered and configurable**, resolved by priority:

1. **Explicit override (highest):** a dedicated key or configured cue → force agent (or force one-shot). Deterministic, opt-in.
2. **Natural verb cue (middle):** soft, punctuation-free phrasings ("go …", "fix …", "get … working") bias toward agentic depth.
3. **Auto-detect (default, lowest):** the brain classifies one-shot-command vs multi-step-goal from phrasing — the same way the router classifies command vs intent. Zero new syntax.

Default experience = **just talk** (auto-detect). Power users can pin behavior with a cue or key. Depth misclassification, like routing, is a cheap correction — never a hard failure.

### Foreground vs. backgrounded execution
Thinking-UX is **per interaction type**, reusing the shell's own job-control model:
- **One-shot proposal** (fast) → **foreground**, streams inline; you wait a beat, Enter to run.
- **Multi-step / agent task** (potentially long) → **backgroundable like a shell job**: keep using the shell while it works. Surfaced through the shell's own job-control model — a `jobs`-style list of running agents, a completion **notification** (inline/bell), and `fg` to inspect or approve steps. AI tasks are first-class background jobs.
- **Multi-turn follow-up** → foreground/conversational, **auto-detected**: right after an AI interaction, corrective/continuation phrasing ("no…", "now…", "instead…", "make it…") routes to the brain as a follow-up to the last turn; a real command still execs normally. No syntax, no mode.

---

## 7. Plugin system (full, public)

Built on pi's self-extensible extension mechanism (`ExtensionAPI`). **The public API, loader, and docs are a committed deliverable** — but the contract is **hardened only after the core loop proves what plugins actually need**: native plugins start as internal modules, then the interface is frozen, published, and the natives migrate onto that same public API (dogfooding guarantees it's real).

- **Plugin surface (v1 targets):** inject context into prompts, register tools, observe shell events (command run, output, exit code), persist state, post-process proposals.
- **Native plugins shipped in v1:**
  - **shell-context** — recent history + last command's output → brain (the "why did that fail? / fix it" magic). **Privacy: redact + cap** — obvious secrets (API keys, tokens, `.env`-style values) are scrubbed and payload size is capped before anything leaves the machine.
  - **memory** — persistent facts/preferences across sessions ("I use bun, not npm"), recalled into relevant prompts. **Policy: explicit + suggested** — you can say "remember X"; the system may also *suggest* remembering something it noticed, which you approve. Nothing is stored silently.
- **Inherited free from pi's session:** in-session conversation context (multi-turn follow-ups: "no, without sudo"). pi's back-and-forth session model provides this — we do **not** rebuild it.
- **Later:** command-history-awareness (bias proposals to your tools/aliases), local-tiering policy, sandbox policy — all as plugins on the same API.

---

## 8. Scope — core vs. deferred

### Core (what makes it itself)
- PTY overlay wrapping the user's shell (fish first; zsh/bash).
- Deterministic router (capitalization + resolution table + word-list scoring + keyword lists), with one-key correction.
- Brain process composed from pi packages; cloud model (configurable).
- One-shot command proposal, **inline-populate UX** (configurable to menu).
- Confirm-before-run; execution in the real shell session.
- Shell-context injection + memory (native plugins).
- Public plugin API + loader + docs.
- Configurable agent-depth trigger (auto-detect default; cue + key overrides).

### Deferred (designed-for, not now)
- Local model + local↔cloud auto-escalation (cloud-first to start).
- OS sandboxing / unsafe auto-run mode (mitigated by confirm-before-run).
- The BERT-Tiny/ONNX adjudicator (deterministic router only).
- Autosuggest/ghost-completions (butterfish's most expensive feature).
- Embeddings/RAG over local files.

---

## 9. Build dependencies (order emerges from these — not a schedule)

No fixed phases, no timeline. These are hard dependencies; sequence them however the work reveals it should go.

- The **PTY overlay** (transparent wrap of `$SHELL`, zero perceptible latency) underlies everything — the router and brain attach to it.
- The **deterministic router** needs the overlay's input interception + the resolution table synced from the shell.
- The **brain adapter** (mapping pi's `AgentSessionEvent` ↔ our `proposal`/`agent_action`) must exist before any brain feature — it's the isolation layer the churn mandate (§9.5) requires.
- **Native plugins** (shell-context, memory) are built as internal modules first; the **public plugin contract** is frozen and published only after they reveal what the API needs.
- **Agent depth, backgrounded jobs, and follow-up detection** layer on once one-shot proposal + real-shell execution work.
- **Deferred items** (§8) attach later without rearchitecture.

The single thing worth doing *first*, because it de-risks the core assumption, is the **overlay spike**: prove `$SHELL` wraps with no perceptible latency (vim/ssh/job-control intact). Everything else is dependency-ordered, not time-boxed.

---

## 9.5 Build vs. assemble — pi feasibility (validated)

Source-level audit of pi **0.80.2** against this PRD: **~70% of the brain + plugin layer is *assemble pi*, not build.**

**Free / EASY from pi:**
- **Brain RPC protocol** — `runRpcMode` is §5's prompt-in/streamed-events-out almost verbatim (`prompt`, `abort`, `set_model`, `get_available_models`, multi-turn steering). Adopt wholesale.
- **Per-request model/provider** — `set_model` RPC + `createAgentSession({model})`; per-turn `AgentLoopTurnUpdate.model` enables future local↔cloud escalation with no rearchitecture.
- **Streaming** — `text_delta`/`thinking_delta`/`toolcall_delta` flow through RPC for inline "thinking" UX.
- **Context injection** — `context` event + `before_agent_start.systemPrompt` + `Agent.transformContext`.
- **Plugin system** — pi's headline feature: `ExtensionAPI` (~30 events + `registerTool` + a real discovery loader + ~70 example extensions). Covers every §7 target. Biggest single de-risk.

**MEDIUM / our glue (pi gives the seam, not the logic):**
- **Real-shell execution** — `BashOperations` + the `user_bash → {operations}` hijack seam exist, but binding them to a *persistent shared PTY* (live cwd/env/history) is our systems glue.
- **One-shot vs agent depth** — `tools`/`noTools` + `tool_call{block}` are the enforcement levers; the depth *policy* (§6) is ours.
- **Memory** — AGENTS.md loader + `appendEntry` persistence exist; the *recall* policy is ours.

**Mandates (from the audit):**
- pi is **pre-1.0 (0.80.2), fast-moving.** Pin pi to an **exact version** and isolate **every pi type behind our brain adapter** — non-optional.
- Our §5 `proposal`/`agent_action` events are **our semantic layer**; pi emits `AgentSessionEvent`. The adapter maps pi→our events.
- `ExtensionAPI` is shaped for an interactive coding-agent TUI; our public plugin contract is a **curated, shell-oriented subset** we wrap and document — the loader is free, the clean contract is our design work.

**Entirely ours (pi-independent):** the PTY overlay and the deterministic router.

## 10. Resolved positions & residual risks

Every question below is **decided** — no ambiguity left. What stays genuinely uncertain is flagged as residual risk to *watch*, not a choice to re-litigate.

**Decided:**
- **Resolution-table sync.** Build the table at overlay startup from `$PATH` + the shell's alias/function/builtin tables; **refresh on shell hooks** (`precmd`/`preexec` or equivalent) whenever an alias/function is defined or `$PATH` changes. In the sub-second window before a just-defined name is picked up, an unrecognized token routes to **intent** (recoverable) rather than erroring — graceful by construction.
- **Latency budget.** Hard target: **Enter→route decision < 1 ms** — imperceptible, far under the shell's own fork+exec. Build pure **Bun** first, profile against this budget, and drop the inner loop to **C via FFI only if the budget is missed.** A measured gate, not a guess.
- **Agent-depth misclassification.** Accepted and bounded: auto-detect default + cue/key overrides for determinism + one-key correction when wrong. Never a hard failure.
- **Context privacy.** Decided (§7): **redact + cap** before any shell context leaves the machine.
- **Confirm / safety.** Decided (§5): configurable, default non-invasive (plain Enter runs), opt-in destructive-guard.
- **Bun vs pi's npm/Node toolchain.** pi is consumed as prebuilt MIT packages (runs under Bun); we *build* only our own code with Bun.

**Residual risks (watch — already mitigated as far as they can be):**
- **pi API churn.** pi is pre-1.0 and changes within hours. Reduced, not removed, by pinning an exact version and isolating every pi type behind the brain adapter (§9.5). Treat upstream bumps as deliberate migrations.
- **Live-PTY execution glue.** Binding `BashOperations` to a persistent shared shell (cwd/env/history surviving across commands) is the hardest bespoke piece — the seam exists, the systems work is ours.
- **Moat.** The novelty is the *insight* (resolution routing + pluggable pi brain), not the code — butterfish is ~2 changes away. Accepted: built first as a tool we want daily; defensibility is secondary.

---

## 11. Stack & rules
- **Bun only** for all JS/TS we write (no npm/yarn/pnpm). pi packages consumed as-is.
- **Plain C** only where measured-necessary for the hot path, via Bun FFI.
- **MIT-compatible** throughout (pi is MIT; butterfish is MIT reference — learn design, don't copy non-permissive code).
- No secrets/telemetry embedded. Permissive licenses only for new deps.
