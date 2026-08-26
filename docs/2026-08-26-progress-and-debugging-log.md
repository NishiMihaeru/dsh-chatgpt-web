# dsh-chatgpt-web v0.1 — implementation and debugging log

Date: 2026-08-26

Status: **work in progress; do not merge/release yet**

This document records the architectural decisions, experiments, implementation work, regressions, fixes, test evidence, and current stopping point for `dsh-chatgpt-web` v0.1.

The design spec and implementation plan have since been synchronized to the as-built architecture. This log remains the historical narrative and debugging evidence.

---

## 1. Goal and long-term role split

Build a standalone DeepSeek Harness (DSH) provider that uses an ordinary logged-in ChatGPT Web session as the model provider.

Core constraints:

- no OpenAI API key;
- no OpenAI Platform inference billing requirement;
- no Secure MCP Tunnel dependency;
- use ordinary `chatgpt.com` in the user's browser;
- DSH remains the primary UI and the only owner of the agent loop.

Target v0.1 path:

```text
DSH native chat
  -> chatgpt-web/auto
      -> local loopback bridge
          -> bundled Chrome extension
              -> extension-owned chatgpt.com worker tab
```

Longer-term role split:

- ChatGPT: supervisor / architect / reviewer;
- DSH: orchestration kernel and single agent-loop owner;
- subagent: implementer;
- Git/GitHub: canonical code state;
- DSH session log: canonical execution history;
- managed ChatGPT conversation: provider-side conversational cache only.

No second autonomous loop belongs in the browser bridge.

---

## 2. Repository and branches

Repository:

```text
https://github.com/NishiMihaeru/dsh-chatgpt-web
```

Implementation branch:

```text
feat/v0.1-implementation
```

Original approved design/plan commits on `main`:

```text
e24caac  design spec
6aceb9c  implementation plan
```

Current canonical docs on the feature branch:

```text
README.md
docs/manual-smoke.md
docs/2026-08-26-progress-and-debugging-log.md
docs/superpowers/specs/2026-08-26-chatgpt-web-v0.1-design.md
docs/superpowers/plans/2026-08-26-chatgpt-web-v0.1-implementation.md
```

There are intentionally no GitHub Actions / CI workflows.

---

## 3. MCP investigation and why it was not selected

A throwaway native custom-MCP smoke was tested on CachyOS with:

- Node `22.23.2`;
- npm `12.0.2`;
- `@modelcontextprotocol/sdk@1.30.0`;
- Zod;
- Express;
- Streamable HTTP at `127.0.0.1:3457/mcp`.

The smoke worked: initialize negotiated protocol `2025-06-18`, `tools/call` worked, and a read-only ping returned `pong from CachyOS`.

It was not selected for this project because the desired product shape is a standalone ordinary-ChatGPT-Web bridge without depending on the OpenAI Platform/tunnel path or its product-tier constraints for broader write-style tool use.

Important nuance: this is not a claim that every MCP tool invocation necessarily incurs API inference billing.

Reference-only third-party project examined:

```text
jiezeng2004-design/dsh-chatgpt-bridge
```

That project connects ChatGPT Web toward DSH through MCP; it does not make DSH use ChatGPT Web as its native model provider.

---

## 4. Browser bridge spike proved feasibility

Throwaway spike progression:

```text
v0.0.4  insert prompt
v0.0.5  click Send
v0.0.6  capture completed reply
v0.0.7  live DOM streaming
v0.0.8  cleaner extraction / transient-status filtering / final snapshot
```

Proven path:

```text
terminal
 -> ws://127.0.0.1:8765
 -> Chrome extension
 -> chatgpt.com composer
 -> Send
 -> assistant DOM
 -> extension
 -> bridge
 -> terminal
```

A clean spike produced numbers 1 through 10 without `Thinking`/`Думаю` noise.

This established the feasibility of ordinary ChatGPT Web transport without an API key, Secure MCP Tunnel, or Platform API inference.

---

## 5. DSH integration environment

Development environment used during the live integration:

```text
DSH: 0.1.1-rc.2
Node: 22.23.2
OS: CachyOS / Arch-based Linux
shell: Fish
```

