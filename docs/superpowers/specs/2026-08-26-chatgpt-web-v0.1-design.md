# dsh-chatgpt-web v0.1 Design

Date: 2026-08-26

## Status

Approved architectural design for the first standalone release of `dsh-chatgpt-web`.

This repository is intended to behave like an independent DSH Market plugin rather than a package embedded inside another suite. `nishi-dsh-suite` may consume it later, but it is not part of the runtime boundary for v0.1.

## Goal

Provide a native DeepSeek Harness primary-model provider backed by the user's ordinary authenticated ChatGPT Web session, without requiring an OpenAI API key, OpenAI Platform credits, or Secure MCP Tunnel.

The user interacts only with native DSH chat. DSH sends model turns through a localhost browser bridge to a Chrome extension, the extension drives a managed `chatgpt.com` conversation, and the assistant response streams back into DSH as normal `StreamChunk` output.

## Non-goals for v0.1

v0.1 intentionally does not implement:

- DSH tool calls from ChatGPT.
- Subagent delegation or autonomous supervision loops.
- Git/GitHub review loops.
- A managed or headless browser runtime.
- Automatic installation of the Chrome extension.
- Reading, importing, listing, or searching the user's existing ChatGPT conversations.
- OpenAI API authentication, API billing, MCP Secure Tunnel, or ChatGPT connector APIs.
- GitHub Actions or other CI workflows.

Those are follow-up features, not partial v0.1 requirements.

## User-facing model

The plugin registers one text-only DSH provider/model pair:

```text
provider: chatgpt-web
model:    auto
```

The expected user flow is:

```text
install DSH plugin
      ↓
load bundled Chrome extension once
      ↓
run dsh web
      ↓
select chatgpt-web/auto
      ↓
use normal DSH chat
```

There is no separate `node bridge.mjs` process in the production plugin. The DSH plugin owns the localhost bridge lifecycle.

## Distribution and package shape

The repository is a standalone npm package and DSH bundle.

Target layout:

```text
dsh-chatgpt-web/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── adapter.ts
│   ├── bridge-server.ts
│   ├── session-manager.ts
│   ├── request-queue.ts
│   ├── transport.ts
│   └── protocol.ts
├── extension/
│   ├── manifest.json
│   ├── service-worker.js
│   ├── content-script.js
│   └── chatgpt-page-adapter.js
├── test/
├── docs/
├── README.md
└── LICENSE
```

The package declares a DSH bundle through its `dsh.bundle` manifest and includes the built runtime plus the Chrome extension in the published package.

Development install should support the normal local bundle workflow:

```bash
dsh plugin --profile web add .
```

The intended published install is:

```bash
dsh plugin --profile web add dsh-chatgpt-web
```

The extension is loaded manually from the installed package in v0.1. The plugin must expose or log the exact extension directory so the user does not need to discover it manually.

## High-level architecture

```text
DSH native chat
     │
     ▼
chatgpt-web/auto
     │
     ▼
ChatGptWebAdapter
     │
     ├── SessionManager
     ├── RequestQueue
     └── ChatTransport
             │
             ▼
       BridgeServer
       127.0.0.1 only
             │
             │ WebSocket
             ▼
       Chrome extension
             │
             ▼
       one worker tab
             │
             ▼
        chatgpt.com
```

The browser implementation is deliberately hidden behind a transport boundary so a future managed/headless Chromium backend can be added without rewriting the DSH adapter.

A representative interface is:

```ts
interface ChatTransport {
  generate(request: GenerateRequest): AsyncIterable<TransportEvent>
  abort(requestId: string): Promise<void>
}
```

v0.1 implements `ExternalChromeTransport`. A later release may add `ManagedChromiumTransport`.

## Conversation ownership

Each DSH session maps to exactly one managed ChatGPT conversation:

```text
DSH session A → managed ChatGPT conversation A
DSH session B → managed ChatGPT conversation B
DSH session C → managed ChatGPT conversation C
```

The extension creates managed conversations automatically on the first turn of a DSH session. There is no separate "create chat" button.

The plugin must never enumerate or inspect the ChatGPT sidebar to discover conversations. It must never import personal existing conversations. It may only navigate to conversation URLs that were created by this plugin and stored in its own mapping.

## Worker-tab model and concurrency

v0.1 uses one dedicated ChatGPT worker tab for the whole plugin.

The worker tab navigates between managed conversation URLs as DSH sessions change. Only one generation may be active at a time. Concurrent DSH generation requests are serialized by a FIFO request queue.

This restriction is intentional for v0.1 because it simplifies DOM ownership, completion detection, abort semantics, and recovery. A future version may introduce a worker pool.

## Canonical history and synchronization

DSH is the source of truth for conversation history.

The ChatGPT managed conversation is a provider-side conversational cache, not durable canonical state.

Normal turns must not resend the whole DSH transcript. The provider tracks synchronization metadata and sends only the history suffix that is not already represented in the managed ChatGPT conversation.

A representative state object is:

```ts
interface SessionState {
  dshSessionId: string
  conversationUrl?: string
  syncedMessageCount: number
  syncedHistoryHash?: string
  status: 'new' | 'ready' | 'busy' | 'uncertain'
}
```

The provider must not resend ChatGPT's own assistant output back to ChatGPT on normal continuation turns.

If a managed conversation is lost or unavailable, the provider creates a new managed conversation and rehydrates it from canonical DSH `system + messages` history.

## DSH context representation in ChatGPT Web

The ChatGPT Web composer does not expose a true DSH system-role API. Therefore the provider carries DSH instructions as explicit bridge context in the managed conversation.

For a new or rehydrated managed conversation the logical payload is equivalent to:

```text
[DSH BRIDGE CONTEXT]

System instructions:
<DSH system>

Conversation/context not yet present in this ChatGPT conversation:
<required unsynced history>

Current user message:
<current turn>

Respond only to the current DSH turn.
```

This transport envelope is internal. DSH remains authoritative for the actual system instruction and transcript.

## Local bridge protocol

The localhost WebSocket protocol is versioned from the beginning.

Every message carries:

```json
{
  "protocol": "dsh-chatgpt-web-v1",
  "type": "...",
  "requestId": "req_...",
  "sessionId": "dsh-session-..."
}
```

Representative plugin-to-extension messages:

- `generate`
- `abort`
- `open-session`
- `reset-session`
- `ping`

Representative extension-to-plugin messages:

- `hello`
- `session-ready`
- `generation-start`
- `delta`
- `generation-complete`
- `generation-aborted`
- `error`
- `pong`

`generation-complete` contains the authoritative full assistant text even when streaming deltas were emitted earlier.

Events must be associated with the exact `requestId`. Stale or unknown request IDs are rejected rather than merged into the active turn.

## Request lifecycle and idempotency

Each request has an explicit state machine:

```text
queued
  ↓
navigating
  ↓
ready
  ↓
sent
  ↓
generating
  ↓
completed

alternate terminal states:
aborted
uncertain
failed
```

The critical retry boundary is `sent`.

Before Send, an operation may be retried if the failure is known to have occurred before submission.

After Send, automatic resend is forbidden. If the bridge, extension, tab, or browser fails after submission and the plugin cannot prove whether ChatGPT accepted the turn, the operation becomes `uncertain` and fails visibly.

This is required even though v0.1 is text-only because future tool calls would make duplicate turns unsafe.

## Streaming semantics

The extension emits append-only text deltas when it can prove an append relationship to the previous accepted DOM snapshot.

ChatGPT may rewrite rendered markdown during generation. The transport therefore treats live deltas as optimistic realtime output and the final `generation-complete.text` snapshot as authoritative.

The extension must filter transient ChatGPT UI state such as `Thinking` / `Думаю` and must not expose it as assistant content.

If ChatGPT rewrites already emitted content, the extension should avoid noisy mid-stream replay. It may pause delta emission until the DOM becomes append-compatible again. The final snapshot remains the source of truth.

## DSH adapter contract

`ChatGptWebAdapter` extends the DSH LLM adapter abstraction and implements the normal provider surface:

- `providerInfo()`
- `listModels()`
- `resolveModel()`
- `stream(options)`

For v0.1 the provider exposes one text-only model: `chatgpt-web/auto`.

The adapter converts transport events to ordinary DSH `StreamChunk` output:

```text
generation-start
→ block-start(text)

delta
→ text-delta

generation-complete
→ block-end(text)
→ finish(stop)
```

The DSH UI and agent loop should not need browser-specific knowledge.

If DSH supplies a tool catalog in `GenerateOptions.tools`, v0.1 does not expose those tools to ChatGPT and does not emit tool-call blocks. Tool support is a v0.2 feature.

Request fields that cannot be meaningfully represented by ChatGPT Web should either be ignored only when doing so is semantically harmless or fail with a clear `UNSUPPORTED`-style error. The implementation plan must identify those fields explicitly rather than silently dropping arbitrary generation controls.

## Abort behavior

`GenerateOptions.signal` is propagated to the browser transport.

On abort:

```text
DSH AbortSignal
    ↓
adapter.abort(requestId)
    ↓
bridge `abort`
    ↓
extension
    ↓
ChatGPT Stop generation
```

The extension must only stop the currently associated generation. It then reports `generation-aborted`.

The request is terminal after abort and is never automatically replayed.

## Browser DOM boundary

All ChatGPT-specific DOM logic lives in one extension module, `chatgpt-page-adapter.js`.

Its public responsibilities are conceptually:

```ts
isReady()
createConversation()
openConversation(url)
sendMessage(text)
observeGeneration()
stopGeneration()
getConversationUrl()
```

The provider runtime, protocol layer, queue, and session manager must not contain ChatGPT CSS selectors.

Selectors should prefer semantic attributes such as roles, ARIA labels, IDs, and `data-testid` values over brittle layout-based selectors.

The implementation is based on the behavior validated by the browser spike through v0.0.8: composer fill, automatic Send, completed reply capture, clean streaming, transient-status filtering, and final authoritative snapshot.

## Persistent state

