# dsh-chatgpt-web v0.1 Implementation Plan

Date: 2026-08-26

> **Current status:** v0.1 implementation and manual browser acceptance are complete on `feat/v0.1-implementation`. The previously observed premature-completion bug has been resolved with a RED -> GREEN regression test. Full repository test, check, build, and pack dry-run have passed locally. The only remaining release gate is packed-install verification. The debugging timeline is preserved separately in `docs/2026-08-26-progress-and-debugging-log.md`.

> **Process rule:** all behavior changes use focused RED -> GREEN tests. Do not add GitHub Actions, CI workflows, or CI-only configuration.

## Goal

Ship a standalone DSH bundle that registers `chatgpt-web/auto`, owns a loopback WebSocket bridge on `127.0.0.1:8765`, drives only plugin-created ChatGPT Web conversations through a bundled Chrome extension, returns authoritative assistant text through the native DSH LLM adapter surface, supports abort/recovery, and preserves managed-conversation mappings across DSH restarts.

## Current architecture

```text
DSH native chat
  -> ChatGptWebAdapter
      -> SessionManager
      -> RequestQueue
      -> ExternalChromeTransport
          -> BridgeServer 127.0.0.1:8765
              -> Chrome MV3 service worker
                  -> content script
                      -> chatgpt-page-adapter
                          -> extension-owned chatgpt.com worker tab
```

DSH is the canonical transcript. Managed ChatGPT conversations are provider-side cache only.

Current stack:

- Node.js `^22.19.0 || >=24.0.0`;
- TypeScript ESM;
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`;
- `@deepseek-ai/cordis`;
- `ws`;
- `env-paths`;
- Chrome Manifest V3;
- `tsx --test`;
- `happy-dom`;
- local/manual browser verification only.

## Important deviations from the original plan

Several initial assumptions were invalidated by real ChatGPT Web behavior.

### 1. Wire protocol is smaller than originally planned

Plugin -> extension currently implements:

```text
generate
abort
ping
```

Extension -> plugin currently implements:

```text
hello
request-state
session-ready
delta
generation-complete
generation-aborted
error
pong
```

There are no separate `open-session`, `reset-session`, or `generation-start` wire messages. Navigation intent is carried on `generate.conversationUrl`, and progress is carried by `request-state`.

### 2. Browser deltas are no longer DSH text deltas

The original plan required browser `delta` -> DSH `text-delta`. Real second-turn testing showed ChatGPT/React can remount old assistant content, causing the previous answer to cross the browser boundary before the current final answer appears.

Current adapter contract:

```text
browser delta
  -> internal transport observation only

generation-complete(fullText)
  -> block-start(text)
  -> text-delta(fullText)
  -> block-end(fullText)
  -> finish(stop)
```

v0.1 therefore does not promise token-by-token DSH streaming.

### 3. Response target is structural, not “newest user-role message”

DSH runtime context can be appended as `role=user` plugin snapshots. Bridge prompts select the newest human-authored message using:

```text
message.role === 'user' && message.source.kind === 'user'
```

Later plugin/tool user-role messages remain context.

### 4. Transient ChatGPT `WEB:` routes are not managed URLs

`https://chatgpt.com/c/WEB:...` is a transient creation route and must not be persisted. The page adapter waits for a stable `/c/<id>` route.

## Completed implementation areas

The items below are implemented on the feature branch and have targeted tests, but final whole-suite verification is still required after all remaining changes.

### A. Installable DSH bundle

Current package contract:

- package name/version: `dsh-chatgpt-web@0.1.0`;
- ESM output under `lib/`;
- DSH bundle patch in `cordis.patch.yml`;
- bundled `extension/` directory;
- engine `^22.19.0 || >=24.0.0`;
- no `.github/workflows`.

Current development install:

```bash
dsh plugin --profile web add .
```

### B. Versioned protocol and FIFO queue

Implemented:

- `dsh-chatgpt-web-v1` validation;
- managed URL canonicalization;
- request ids and monotonic `seq`;
- `RequestQueue` one-owner FIFO semantics;
- queued abort removal and idempotent release.

### C. History synchronization and persistence