Local plugin checkout:

```text
$HOME/Проекты/dsh-chatgpt-web
```

Local bundle install/link:

```fish
cd "$HOME/Проекты/dsh-chatgpt-web"
dsh plugin --profile web add .
```

DSH model picker exposed:

```text
chatgpt-web/auto
```

The Chrome extension was loaded unpacked from the repository's `extension` directory. Extension-source changes require an explicit Reload in `chrome://extensions`.

---

## 6. Current v0.1 architecture

Current architecture:

```text
ChatGptWebAdapter
  -> SessionManager
  -> RequestQueue
  -> ExternalChromeTransport
      -> BridgeServer @ 127.0.0.1:8765
          -> Chrome service worker
              -> content script
                  -> chatgpt-page-adapter
                      -> dedicated worker tab
```

One DSH session maps to one plugin-created managed ChatGPT conversation while the stored mapping remains trustworthy.

The extension owns one worker tab globally and never enumerates/adopts arbitrary personal ChatGPT tabs.

Only one browser generation runs at a time; adapter requests are FIFO serialized.

---

## 7. Actual bridge protocol

Protocol id:

```text
dsh-chatgpt-web-v1
```

Current plugin -> extension messages:

```text
generate
abort
ping
```

Current extension -> plugin messages:

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

Earlier design text mentioned `open-session`, `reset-session`, and `generation-start`; those are not separate messages in the implemented protocol. Navigation intent is carried by `generate.conversationUrl`, and progress is represented by `request-state`.

Request-scoped messages use `requestId` and monotonically increasing `seq`.

Logical request lifecycle:

```text
queued -> navigating -> ready -> sent -> generating -> completed
                                      \-> aborted
                                      \-> uncertain
                                      \-> failed
```

Retry invariant:

- explicit failure proven before Send may be retry-safe;
- `ready` is still pre-Send;
- `sent` is forwarded before the synchronous Send click;
- after a prompt may have been sent, automatic resend is forbidden;
- silent disconnect after the bridge has handed `generate` to the extension is conservatively uncertain;
- ambiguous provider state fails with `CHATGPT_WEB_UNCERTAIN`.

---

## 8. Security / browser ownership

The extension manifest carries a stable public key so the extension id is deterministic.

Expected id observed/tested:

```text
hekamonfnjniofllombaancencdbjoag
```

The bridge accepts only the exact deterministic extension Origin and binds only:

```text
127.0.0.1:8765
```

Origin validation is an identity pin, not cryptographic authentication. Same-user local processes remain inside the v0.1 trust boundary.

The bridge exposes no shell, filesystem endpoint, cookie reader, generic HTTP proxy, or arbitrary-command interface.

The extension stores only its own worker-tab id in `chrome.storage.session`; it does not scan the user's ChatGPT sidebar or arbitrary tabs.

---

## 9. DSH adapter request policy

Target dependency:

```text
@deepseek-ai/dsh-llm@0.1.1-rc.2
```

Current policy:

- exact provider/model `chatgpt-web/auto`;
- `sessionId` required;
- text-only input;
- images fail `CHATGPT_WEB_UNSUPPORTED_IMAGE`;
- explicit `reasoningEffort`, `temperature`, `maxTokens`, `stop`, or `purpose` fail `CHATGPT_WEB_UNSUPPORTED`;
- tool schemas may be accepted but are not exposed as callable ChatGPT tools in v0.1;
- historical tool call/result blocks can be serialized only as rehydration context.

Empty authoritative completion marks state uncertain and throws canonical `EMPTY_RESPONSE`.

---

## 10. Persistence and canonical history

Persistent session state:

```ts
interface PersistedSessionState {
  conversationUrl?: string
  syncedMessageCount: number
  syncedPrefixDigest: string
  systemDigest: string
  status: 'ready' | 'uncertain'
}
```

Default path uses:

```ts
envPaths('dsh-chatgpt-web').data/state.json
```

Observed local path:

```text
$HOME/.local/share/dsh-chatgpt-web-nodejs/state.json
```

