# Trac Contract Example — Agent Notes

## Overview of Current Code

- This repo demonstrates a minimal Trac Network app that pairs a Protocol with a Contract and injects off-chain data via Features (oracles). It can run as a terminal app or as a desktop App3 via Pear.
- The core directories are:
  - `contract/` — the Protocol (`protocol.js`) and Contract (`contract.js`) pair.
  - `features/` — example Feature(s), e.g., a timer oracle.
  - `src/` — app bootstrap helpers and lifecycle (`app.js`, `functions.js`).
  - `index.js` — entry wiring MSB + Peer + Protocol + Contract + Features.
  - `index.html`, `desktop.js` — minimal App3 desktop view (shows wallet key).

### Runtime Flow

- `index.js` constructs an MSB config (testnet, gasless), then a Peer config that binds the Protocol and Contract and exposes TX/MSG APIs. It passes a `Timer` Feature in the features list and starts the app.
- `src/app.js` starts the MSB, then the Peer with a fresh Wallet. If this peer is the admin (matches `admin` in the base and writable), it instantiates and attaches registered Features via `peer.protocol_instance.addFeature(name, obj)` and starts them. Finally it enables interactive mode.
- Desktop mode (`index.html` + `desktop.js`) waits for app readiness and renders the wallet public key.

### Protocol (contract/protocol.js)

- Extends `Protocol` from `trac-peer`.
- Adds custom API in `extendApi()` (e.g., `getSampleData`).
- Maps terminal/API TX commands to contract invocations in `mapTxCommand()`:
  - Literal `'something'` → `storeSomething` (no payload).
  - JSON `{"op":"do_something","some_key":"..."}` → `submitSomething` with payload.
- Implements a sample custom terminal command `/print --text "..."` in `customCommand()`.

Note: `safeJsonParse()` can return `undefined`; `mapTxCommand()` should guard `json && json.op === 'do_something'` to avoid TypeError on invalid JSON.

### Contract (contract/contract.js)

- Extends `Contract` from `trac-peer` and registers:
  - `storeSomething` — no payload; logs existing value and stores one if absent.
  - `submitSomething` — strictly schema-validated. Demonstrates `safeBigInt`, decimal conversions, `safeClone`, `safeJsonStringify/Parse`, and `assert` checks.
- Feature handler `timer_feature` validates a loose schema and stores `currentTime` injected by the timer into contract storage.
- `messageHandler` logs chat messages; can be used to enrich state from chat.
- Strong guidance to keep contract deterministic: no randomness/HTTP/throws/try-catch/heavy compute; do writes at end.

### Feature (features/timer/index.js)

- `Timer` extends `Feature` and periodically calls `append('currentTime', Date.now())` then sleeps. The contract’s `timer_feature` stores/updates `currentTime`.

### Configuration and Helpers

- `src/functions.js` derives a store path from Pear/Node args (looks at `process.argv[27]` for Pear JSON flags, `--user-data-dir=...`, then `process.argv[2]`). Throws if none provided.
- `index.js` re-exports `trac-peer/src/functions.js`. This reaches into a dependency’s internal `src` path, which may be fragile.

### Additional Observations

- Ready state: `App` extends `ready-resource` but doesn’t override `_open()`. `app.ready()` resolves (no-op open) while `index.js` explicitly awaits `app.start()`. Consider tying startup into `_open()` if you want `ready()` to reflect MSB+Peer readiness.
- Feature naming: Contract registers `'timer_feature'` while app registers Feature `'timer'`. Based on comments, the framework likely maps `<name> -> <name>_feature`. Ensure this convention stays consistent in `trac-peer`.
- `getStorePath()` is practical for Pear, but brittle outside it; consider a more defensive parser if broader environments are expected.


## What We’re Going To Build — P2P AI Chat Oracle

Goal: A P2P terminal app where a single shared AI agent (public context) responds in the chat when tagged with `@ai`. The AI is backed by a local REST endpoint acting as a Feature (oracle). The Contract enforces ordered processing and per-user rate limits.

- Single shared AI context: One public context for the channel, visible to all participants; the AI answers in public and responds to the tagger’s user ID.
- Trigger: Only when a message contains `@ai`. The system extracts the prompt from the message following the tag.
- Ordering: Contract processes chat messages in strict sequence and queues them for the AI feature to handle in order.
- Rate limits: Per user
  - 10 prompts per 60 seconds (sliding window with 10 recent timestamps)
  - 1500 prompts per day (resets per UTC day)
  - Uses the existing time feature (`currentTime`) as the trusted clock.
- Model: Local ChatGPT OSS 120B at `http://127.0.0.1:8000/v1/chat/completions` with model name `gpt-oss-120b-fp16`.
- Context: Up to 32768 tokens. We’ll trim with a rolling summary plus the latest exchanges, using `@dqbd/tiktoken` for token counting.

### Architecture

