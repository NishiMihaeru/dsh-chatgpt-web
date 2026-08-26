# dsh-chatgpt-web v0.1 manual smoke test

This is the acceptance run for the real browser path. It is intentionally local and manual: there is no CI or GitHub Actions workflow for authenticated ChatGPT Web testing.

## Environment expected for the first acceptance run

- CachyOS / Arch-based Linux
- Fish shell
- Node.js 22.23.x or another version accepted by `package.json`
- global `dsh` 0.1.1-rc.2
- DSH Web on port 3080
- Chrome/Chromium already signed in to ordinary `https://chatgpt.com`

Use `$HOME` rather than a pasted `~` if your terminal/paste path escaping behaves unexpectedly.

## 1. Prepare the checkout

```fish
git switch feat/v0.1-implementation
npm install
npm run check
npm test
npm run build
npm pack --dry-run
```

Expected: typecheck, unit tests, build, and package dry-run succeed. The package contains `lib/`, `extension/`, `cordis.patch.yml`, `README.md`, and `LICENSE`, and contains no `.github/workflows`.

## 2. Make sure DSH Web port 3080 is free

```fish
ss -ltnp 'sport = :3080'
```

If an old DSH process owns the port, stop that old process before continuing.

## 3. Install/link the local bundle

From the repository root:

```fish
dsh plugin --profile web add .
dsh --profile web --dump-config
```

Confirm the dumped profile contains the `llm-chatgpt-web` row and package `dsh-chatgpt-web`.

If `dsh plugin` reports that its profile package manager is missing, install the package-manager prerequisite required by your DSH installation, then rerun the command. Do not change this plugin to shell out to a second installer.

## 4. Start DSH and capture the extension path

```fish
dsh web
```

Expected startup diagnostics include:

```text
[dsh-chatgpt-web] bridge listening on ws://127.0.0.1:8765
[dsh-chatgpt-web] Chrome extension directory: <absolute path>/extension
```

Do not start a separate `bridge.mjs` or Node daemon.

## 5. Load the bundled Chrome extension once

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the absolute `extension` directory printed by DSH.
5. Open the extension service-worker inspector only if diagnostics are needed.

Expected stable extension id:

```text
hekamonfnjniofllombaancencdbjoag
```

The extension should connect to `ws://127.0.0.1:8765/` automatically.

## 6. Verify the provider appears

Open the DSH Web UI and select:

```text
chatgpt-web/auto
```

If the provider does not appear, stop here and capture the DSH startup log plus `dsh --profile web --dump-config` output.

## 7. Session A: first managed conversation and clean streaming

Create a new DSH session A and send:

```text
Reply with the numbers 1 through 10, one number per line, and nothing else.
```

Verify:

- the dedicated ChatGPT worker tab navigates to a newly created ChatGPT conversation;
- the ChatGPT URL becomes `https://chatgpt.com/c/<id>`;
- DSH streams only the answer text;
- transient UI text such as `Thinking`, `Думаю`, or `Размышляю` does not appear in DSH;
- the final DSH answer is exactly the final rendered ChatGPT assistant answer.

Record the managed URL as `A_URL`.

## 8. Session A: continuation reuses the same conversation

In the same DSH session A send:

```text
Now reply with only: SESSION_A_OK
```

Verify the worker tab uses the same `A_URL`, and the answer streams into DSH.

## 9. Session B: separate managed conversation

Create DSH session B and send:

```text
Reply with only: SESSION_B_OK
```

Verify ChatGPT creates a different managed URL `B_URL`, and `B_URL != A_URL`.

Switch back to session A, send one more message, and verify the worker tab navigates back to `A_URL` before sending.

## 10. Abort

In either DSH session request a deliberately long response, then cancel generation from DSH while ChatGPT is still generating.

Verify:

- the worker tab clicks/stops ChatGPT generation;
- DSH ends the turn as aborted rather than replaying it;
- the plugin does not automatically resend the prompt;
- the following DSH turn rehydrates into a fresh managed ChatGPT conversation if the aborted turn may have changed provider-side context.

## 11. Restart persistence

Stop DSH cleanly, leaving Chrome open, then start again:

```fish
dsh web
```

Verify the extension reconnects automatically.

Open session A and B again. Their DSH session mappings must survive the DSH restart. A normal synchronized session should reuse its stored managed URL. Any session previously marked uncertain must create a fresh managed conversation and rehydrate from DSH history.

## 12. Privacy/isolation check

Before and after the test, verify that the plugin did not:

- enumerate the ChatGPT sidebar;
- open a pre-existing personal ChatGPT conversation;
- search arbitrary existing ChatGPT tabs;
- import personal conversation ids;
- read/copy ChatGPT cookies, session tokens, or passwords.

The only ChatGPT tabs/conversation URLs it may control are its dedicated worker tab and plugin-created managed URLs.

## 13. No Platform/API dependency check

Verify the setup uses none of:

- OpenAI API key;
- OpenAI Platform inference credits;
- Secure MCP Tunnel.

The authenticated ordinary ChatGPT Web page is the model transport.

## Failure report template for Antigravity

When a step fails, stop instead of applying speculative architecture changes. Report:

```text
Repository: NishiMihaeru/dsh-chatgpt-web
Branch: feat/v0.1-implementation
Commit: <git rev-parse HEAD>

Failed step:
<step number/name>

Command/action:
<exact command or browser action>

Observed error/log:
<complete relevant output>

Expected:
<what manual-smoke.md expected>

Suspected boundary:
package | DSH adapter | session sync | bridge | service worker | content script | chatgpt-page-adapter | unknown
```

If the live ChatGPT DOM is the cause, modify only `extension/chatgpt-page-adapter.js` plus a regression fixture/test first. Cross the DOM boundary only when evidence shows the failure is elsewhere.