Rules:

- atomic temp-write + rename;
- corrupt JSON fails closed;
- no cookies/tokens/full transcripts persisted;
- canonical URL must be `https://chatgpt.com/c/<id>`;
- strict system/prefix digest checks gate continuation;
- untrusted/uncertain state forces fresh rehydration from canonical DSH history.

Known future concern: DSH may use replacement semantics for dynamic runtime snapshots, making strict prefix identity overly conservative. This is separate from current browser DOM bugs.

---

## 11. Early full local verification

Before later regression changes, a full local run succeeded:

```text
npm test
npm run check
npm run build
npm pack --dry-run
```

At that time 51 tests passed and dry-run packing succeeded.

This result is historical only. Later tests and behavior changes mean a fresh complete run at the final branch HEAD is required before release.

`npm install` also reported one critical audit item and an npm `allowScripts` block for `esbuild@0.28.2`; TypeScript/tsx execution still worked. Do not run `npm audit fix --force` blindly.

---

## 12. Bug #1 — transient `WEB:` conversation URL

### Symptom

First turn worked, but every later DSH turn created another ChatGPT conversation.

Persisted mapping contained a temporary route like:

```text
https://chatgpt.com/c/WEB:...
```

while the worker later settled on a persistent `/c/<id>` URL.

### Root cause

ChatGPT exposes a transient `WEB:` route during conversation creation. The extension reported/persisted it too early.

### TDD/fix

```text
5628cea  RED: reject transient WEB route
9647dbf  FIX: wait for persistent managed URL
```

`getConversationUrl()` now rejects ids beginning with `WEB:`.

Live retest showed a stable persistent `/c/<id>` mapping and enabled same-chat continuation.

---

## 13. Bug #2 — second turn leaked the previous assistant answer

After the URL fix, the same managed ChatGPT conversation was reused, but a second turn failed with:

```text
CHATGPT_WEB_STREAM_REWRITE
```

Diagnostic evidence:

```text
streamed="первый"
final="второй"
```

Therefore stale previous-assistant DOM content had crossed the browser -> DSH boundary as an incremental delta.

Experiments attempted to identify the current assistant turn:

```text
8dcdfc8  RED: previous assistant mutation
1f5d9c3  attempt: wait for new assistant count
f45fb3f  RED: cloned previous answer
539b963  attempt: clone suppression
743c762  diagnostics with streamed/final detail
5305fbf  RED: old history remount
be2ba25  attempt: anchor to current user turn
e449f0a  pass exact request prompt to observer
```

The exact-prompt anchoring experiment introduced a new first-turn regression: generation started but no matching current assistant response was found.

The experimental DOM chain was rolled back without rewriting history:

```text
b9cb869  restore stable 9647dbf file content
```

Targeted page-adapter suite returned to 8/8 at that point.

---

## 14. Bug #3 — DSH runtime snapshot became the response target

After rollback, the first browser request could complete but a prompt such as:

```text
Ответь одним словом: первый
```

returned `Понял`.

The actual bridge payload showed:

```text
message 1 role=user -> actual human prompt
message 2 role=user -> Current runtime context... plugin snapshot
```

The old envelope ended with:

```text
Respond only to the newest DSH user turn.
```

So ChatGPT reasonably treated message 2 as the target.

DSH structurally marks the snapshot with plugin provenance while a real human message has `source.kind === 'user'`.

Correct fix: keep plugin snapshots in context, but explicitly identify the newest human-authored message number as the response target.

TDD/fixes:

```text
b1ba0b5  RED: runtime snapshot must not become response target
62fecf1  select newest source.kind=user message
b7bd722  explicitly say later plugin/tool user-role messages are context
```

Real browser retest then returned the requested `первый`.

---

## 15. Strategic output change — browser deltas stay internal

Even after restoring the stable DOM extractor, the stale second-turn delta problem remained.

The core mismatch is architectural:

```text
ChatGPT/React DOM snapshots = mutable/remountable
DSH text-delta            = append-only provider output
```

Current v0.1 rule:

```text
browser delta
  -> internal transport observation only

generation-complete(fullText)
  -> block-start
  -> text-delta(fullText)
  -> block-end(fullText)
  -> finish(stop)
```

TDD/fixes:

```text
84517b4  RED: unstable browser delta must remain internal
8d5b871  adapter buffers/ignores browser deltas for DSH output
f26bb5f  terminal tests updated for authoritative-completion-only invariant
```

This removed the need for `CHATGPT_WEB_STREAM_REWRITE` as a runtime response to browser delta/final divergence: divergent deltas are not canonical DSH text anymore.

A later repository audit found that the older broad adapter test file still expected live incremental deltas and rewrite failure. That test-contract mismatch was corrected in:

```text
c415e0c  align adapter tests with authoritative completion
```

No production behavior was changed by that test update.

---

## 16. Current live multi-turn behavior

After the response-target fix and authoritative-completion-only adapter rule, the managed conversation can continue across multiple DSH turns.

Observed example sequence:

```text
привет
как дела
что ты за модель
```

The worker stayed in the same managed ChatGPT conversation and continuation envelopes targeted the human DSH message correctly.

This establishes:

- persistent managed URL reuse works in real browser flow;
- continuation envelopes reach the existing ChatGPT conversation;
- human-response targeting works;
- stale browser intermediate deltas no longer become DSH text or trigger the old rewrite failure.

---

## 17. Current open blocker — premature `generation-complete`

A newer live run showed a different failure.

Full ChatGPT rendered answer:

```text
Хорошо 🙂 А у тебя как?
```

DSH received:

```text
Хорошо 🙂
```

The DSH answer is an exact prefix of the eventual browser answer.

This means:

- adapter buffering is doing what it was designed to do;
- the browser extension is emitting its authoritative `generation-complete` too early;
- the current failure is localized to completion detection in `extension/chatgpt-page-adapter.js`.

Current completion rule is effectively:

```text
Stop control absent
AND assistant text non-empty
AND text stable for completionStabilityMs
```

Default stability window:

```text
700 ms
```

This live evidence proves that the rule is insufficient: ChatGPT can temporarily expose no detected Stop button and hold a partial prefix stable long enough to satisfy the timer before appending more text.

### Debugging rule

Do not fix this by blindly choosing a larger timeout.

Next investigation must identify a stronger semantic completed-turn marker in the real DOM, then write a RED regression reproducing the false stable pause before changing production code.

Proposed real-DOM diagnostic:

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

The objective is to find a stable semantic completion signal such as a completed-turn action control. No selector is approved until confirmed by real DOM evidence.

---

## 18. Important correctness invariants to preserve

Future fixes must retain these behaviors:

- transient `/c/WEB:...` routes are never persisted;
- silent WebSocket loss after `generate` dispatch is conservatively uncertain;
- explicit pre-Send extension errors can remain retry-safe;
- `ready` is not the after-Send boundary;
- `sent` is forwarded before Send click;
- if the sent-boundary acknowledgement cannot reach the bridge, Send is not clicked;
- cancellation while waiting for Send cannot later click Send;
- content-script events are serialized and `seq` remains contiguous;
- abort handling does not await a potentially hanging iterator return;
- missing managed conversation before Send can perform exactly one safe reset/rehydrate retry;
- empty authoritative completion marks state uncertain and throws `EMPTY_RESPONSE`;
- runtime plugin/tool user-role messages remain context and never displace the newest human-authored request;
- browser deltas never become DSH canonical text in v0.1;
- corrupt state fails closed;
- no personal ChatGPT tab/sidebar adoption;
- no CI/GitHub Actions.

---

## 19. Documentation synchronization audit

A whole-repository documentation/contract audit was performed after the partial-completion discovery.

The audit found several stale assumptions left from the original greenfield design:

- README still promised “live streaming”;
- design/plan still described browser `delta` -> DSH `text-delta`;
- design/plan listed `open-session`, `reset-session`, and `generation-start` wire messages that are not implemented;
- old plan prompt text still said “Respond only to the newest DSH user turn”;
- manual smoke still required clean native streaming rather than authoritative full-text equality;
- `test/adapter.test.ts` still asserted the superseded live-delta / stream-rewrite contract.