- Inbound path (chat → contract):
  1. `messageHandler` is invoked for each chat message in deterministic order.
  2. If message contains `@ai`, the contract:
     - Increments a global monotonic `message_seq` and assigns it to the message.
     - Enforces per-user rate limits against `currentTime`.
     - If allowed, enqueues the message under `chat/pending/<seq>` with user id, timestamp, and text.
- Oracle path (contract → feature → model):
  1. An `AiOracle` Feature (admin-only) periodically scans for the next `chat/pending/<seq>`.
  2. It builds the prompt from:
     - The global rolling summary stored in contract (e.g., `ai/summary`),
     - A trimmed tail of recent exchanges (see Context Management below),
     - The current user’s prompt after `@ai`.
  3. It tokenizes with `@dqbd/tiktoken`, enforces a token budget for the model’s 32k context, and trims accordingly.
  4. It calls the local REST endpoint and gets the AI completion.
  5. It posts the AI reply back to the public chat (using the exposed message API) and references the tagger.
  6. It updates the rolling summary kept in contract.

### Contract Changes (deterministic, minimal state)

- Keys (illustrative):
  - `currentTime` — from timer feature (already present).
  - `message_seq` — last processed sequence number (monotonic counter).
  - `chat/pending/<seq>` — queued messages awaiting AI processing (small payloads).
  - `ai/summary` — compact rolling summary (short text).
  - Rate limiting per user:
    - `rl/day/<user>/<dayKey>` → integer count [0…1500].
    - `rl/last3/<user>` → JSON of up to the last ten timestamps (ms) for a sliding 60s window.
- Ordered processing:
  - On each `messageHandler` call, read `currentTime`, increment `message_seq`, write `chat/pending/<seq>`.
  - No HTTP calls or heavy computation; keep entries small and writes at the end of handler.
- Rate limiting logic:
  - Day key: `dayKey = floor(currentTime / 86400000)`.
  - 60s sliding window: maintain an array of up to 10 timestamps; allow if fewer than 10 or if `currentTime - oldest >= 60000`; then push current and trim to last 10.
  - Increment daily counter if allowed; reject otherwise (do not enqueue).

### Feature: AI Oracle (REST)

- Runs only on admin peers (like the timer) and is attached with `addFeature('ai_feature', obj)`.
- Loop:
  - Check the next unprocessed `chat/pending/<seq>` (by reading `message_seq` and scanning forward where necessary).
  - Build prompt context:
    - `ai/summary` (short),
    - A bounded number of recent Q/A from storage (e.g., `chat/history/<seq>` if kept, or pulled from a compact ring),
    - The user’s new prompt.
  - Use `@dqbd/tiktoken` to count tokens and trim to fit under 32768; reserve a headroom for the model’s output.
  - POST to `http://127.0.0.1:8000/v1/chat/completions` with `model: 'gpt-oss-120b-fp16'` and the messages array.
  - Publish AI reply to public chat via the exposed message API and mention the tagger.
  - Update `ai/summary` by summarizing `(previous summary + latest exchange)` down to a small fixed size; store back in contract.
  - Mark queue item as processed (e.g., delete `chat/pending/<seq>` or move to `chat/done/<seq>`).

### Context Management

- Token budget: 32768 tokens total; reserve budget for the reply (e.g., 1024–2048 tokens) and for system/preamble instructions.
- Prompt composition order:
  1. Short system prompt (role: system): instructions (e.g., “Respond concisely, public context”).
  2. Short rolling summary (role: system or user-tagged as context).
  3. Last N turns (user/assistant) until the token budget nearly fills.
  4. Current user request (role: user).
- Rolling summary:
  - Keep an aggressively small summary (e.g., < 1–2 KB) stored in contract.
  - Summarization can be done by the same local model in a dedicated summarization call.

### Rate-Limiting Details

- Per minute: Sliding window of the last 10 timestamps per user. Allows 10 prompts in any 60-second period. Implemented by keeping at most 10 timestamps and comparing `currentTime - oldest`.
- Per day: Counter under `rl/day/<user>/<dayKey>` up to 1500. Resets automatically by keying on day.
- All time reads come from `currentTime` in contract (updated by the timer feature). We may tune the timer interval (e.g., 1s–5s) for better precision.

### Configuration Knobs

- Timer update interval (precision vs. churn): default is 60s; for rate limits, set to ~1s to 5s.
- AI endpoint URL and model name.
- Output token budget and trim headroom.
- Maximum retained recent exchanges (for context tail).

### Risks and Considerations

- Contract storage growth: Keep only minimal metadata and a compact summary; avoid storing full chat logs.
- Ordering and idempotency: Ensure the oracle processes each `seq` exactly once; handle duplicates gracefully.
- API availability: Local model endpoint must be reachable from the Feature; handle backoff and transient failures.
- Consistency: Only the admin peer runs the oracle; others observe the same deterministic state and chat outputs.

### Milestones (no code yet)

