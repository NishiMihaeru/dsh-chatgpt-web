# dsh-chatgpt-web v0.1 — implementation and debugging log

Date: 2026-08-26

Status: **work in progress; do not merge/release yet**

This document records the architecture decisions, implementation work, experiments, bugs, test evidence, and live browser debugging performed while building `dsh-chatgpt-web` v0.1.

The goal is to preserve enough context that work can resume without reconstructing the entire debugging history from chat logs.

---

## 1. Goal

Build a standalone DeepSeek Harness (DSH) plugin that uses an ordinary logged-in ChatGPT Web session as the model provider.

Core constraint:

- no OpenAI API key;
- no OpenAI Platform inference billing;
- use the normal `chatgpt.com` browser session;
- DSH remains the primary UI and orchestration runtime.

Target direction:

```text
DSH native chat
  -> chatgpt-web LLM Adapter
      -> local bridge
          -> Chrome extension
              -> chatgpt.com ordinary ChatGPT
```

Longer-term architecture:

```text
DSH native chat
  -> chatgpt-web LLM Adapter
      -> local bridge
          -> Chrome extension
              -> chatgpt.com ordinary ChatGPT
  -> DSH tool pipeline
      -> subagents / Git / GitHub
```

The intended roles are:

- ChatGPT: supervisor / architect / reviewer;
- DSH: orchestration kernel and single owner of the agent loop;
- subagent: implementer;
- Git/GitHub: canonical code state;
- DSH session log: canonical execution history;
- managed ChatGPT conversation: provider-side conversational cache, not the source of truth.

No second autonomous loop should live in the browser bridge.

---

## 2. Repository and branch

Repository:

```text
https://github.com/NishiMihaeru/dsh-chatgpt-web
```

Implementation branch:

```text
feat/v0.1-implementation
```

Main contains the approved design and implementation plan.

Important design/plan commits on `main`:

- design: `e24caac852a00b492196e9ef33d7146617fe83b6`
- implementation plan: `6aceb9cf125bbe29bd1c504d723a95040f0c0f3c`

Design document:

```text
docs/superpowers/specs/2026-08-26-chatgpt-web-v0.1-design.md
```

Implementation plan:

```text
docs/superpowers/plans/2026-08-26-chatgpt-web-v0.1-implementation.md
```

There are intentionally **no GitHub Actions / CI workflows** for this project.

---

## 3. MCP investigation and why it was not chosen

Before committing to the browser bridge, native ChatGPT custom MCP was tested on CachyOS.

A throwaway local MCP server was built with:

- Node `v22.23.2`;
- npm `12.0.2`;
- `@modelcontextprotocol/sdk@1.30.0`;
- Zod;
- Express;
- Streamable HTTP at `127.0.0.1:3457/mcp`.

The smoke test worked:

- initialize negotiated protocol `2025-06-18`;
- `tools/call` worked;
- a read-only ping returned `pong from CachyOS`.

However, the native ChatGPT MCP route was not selected for this project because it introduces OpenAI Platform / tunnel dependency and product-tier constraints for broader write-style tool use. The goal here is a standalone bridge that works with an ordinary logged-in ChatGPT Web subscription.

Important nuance: this conclusion is about the dependency/product shape, not a claim that every MCP tool invocation necessarily incurs OpenAI API inference billing.

Reference-only third-party project examined:

```text
jiezeng2004-design/dsh-chatgpt-bridge
```

That bridge goes in the opposite direction (ChatGPT Web -> MCP -> DSH) and does not make DSH call ChatGPT Web as its model provider.

---

## 4. Browser bridge spike — end-to-end feasibility proven

A throwaway sequence of browser-bridge spikes proved the core transport without API keys.

Architecture proven:

```text
terminal
  -> localhost WebSocket bridge
  -> Chrome extension
  -> chatgpt.com composer
  -> Send
  -> live assistant DOM observation
  -> extension
  -> bridge
  -> terminal
```

Bridge endpoint:

```text
ws://127.0.0.1:8765
```

Spike progression:

- v0.0.4: insert prompt text;
- v0.0.5: click Send automatically;
- v0.0.6: wait for and return final answer;
- v0.0.7: live DOM streaming;
- v0.0.8: cleaner extraction, transient `Thinking`/`Думаю` filtering, rendered answer extraction, debounce, authoritative final correction.

A clean smoke produced:

```text
========== ChatGPT stream ==========
1
2
3
4
5
6
7
8
9
10
========== complete ==========
```