The plugin stores only operational mapping and synchronization metadata, for example:

```json
{
  "version": 1,
  "sessions": {
    "abc123": {
      "conversationUrl": "https://chatgpt.com/c/...",
      "syncedMessageCount": 7,
      "status": "ready"
    }
  }
}
```

The implementation should use an appropriate DSH/plugin or OS data directory rather than a hardcoded user path.

The plugin must not persist:

- ChatGPT cookies.
- OpenAI session tokens.
- Full copies of DSH transcripts.
- Personal ChatGPT conversations.
- Separate durable assistant-history storage.

## Bridge security

The bridge binds only to loopback:

```text
127.0.0.1
```

It must never bind to `0.0.0.0` by default.

The WebSocket handshake validates the browser `Origin` and accepts only the expected Chrome extension origin.

The extension uses a stable ID mechanism so the expected origin is deterministic. A manifest public key may be used for this purpose; it is not a secret.

The bridge exposes no shell, filesystem, browser-cookie, generic HTTP proxy, or arbitrary command endpoint.

For v0.1 the only trusted browser-to-provider data categories are:

- protocol/status events;
- managed conversation URL;
- assistant text deltas;
- final assistant text;
- explicit errors.

DOM content is not an authorization channel for future DSH actions.

## Extension permissions and privacy

The extension is scoped to `https://chatgpt.com/*` plus the localhost bridge origin required for communication.

It does not enumerate or inspect personal existing conversations. It does not scan the ChatGPT sidebar. It operates only on the dedicated worker tab and plugin-created managed conversation URLs.

v0.1 uses the user's normal authenticated ChatGPT Web session. The plugin does not read or copy raw login credentials or authentication tokens.

## Testing strategy

Testing is local and repository-driven. The project must not add GitHub Actions or CI configuration.

### Protocol unit tests

Test without Chrome:

- generate → delta → complete;
- abort;
- disconnect before Send;
- disconnect after Send → `uncertain`;
- wrong request ID;
- duplicate/out-of-order event handling;
- invalid protocol version.

### DSH adapter tests

Use a fake `ChatTransport` to verify:

- transport delta → DSH `text-delta`;
- final result → `block-end` + `finish`;
- `AbortSignal` → transport abort;
- queue serialization;
- session mapping behavior;
- unsupported request-field behavior.

Most provider logic must be testable without a browser.

### Extension DOM tests

Use local HTML fixtures for:

- composer detection;
- send button detection;
- stop button detection;
- assistant body extraction;
- filtering `Thinking` / `Думаю`;
- append-only delta calculation;
- managed conversation URL extraction.

### Live smoke test

A manual or explicitly opt-in local smoke test may exercise:

```text
DSH
→ chatgpt-web/auto
→ real Chrome
→ real chatgpt.com
→ "Respond exactly BRIDGE_OK"
→ DSH receives BRIDGE_OK
```

It must not run as part of ordinary unit tests.

## v0.1 acceptance criteria

v0.1 is accepted when all of the following work on the user's local DSH installation:

1. Install the standalone plugin.
2. Load the bundled Chrome extension manually.
3. Start `dsh web`.
4. Select `chatgpt-web/auto`.
5. Create DSH session A.
6. Send a prompt.
7. The plugin automatically creates managed ChatGPT conversation A.
8. The answer streams natively in DSH.
9. Send a second prompt in session A.
10. The same managed ChatGPT conversation A is reused.
11. Create DSH session B.
12. A separate managed ChatGPT conversation B is created.
13. Switch back to session A.
14. Conversation A is reused.
15. Cancel a generation from DSH.
16. ChatGPT generation stops.
17. Restart DSH.
18. Session mappings survive restart.
19. Existing personal ChatGPT conversations were never enumerated, imported, or inspected.
20. No OpenAI API key, Platform credits, or Secure MCP Tunnel are required.

## Future direction

The architecture intentionally leaves room for later releases:

```text
v0.1  text + streaming + managed conversations + abort
v0.2  validated native DSH tool-call bridge
v0.3  continuable subagent/autonomous supervision loop
v0.4  managed/headless Chromium transport
```

A future managed browser must use a dedicated browser profile rather than the user's normal Chrome profile. The expected shape is a plugin-managed `user-data-dir`, one-time visible login, followed by optional headless operation.

## Architectural invariants

The implementation must preserve these invariants:

1. DSH owns the agent loop and durable conversation history.
2. ChatGPT Web is the model transport, not a second orchestration engine.
3. One DSH session maps to one plugin-created ChatGPT conversation.
4. Existing personal ChatGPT conversations are outside the plugin's scope.
5. One worker tab and one active generation are allowed in v0.1.
6. No automatic retry occurs after a prompt may have been sent.
7. Browser DOM specifics stay isolated from the DSH adapter.
8. The final assistant DOM snapshot is authoritative over optimistic streaming deltas.
9. The localhost bridge is loopback-only and origin-restricted.
10. v0.1 is text-only; tools are deferred rather than partially emulated.
11. The package is independently installable as a DSH Market-style plugin.
12. The project does not use GitHub Actions or CI workflows.