1. Define contract keys and rate-limit logic (spec-level).
2. Define AI oracle Feature interfaces and message queue semantics.
3. Define prompt template, token budget policy, and summarization procedure.
4. Wire sending of chat replies via exposed message API.
5. Test end-to-end locally in terminal mode; adjust intervals and budgets.

## Pear Desktop UI Plan (no code yet)

Goal: Ship a usable Pear Desktop UI for the P2P AI chat so users can view the timeline, send messages (including @ai), see status, and (for admin) run diagnostics and controls — without touching the terminal.

Scope (MVP)
- Single-window chat with: message list, input composer (mentions), send button, and status bar.
- Read-only indicators: wallet/public key, admin/writable status, features loaded, chat status, backlog counters.
- Admin-only panel: enable/disable chat, auto-add writers toggle, diagnostics shortcuts (/diag_*), safe fast-forward.
- Settings modal: AI endpoint, model, and optional API key (local-only; do not persist on-chain).

Architecture
- Tech: Keep existing ESM + React + htm; extend `desktop.js` to render a `ChatApp` component tree.
- Data sources:
  - Peer/API: `peer.protocol_instance.api` for sending messages (`prepareMessage` + `post` + signing), `getNick` for display names.
  - Contract view keys (poll or subscribe): `message_seq`, `process_seq`, `chat/pending/<seq>`, `chat/done/<seq>`, `ai/summary`, `chat_status`, `auto_add_writers`.
- State model: `useReducer` store with slices for connection, timeline, composer, admin, and settings; periodic refresh (e.g., 1s) with backoff.

Packaging
- Follow the reference example conventions:
  - In `package.json`, switch Pear desktop entry by setting `main` to `index.html` (desktop) instead of `index.js` (terminal).
  - In the `pear` section, set `type` to `desktop` (use `terminal` for CLI).
  - Run with developer console using `pear run -d . <store>` during development.
  - Ensure `index.html` includes `<pear-ctrl>` and boots `desktop.js` as module (already present in this repo).

Components
- StatusBar: wallet short address, admin/writable badges, feature list, quick health (backlog, next seq).
- MessageList: virtualized list combining user posts and AI replies (read `chat/done/<seq>` for Q/A pairs; show pending while inflight).
- Composer: text input with mention helper; hitting Enter sends via `api.prepareMessage` and `api.post`.
  - Check `api.msgExposed()` before sending; show actionable error if messaging API is disabled.
- AdminPanel (visible if admin && writable):
  - Toggles: `/set_chat_status --enabled 0|1`, `/set_auto_add_writers --enabled 0|1`.
  - Diagnostics: buttons that trigger `customCommand` for `/diag_state`, `/diag_rl --user <addr>`, `/diag_inflight`, `/diag_ping`.
  - Unstick helper: `/fix_fast_forward [--seq n]` with confirmation.
- SettingsModal: edit endpoint/model/API key header/scheme; apply immediately to in-memory `ai_opts` if running on admin, else save locally and surface guidance.

User Journeys
- Non-admin: launch app, sees timeline, composes messages and `@ai` prompts, sees replies; health indicators visible; admin actions hidden.
- Admin: same as above plus toggles and diagnostic buttons; can resolve stalls via Fast-Forward.

Diagnostics Integration (TEMP)
- Mirror terminal commands via `protocol.customCommand()` calls. Render outputs in a collapsible pane.
- Show live counters derived from view keys: `message_seq`, `process_seq`, `backlog`, `next_pending_key`.
- All TEMP UI clearly labeled to remove later with the corresponding commands.

Resilience & Edge Cases
- If not admin or base not writable, show banner that features are offline on this peer; degrade gracefully to read/send only.
- If AI endpoint returns 401, surface a clear prompt to set API key (without logging the secret).
- Guard against duplicate sends; show optimistic pending bubble and clear on `process_seq` advance.

Security & Safety
- Never log API keys; store locally (Pear storage) only if the user opts in.
- Admin actions require admin address match and writable base; otherwise disabled.
- Prevent `@ai` self-trigger loops by preserving the existing `ai-reply` attachment guard.

Milestones
1) Wire peer binding and state polling; render StatusBar with live pointers.
2) Render MessageList from `chat/done/<seq>` and show basic items.
3) Implement Composer and send flow (sign + post); support `@ai` mentions.
4) Add AdminPanel toggles and diagnostics buttons; read outputs.
5) Add SettingsModal for AI endpoint/auth; apply on admin peer when possible.
6) Polish: virtualized list, scroll-to-latest, small accessibility passes, empty states.
7) Packaging switch: update `package.json` for Pear Desktop (`main` and `pear.type`), verify `pear run -d . <store>` works.

Acceptance Checks
- Can see wallet/admin state and backlog counters update in real time.
- Can send a message and see it appear; `@ai` produces a reply.
- Admin can toggle chat, run diagnostics, and fast-forward safely.
- 401 on `/diag_ping` is reflected with a clear hint to configure API key.

Removal Plan for TEMP UI
- Group all diagnostics and fast-forward into a `Developer` section; feature-flag via env or build guard for quick removal.