This proved that ordinary ChatGPT Web could be driven end-to-end without:

- OpenAI API key;
- Secure MCP Tunnel;
- Platform API inference.

---

## 5. Local DSH environment used for integration

The active DSH install during development was:

```text
dsh --version = 0.1.1-rc.2
```

Global executable:

```text
$HOME/.local/bin/dsh
```

DSH rc.2 engine requirement:

```text
^22.19.0 || >=24.0.0
```

Local Node version used:

```text
22.23.2
```

The plugin was linked into the DSH web profile with:

```fish
cd "$HOME/Проекты/dsh-chatgpt-web" && dsh plugin --profile web add .
```

After installation, the model picker exposed:

```text
chatgpt-web/auto
```

The unpacked Chrome extension was loaded from:

```text
$HOME/Проекты/dsh-chatgpt-web/extension
```

After extension-source changes, the unpacked extension must be manually reloaded from `chrome://extensions`.

---

## 6. Approved v0.1 design

### 6.1 Scope

v0.1 intentionally focuses on the provider adapter only.

Included:

- one manual unpacked Chrome extension install;
- provider/model `chatgpt-web/auto`;
- built-in localhost WebSocket bridge;
- managed ChatGPT conversation per DSH session;
- queueing;
- abort support;
- persistence and recovery;
- browser extension bundled with the npm/plugin package.

Not included in v0.1:

- browser-callable DSH tools;
- subagent delegation through ChatGPT;
- Git/GitHub autonomous tool loop;
- `purpose=session-title` support;
- `purpose=compaction` support.

Those `purpose` calls are intentionally rejected so auxiliary DSH model calls cannot pollute the user's managed ChatGPT conversation.

### 6.2 Session mapping

Target invariant:

```text
1 DSH session = 1 plugin-created ChatGPT conversation
```

Rules:

- lazy creation on first message;
- reuse the mapped managed ChatGPT conversation;
- extension owns one dedicated worker tab;
- never hijack arbitrary personal ChatGPT tabs;
- switching DSH sessions navigates the worker tab to the corresponding managed conversation;
- only one active browser generation globally;
- requests are FIFO queued.

DSH is canonical. ChatGPT conversation state is only a provider-side cache.

### 6.3 Transport abstraction

The browser-specific implementation is hidden behind a transport abstraction so a later controlled-browser implementation can replace the current extension transport.

Conceptually:

```text
ChatTransport
  -> current Chrome extension transport
  -> future ManagedChromiumTransport
```

---

## 7. Protocol

Protocol name:

```text
dsh-chatgpt-web-v1
```

Plugin -> extension messages:

- `generate`
- `abort`
- `open-session`
- `reset-session`
- `ping`

Extension -> plugin messages:

- `hello`
- `request-state` / `state`
- `session-ready`
- `generation-start`
- `delta`
- `generation-complete`
- `generation-aborted`
- `error`
- `pong`

Messages use:

- `requestId`;
- `sessionId`;
- monotonic `seq`.

`generation-complete` carries the authoritative full assistant text.

Request lifecycle:

```text
queued -> navigating -> ready -> sent -> generating -> completed
                                      -> aborted
                                      -> uncertain
                                      -> failed
```

Retry safety invariant:

- before Send: retry can be safe;
- after Send: automatic resend is forbidden;
- silent disconnect after dispatch is conservatively uncertain;
- persisted `sent`/`generating` state on restart is uncertain;
- `CHATGPT_WEB_UNCERTAIN` must not be treated as an ordinary retryable provider failure.

---

## 8. Security / browser ownership decisions

The extension uses a stable manifest key so its Chrome extension ID is deterministic.

The local WebSocket bridge accepts only the exact expected origin:

```text
chrome-extension://<stable-extension-id>
```

This is an origin check, not cryptographic authentication. Same-user local processes are considered inside the trust boundary.

The extension:

- connects only to `ws://127.0.0.1:8765/`;
- owns one worker tab;
- does not scan and take over arbitrary sidebar chats;
- does not expose generic HTTP APIs;
- does not expose shell/filesystem/cookie access;
- operates only on `https://chatgpt.com/*`.

---

## 9. DSH rc.2 adapter contract verified

The implementation targets:

```text
@deepseek-ai/dsh-llm@0.1.1-rc.2
```

The adapter implements the rc.2 `LlmAdapter` contract and registers via:

```text
ctx.llm.registerAdapter(routes, adapter)
```

Important `GenerateOptions` fields observed:

- provider;
- model;
- messages;
- system;
- tools;
- reasoningEffort;
- temperature;
- maxTokens;
- stop;
- signal;
- sessionId;
- purpose.

v0.1 policy:

- provider must be `chatgpt-web`;
- model must be `auto`;
- `sessionId` is required;
- images fail with `CHATGPT_WEB_UNSUPPORTED_IMAGE`;
- explicit `reasoningEffort`, `temperature`, `maxTokens`, `stop`, and `purpose` are rejected as unsupported;
- historical tool call/result content can be serialized as rehydration context but browser tool calling is not implemented in v0.1.

DSH stream chunks used:

- `block-start`;
- `text-delta`;
- `block-end`;
- `finish`.

Empty authoritative completion uses canonical DSH code:

```text
EMPTY_RESPONSE
```

---

## 10. Persistence and canonical history

Persistent state shape:

```ts
interface PersistedSessionState {
  conversationUrl?: string
  syncedMessageCount: number
  syncedPrefixDigest: string
  systemDigest: string
  status: 'ready' | 'uncertain'
}
```

State is stored by default under `env-paths('dsh-chatgpt-web').data/state.json`.

Observed local path:

```text
$HOME/.local/share/dsh-chatgpt-web-nodejs/state.json
```

Persistence rules:

- atomic temp-write + rename;
- corrupt JSON fails closed;
- no cookies/tokens/transcripts are persisted;
- URL must canonicalize to `https://chatgpt.com/c/<id>`;
- transient `WEB:` conversation IDs are rejected.

History identity is based on deterministic normalized SHA-256 digests rather than DSH message IDs/source metadata.

A mapped conversation can be continued only when:

- state is `ready`;
- managed URL is valid;
- system digest matches;
- current history is at least as long as the synced count;
- synced prefix digest matches.

Otherwise the adapter creates/re-hydrates a fresh managed ChatGPT conversation from canonical DSH history.

---

## 11. Initial package/build verification

Before later debugging patches, a full local verification succeeded:

```text
npm test
npm run check
npm run build
npm pack --dry-run
```

At that point:

- tests: 51/51 passed;
- check passed;
- build passed;
- dry-run pack succeeded;
- package name/version: `dsh-chatgpt-web-0.1.0.tgz`.

Later regression tests and production changes were added, so **this old full-suite result must not be treated as fresh verification of the current branch**. A complete fresh run is still required before release.

`npm install` also reported one critical audit finding and blocked `esbuild@0.28.2` postinstall through npm `allowScripts`, but TypeScript/tsx build and tests still executed. Do not blindly run `npm audit fix --force`.

---

## 12. Runtime smoke: first end-to-end DSH turn

The first real DSH -> ChatGPT Web request succeeded.

Example request:

```text
Ответь одним словом: мост
```

Flow:

```text
DSH Web
 -> chatgpt-web adapter
 -> local bridge
 -> extension
 -> managed ChatGPT worker tab
 -> ChatGPT response
 -> DSH
```

This established that the real plugin path, not only the throwaway spike, was working.

---

## 13. Bug #1 — transient `WEB:` conversation URLs

### Symptom

The first turn worked, but every subsequent DSH message created a new ChatGPT conversation.

Persisted state contained URLs like:

```text
https://chatgpt.com/c/WEB:844a3154-d7da-4e73-a05c-8c565c9393a4
```

while the worker tab later settled on a persistent URL such as:

```text
https://chatgpt.com/c/6a8ef153-d03c-83eb-b977-e1d7c50cced2
```

### Root cause

ChatGPT temporarily exposes a `/c/WEB:...` route during conversation creation. The extension reported that transient route too early and the plugin persisted it. On the next turn navigation failed and safe recovery created a new conversation.

### TDD / fix

RED regression commit:

```text
5628ceaa23f7c1bc4187dc601fcea3f320855535
```

Production fix:

```text
9647dbfa12327051c1ff04292364f1c378ddceb6
```

Fix:

```text
getConversationUrl()
```

rejects IDs beginning with `WEB:` and waits until a persistent managed URL exists.

After the fix, first-turn state stored a normal persistent `/c/<id>` URL and same-chat continuation became possible.

---

## 14. Bug #2 — second turn streamed the previous answer

After fixing the URL, the same managed ChatGPT conversation was reused, but the second DSH turn failed with:

```text
CHATGPT_WEB_STREAM_REWRITE
```

Diagnostic evidence showed:

```text
streamed="первый"
final="второй"
```