Implemented:

```ts
interface PersistedSessionState {
  conversationUrl?: string
  syncedMessageCount: number
  syncedPrefixDigest: string
  systemDigest: string
  status: 'ready' | 'uncertain'
}
```

State defaults to:

```ts
join(envPaths('dsh-chatgpt-web').data, 'state.json')
```

Implemented invariants:

- semantic SHA-256 history digest;
- source/message ids ignored for digest identity;
- images rejected;
- historical tool call/result content serialized as context only;
- atomic state writes;
- corrupt state fails closed;
- session mappings load across restart;
- only matching trusted prefixes continue incrementally;
- runtime plugin snapshots stay context and do not become the human response target.

### D. Loopback WebSocket bridge

Implemented:

- production host `127.0.0.1`;
- production port `8765`;
- exact deterministic Chrome extension Origin validation;
- one extension connection at a time;
- JSON protocol parsing;
- heartbeat;
- per-request `seq` validation;
- conservative uncertainty after silent disconnect once `generate` has been handed to the extension;
- explicit pre-Send extension errors can remain retry-safe.

### E. Native DSH adapter

Implemented:

- provider/model `chatgpt-web/auto`;
- `sessionId` required;
- unsupported `reasoningEffort`, `temperature`, `maxTokens`, `stop`, `purpose` rejection;
- tools accepted but not browser-callable;
- image rejection;
- authoritative-completion-only DSH output;
- empty completion -> `EMPTY_RESPONSE` + uncertain session;
- post-Send ambiguity -> `CHATGPT_WEB_UNCERTAIN`;
- abort without automatically replaying the request;
- one safe pre-Send missing-conversation recovery attempt;
- FIFO serialization.

### F. Chrome extension

Implemented:

- stable manifest public key / deterministic extension id;
- minimum current permissions (`tabs`, `storage`, ChatGPT + loopback hosts);
- extension-owned worker tab id in `chrome.storage.session`;
- no arbitrary ChatGPT tab/sidebar discovery;
- reconnect with exponential backoff + jitter;
- `sent` boundary forwarded before synchronous Send click;
- extension/content-script event serialization;
- stable managed URL reporting;
- abort path to ChatGPT Stop generation;
- DOM extraction and transient status filtering isolated in `extension/chatgpt-page-adapter.js`.

### G. DSH lifecycle assembly

Implemented:

- bridge startup during plugin apply;
- adapter registration on `chatgpt-web`;
- extension path log;
- expected extension Origin log;
- runtime disposal through Cordis effect cleanup.

### H. Development documentation and manual smoke harness

README/manual smoke/debug log exist. They must remain synchronized with the authoritative-completion-only behavior and current release blocker.

## Confirmed live-browser findings

The following are not hypothetical; they were observed during manual DSH/browser testing.

### Managed URL stabilization

Bad transient route:

```text
https://chatgpt.com/c/WEB:...
```

Stable route after fix:

```text
https://chatgpt.com/c/<persistent-id>
```

Same-session continuation can reuse the persistent managed URL.

### Runtime snapshot response-target bug

Observed payload contained:

```text
message 1 role=user: actual human request
message 2 role=user: DSH runtime-context plugin snapshot
```

The old instruction “Respond only to the newest DSH user turn” targeted message 2. Current prompts explicitly identify the newest human-authored DSH message and treat later plugin/tool user-role messages as context.

### Mutable browser delta bug

Observed on a second turn:

```text
browser/DSH streamed = первый
final browser answer = второй
```

This is why browser deltas are now internal only.

### Resolved historical finding: premature authoritative completion

Observed:

```text
ChatGPT eventually rendered: Хорошо 🙂 А у тебя как?
DSH received:              Хорошо 🙂
```

Previously, `observeGeneration()` resolved when:

```text
Stop button absent
AND text non-empty
AND text stable for 700 ms
```

The real example proved that condition was insufficient because ChatGPT could pause briefly before rendering the rest of the answer.

This issue has been resolved: semantic completed-response action controls (`data-testid="copy-turn-action-button"`, etc.) are now required in addition to Stop disappearing and stability.