Synchronization commits:

```text
c415e0c  adapter tests: authoritative-completion contract
9586bbe  README: current v0.1 behavior/status
79d948e  design spec: as-built architecture
412a7e5  implementation plan: as-built status + remaining tasks
c2f18c5  manual smoke: authoritative completion + current blocker
```

This log update follows those changes.

The production DOM completion logic was intentionally **not** changed during this documentation-sync pass; the open completion bug remains a separate TDD task.

---

## 20. Verification state

Do not make a release-ready claim from historical output.

Fresh targeted evidence already obtained earlier includes:

- rollback page-adapter suite: 8/8 at that branch state;
- runtime-context session-manager regression: reported green after the explicit context clarification;
- authoritative-completion terminal adapter regression: reported green after the buffering change.

However, the documentation/test synchronization above changed the current branch again, so the whole repository now requires a fresh run.

Final verification command:

```fish
cd "$HOME/Проекты/dsh-chatgpt-web"; and npm test; and npm run check; and npm run build; and npm pack --dry-run
```

Also inspect:

```fish
git status --short
```

At the time of the repository audit, `package-lock.json` was not present in the GitHub branch tree even though local `npm install` may have created one. Decide intentionally before release whether to commit it.

Do not run `npm audit fix --force` without separately evaluating consequences.

---

## 21. Remaining live-browser acceptance matrix

After fixing premature completion, run one step at a time:

1. new session A, first exact answer;
2. second turn in A, same managed URL;
3. third turn in A, same managed URL;
4. natural-language response where browser final text and DSH final text must match fully;
5. session B with a distinct managed URL;
6. switch back to A and reuse A;
7. abort an in-progress generation;
8. restart DSH and verify ready/uncertain mapping behavior;
9. lose/delete a managed chat and verify one safe pre-Send rehydration recovery;
10. verify personal chats remain untouched;
11. run full local test/check/build/pack verification;
12. perform packed-install smoke.

Canonical manual instructions are in `docs/manual-smoke.md`.

---

## 22. Relevant commit timeline

```text
e24caac  original design spec on main
6aceb9c  original implementation plan on main

a3eebe5  adapter timing test correction
1b33e63  WebSocket rejection test correction

5628cea  RED: transient WEB URL
9647dbf  FIX: wait for persistent URL

8dcdfc8  RED: previous assistant mutation
1f5d9c3  attempt: new assistant count
f45fb3f  RED: cloned previous answer
539b963  attempt: clone suppression
743c762  diagnostic stream/final detail
5305fbf  RED: remounted old history
be2ba25  attempt: current user-turn anchoring
e449f0a  pass request prompt to observer

b9cb869  rollback experimental DOM chain to stable content

b1ba0b5  RED: runtime snapshot response target
62fecf1  choose newest human-authored message
b7bd722  explicit later plugin/tool context wording

84517b4  RED: browser deltas stay internal
8d5b871  production adapter buffering change
f26bb5f  terminal invariant update

0a13107  initial progress/debugging log

c415e0c  synchronize broad adapter tests
9586bbe  synchronize README
79d948e  synchronize design spec
412a7e5  synchronize implementation plan
c2f18c5  synchronize manual smoke
```

---

## 23. Exact stopping point

Work is paused at the completion-detection investigation.

Known working direction:

```text
DSH
 -> adapter
 -> loopback bridge
 -> extension-owned ChatGPT conversation
 -> authoritative final text back to DSH
```

Outstanding defect:

```text
ChatGPT may continue appending after the current page adapter has already emitted generation-complete.
```

Next steps:

1. inspect semantic controls/attributes on a fully completed assistant turn in real ChatGPT DOM;
2. identify a stronger completion signal;
3. add a RED page-adapter regression for a false stable pause;
4. make the smallest evidence-backed page-adapter change;
5. run targeted page-adapter tests;
6. reload the unpacked extension;
7. repeat the real multi-turn smoke;
8. only after browser acceptance, run fresh whole-repository verification.