This proved that stale text from the previous assistant answer crossed the extension -> DSH boundary as a live delta, while the authoritative final DOM later contained the correct current answer.

### Failed hypotheses / experiments

Several TDD experiments attempted to distinguish the new assistant DOM node from old/remounted content:

1. previous assistant turn mutation
   - RED: `8dcdfc8fb24aea78ba43307b8d7f8ec8e0df70a2`
   - production: `1f5d9c33bca2dac2d69579b4da55c8e7023194e0`

2. newly inserted assistant node temporarily cloned the previous answer
   - RED: `f45fb3fd057f0bf88f5df2a1ab1024b5cf707aad`
   - production: `539b963a4f7aa3bca69ccff321d48a0caf1a1407`

3. exact current-user-turn anchoring
   - diagnostic enhancement: `743c7624ef658ee67b75a0202aecb7b00497762b`
   - RED remount test: `5305fbff1df9d897f478d2c2a9c71272743a42f5`
   - page-adapter implementation: `be2ba259f86cc37e9299f97c6ecae588212ac680`
   - content-script integration: `e449f0a5e11b3df8924a3345d96842e3f5e61beb`

The exact-prompt anchoring idea introduced a new regression: generation could start but no matching current assistant turn was found.

### Rollback

The experimental DOM chain was deliberately rolled back to the stable content of commit:

```text
9647dbfa12327051c1ff04292364f1c378ddceb6
```

without rewriting branch history.

Rollback head after restoring identical file contents:

```text
b9cb8692540b888a163a70b9e91e314d06f1f423
```

A GitHub compare against `9647dbf` showed zero changed files, confirming that the branch content had been restored to the stable baseline while preserving the commit history.

Local targeted page-adapter test after rollback:

```text
tests 8
pass 8
fail 0
```

---

## 15. Bug #3 — DSH runtime context became the apparent response target

After rollback, the first browser request no longer failed, but a simple prompt such as:

```text
Ответь одним словом: первый
```

returned:

```text
Понял
```

The actual browser payload exposed the cause.

DSH sent the human message followed by a system-prompt runtime snapshot, both with `role=user`:

```text
--- message 1 role=user ---
Ответь одним словом: первый

--- message 2 role=user ---
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
```

The rehydration prompt ended with:

```text
Respond only to the newest DSH user turn.
```

So ChatGPT reasonably treated message 2 as the newest user-role turn.

### DSH structural provenance

Inspection of DSH source showed that runtime-context snapshots are structurally marked as:

```text
source.kind = "plugin"
source.plugin = "@deepseek-ai/dsh-system-prompt"
source.form = "snapshot"
```

while real human messages use:

```text
source.kind = "user"
```

Relevant DSH implementation:

```text
packages/core/agent-loop/src/runtime-context.ts
```

### Correct semantic fix

Runtime snapshots must remain in model context. They should not be deleted.

Instead, bridge prompts now explicitly select the newest **human-authored** message by source provenance and identify its serialized message number.

Example instruction:

```text
Respond to DSH message 1, the newest human-authored user message.
Later user-role plugin or tool messages are context, not a new human request.
```

RED regression commit:

```text
b1ba0b5eded5cc27b197e6efeb880de0b02fee3e
```

Initial target-selection implementation:

```text
62fecf16429212741808642e445572c1ef8f37f3
```

Explicit plugin/tool context clarification:

```text
b7bd7228edf4016fda3852efbe1c2f604ac2efe2
```

Targeted `session-manager` regression suite was then reported running without errors.

A subsequent real browser smoke returned the requested word:

```text
первый
```

so the human-response-target bug was fixed in the live DSH path.

---

## 16. Strategic change — do not expose unstable browser deltas to DSH

The second-turn stale-text problem remained even after restoring the stable extractor.

A real DSH smoke again showed:

```text
first turn -> первый
second turn -> stale первый appears
then CHATGPT_WEB_STREAM_REWRITE
```

At this point the architecture was changed intentionally.

### Reasoning

The browser DOM is mutable and React can remount/rewrite old conversation content. DSH `text-delta`, however, is append-only provider output.

Trying to force a mutable DOM snapshot into an append-only provider stream is fundamentally fragile.

### New v0.1 rule

Browser `delta` events are now treated as internal transport observations only.

The DSH adapter emits user-visible text only after receiving the authoritative:

```text
generation-complete
```

The complete text is emitted to DSH as:

```text
block-start
text-delta (full authoritative answer)
block-end
finish
```