## Completed Task 1: identify and implement stronger completed-turn signal

**Files:**

- `extension/chatgpt-page-adapter.js`
- `test/extension-page-adapter.test.ts`
- HTML fixtures under `test/fixtures/`

### Step 1. Gather real DOM evidence

Inspecting the real ChatGPT DOM confirmed that response action controls (including `button[data-testid="copy-turn-action-button"]`) appear only once the assistant turn has completed.

### Step 2. Write the RED regression before production changes

Added the regression test in `test/extension-page-adapter.test.ts`:
`"a false stable pause after Stop disappears does not complete before response actions appear"`.
Verified RED against the old adapter behavior.

### Step 3. Implement the smallest evidence-backed completion rule

Updated `extension/chatgpt-page-adapter.js` to check `responseActionsReady()` (`button[data-testid="copy-turn-action-button"]`) in `observeGeneration()`.

### Step 4. Run targeted verification

```bash
npx tsx --test test/extension-page-adapter.test.ts
```

Page adapter suite: 9/9 passing.

## Completed Task 2: complete the real-browser acceptance matrix

Manual browser acceptance has passed for all core scenarios:

1. first turn in session A (new managed ChatGPT URL created);
2. second and third turns in A (same managed URL reused);
3. DSH receives complete authoritative text without cut-off;
4. session B creates a distinct managed URL (`B_URL != A_URL`);
5. switch back to A navigates to and reuses `A_URL`;
6. runtime-context snapshot targeting preserves human prompt as response target;
7. cancellation / abort triggers ChatGPT Stop generation without replay, with intentional v0.1 safety semantics of marking the session uncertain so the next turn rehydrates into a fresh managed conversation;
8. DSH restart reuses ready session mappings and safely rehydrates uncertain sessions;
9. deleted/lost managed conversation safely recovers via fresh rehydration before Send;
10. personal ChatGPT chats remain untouched;
11. no OpenAI API key, Platform inference credits, or Secure MCP Tunnel required.

Canonical manual steps live in `docs/manual-smoke.md`.

## Completed Task 3: whole-repository verification

Fresh complete verification at doc-sync HEAD:

```fish
cd "$HOME/Проекты/dsh-chatgpt-web"; and npm test; and npm run check; and npm run build; and npm pack --dry-run
```

All 56 unit/integration tests, type checks, build, and package dry-run passed.

`package-lock.json` is evaluated separately before release.

## Remaining Task 4: packed-install verification

The single remaining release gate before publication:

```bash
npm pack
dsh plugin --profile chatgpt-web-smoke add ./dsh-chatgpt-web-0.1.0.tgz
dsh --profile chatgpt-web-smoke --dump-config
```

Verify the tarball installs without depending on the source checkout and the DSH bundle row/model `chatgpt-web/auto` appears.

Remove local tarballs after verification unless they are intentionally retained as release artifacts.

## Release gate

Status of release requirements:

- [x] authoritative completion no longer returns partial prefixes in real ChatGPT Web smoke;
- [x] multi-turn same-session reuse works through at least three turns;
- [x] session separation/switch-back works;
- [x] abort behavior works (with intentional uncertain -> fresh rehydration safety semantics);
- [x] restart persistence/recovery works;
- [x] missing managed chat recovery works;
- [x] personal chats remain untouched;
- [x] full `npm test` passes (56/56);
- [x] `npm run check` passes;
- [x] `npm run build` passes;
- [x] `npm pack --dry-run` passes;
- [ ] packed-install verification (`dsh plugin add ./dsh-chatgpt-web-0.1.0.tgz`);
- [x] no GitHub Actions/CI was added;
- [x] no API key, Secure MCP Tunnel, or Platform inference dependency was introduced.

## Future work outside v0.1

```text
v0.2  validated native DSH tool-call bridge
v0.3  continuable subagent/autonomous supervision loop
v0.4  optional managed/headless Chromium transport
```

Reliable incremental browser-to-DSH streaming is not a v0.1 requirement anymore. Reintroduce it only through a separate design that proves current-turn identity and append-only emission under React DOM remount/rewrite behavior.