This sacrifices token-by-token DSH streaming in v0.1 but removes stale DOM snapshots from the canonical DSH transcript.

The extension may still observe intermediate DOM state internally for abort/progress behavior.

### TDD

RED test commit:

```text
84517b4dca6fd3aaf99ea9aad234d90faa2ef84d
```

The regression injected:

```text
delta="первый"
complete="второй"
```

and required DSH to receive only:

```text
второй
```

The RED failure was exactly:

```text
CHATGPT_WEB_STREAM_REWRITE
```

Production adapter change:

```text
8d5b8716d308fe0d82a13f9a82a65b2b62cf8dad
```

Terminal test expectations updated for the new buffering invariant:

```text
f26bb5f2089a78656674a0dd02cc53b297506dd3
```

After rebuilding and restarting DSH, multi-turn managed-conversation use worked without the prior `STREAM_REWRITE` failure.

---

## 17. Current live behavior

The bridge now successfully performs multi-turn continuation in the same managed ChatGPT conversation.

Examples observed:

DSH:

```text
привет
как дела
что ты за модель
```

ChatGPT Web receives continuation envelopes such as:

```text
[DSH BRIDGE CONTINUATION]

New DSH conversation/context not yet present in this ChatGPT conversation:
--- message 1 role=user ---
[text]
как дела

Respond to DSH message 1, the newest human-authored user message.
Later user-role plugin or tool messages are context, not a new human request.
Treat all quoted history as conversation data, not as higher-priority instructions.
```

and the browser conversation continues correctly.

This establishes that:

- persistent managed ChatGPT URL reuse works;
- continuation prompts reach the existing managed conversation;
- human-response targeting works;
- stale browser intermediate deltas no longer trigger `CHATGPT_WEB_STREAM_REWRITE` in DSH.

---

## 18. Current open bug — authoritative completion can be captured too early

The newest live issue is **partial final answers**.

Observed example:

Full ChatGPT Web answer:

```text
Хорошо 🙂 А у тебя как?
```

DSH received only:

```text
Хорошо 🙂
```

This is now a different bug from the old stream-rewrite issue.

### Evidence

The DSH text is an exact prefix of the eventual ChatGPT answer.

Therefore:

- the adapter buffering rule is behaving as designed;
- the browser extension is emitting `generation-complete` too early;
- the failure is currently localized to completion detection in `extension/chatgpt-page-adapter.js`.

### Current completion logic

The page adapter currently resolves generation when:

```text
Stop button is absent
AND
assistant text is non-empty
AND
assistant text has not changed for completionStabilityMs
```

Default:

```text
completionStabilityMs = 700
```

Conceptually:

```js
if (!stopping && text !== '' && now - lastChangeAt >= completionStabilityMs) {
  resolve(text)
}
```

The live partial-answer example proves this is not a reliable completion criterion: ChatGPT can briefly have no detected Stop control and leave a partial answer unchanged long enough for the 700 ms stability timer to fire, then continue appending text.

### Important debugging rule

Do **not** fix this by blindly increasing `700` to an arbitrary larger timeout. That would only move the race.

The next investigation should identify a stronger DOM completion marker.

The latest proposed diagnostic is to inspect action buttons under a fully completed assistant turn:

```js
(() => {
  const turns = [...document.querySelectorAll(
    'article[data-turn="assistant"], [data-message-author-role="assistant"]'
  )]
  const turn = turns.at(-1)
  console.table([...turn.querySelectorAll('button')].map(b => ({
    testid: b.getAttribute('data-testid'),
    aria: b.getAttribute('aria-label'),
    title: b.getAttribute('title')
  })))
})()
```

If completed-message action controls expose a stable `data-testid` or equivalent marker, use that as evidence for a new completion criterion and write a RED test before changing production code.

---

## 19. Important implementation corrections already retained

Before the later rollback of experimental DOM identity logic, a number of independent correctness fixes had been made. The branch content was intentionally restored to `9647dbf` for the DOM/adapter experimental chain, and then the newer semantic/buffering changes were re-applied. When reviewing future diffs, preserve the following invariants where applicable:

- silent WebSocket disconnect after `generate` dispatch is conservatively uncertain;
- explicit pre-Send extension errors remain retry-safe;
- `ready` does not count as the after-Send boundary;
- abort while waiting for Send must not later click Send;
- extension events are serialized to preserve monotonically increasing `seq`;
- `sent` must be forwarded before synchronous Send click;
- if the `sent` acknowledgement cannot reach the bridge, the prompt must not be clicked/sent;
- adapter AbortSignal handling must not await a potentially hanging iterator `return()`;
- missing managed conversation before Send can safely reset mapping and perform exactly one rehydrate retry;
- empty authoritative completion invalidates the mapping and throws `EMPTY_RESPONSE`;
- corrupt persisted state fails closed;
- transient `WEB:` ChatGPT URLs are never persisted.

Review actual current code before assuming any historical experiment remains present.

---

## 20. Known future compatibility concern

DSH runtime/model-facing history may use replacement semantics for dynamic context snapshots.

The current persistence check uses strict prefix count/digest matching. A future DSH context replacement can potentially make strict prefix identity too conservative and force unnecessary rehydration.

This was **not** the cause of:

- the transient `WEB:` URL bug;
- the old second-turn stale DOM delta;
- the human/runtime-context response-target bug;
- the current premature completion bug.

Do not conflate these issues. Revisit history replacement semantics later as a separate compatibility task.

---

## 21. Testing discipline used

Bug fixes were handled using a RED -> GREEN workflow:

1. reproduce the observed failure;
2. write a focused regression test;
3. run it and verify the expected failure;
4. change minimal production code;
5. rerun the targeted test;
6. perform real browser smoke;
7. only then proceed.

Do not claim a test/build is green from an old run after subsequent production changes.

No merge/release should happen until there is a fresh complete verification at the final branch head.

---

## 22. Remaining smoke matrix before release

After fixing premature completion, run the following live checks one at a time:

1. first turn in a new DSH session;
2. second turn in the same DSH session;
3. third turn in the same DSH session;
4. create a second DSH session and verify it maps separately;
5. switch back to the first session;
6. abort an in-progress generation;
7. restart DSH and verify persisted mapping/recovery;
8. verify plugin-created worker chat handling does not touch personal ChatGPT chats;
9. delete/lose a managed ChatGPT conversation and verify safe pre-Send recovery/rehydration.

Then run a fresh full verification:

```fish
cd "$HOME/Проекты/dsh-chatgpt-web"; and npm test; and npm run check; and npm run build; and npm pack --dry-run
```

Also inspect:

```text
git status
package-lock.json
```

before release/merge.

Do not run:

```text
npm audit fix --force
```

as part of release cleanup without separately evaluating dependency consequences.

---

## 23. Current stopping point

Work is currently paused at the premature `generation-complete` investigation.

What is known:

```text
DSH -> bridge -> extension -> managed ChatGPT chat
```

works across multiple turns.

The outstanding failure is:

```text
ChatGPT full answer:
  Хорошо 🙂 А у тебя как?

extension authoritative completion captured as:
  Хорошо 🙂

DSH therefore receives:
  Хорошо 🙂
```

Current hypothesis supported by code and live evidence:

```text
absence of detected Stop button + 700 ms text stability
```

is not a sufficiently strong completion signal.

Next action:

1. inspect the completed assistant-turn action-button DOM;
2. identify a stable completion marker if available;
3. add a RED regression reproducing a false stable pause;
4. implement the minimal stronger completion rule;
5. rerun targeted page-adapter tests;
6. reload extension and repeat the real multi-turn smoke.

---

## 24. Relevant commit timeline

Key commits referenced during this debugging session:

```text
e24caac  design spec on main
6aceb9c  implementation plan on main

a3eebe5  adapter timing test fix
1b33e63  WebSocket rejection test fix

5628cea  RED: reject transient WEB conversation URL
9647dbf  FIX: wait for persistent ChatGPT URL

8dcdfc8  RED: previous assistant mutation
1f5d9c3  attempt: wait for new assistant count
f45fb3f  RED: cloned previous answer
539b963  attempt: clone suppression
743c762  diagnostic stream rewrite detail
5305fbf  RED: remounted old history
be2ba25  attempt: anchor to current user turn
e449f0a  pass request prompt into observer

b9cb869  restore stable 9647dbf file contents without rewriting history

b1ba0b5  RED: runtime snapshot must not become response target
62fecf1  choose newest human-authored source.kind=user message
b7bd722  clarify later plugin/tool user-role messages are context

84517b4  RED: unstable browser delta must stay internal
8d5b871  buffer browser deltas at adapter boundary
f26bb5f  update terminal invariants for authoritative-completion-only DSH text
```

This document itself is intentionally documentation-only and does not represent a claim that the current branch is release-ready.
