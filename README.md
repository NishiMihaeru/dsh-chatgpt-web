# dsh-chatgpt-web

Experimental standalone DeepSeek Harness provider that uses an already authenticated ordinary ChatGPT Web session through a local Chrome extension.

```text
DSH native chat
  -> chatgpt-web/auto
  -> localhost WebSocket bridge (127.0.0.1:8765)
  -> bundled Chrome MV3 extension
  -> chatgpt.com
```

No OpenAI API key, OpenAI Platform credits, or Secure MCP Tunnel are required by this plugin. It automates the normal `chatgpt.com` web UI that you are already signed in to.

## v0.1 scope

v0.1 provides text generation, live streaming, one managed ChatGPT conversation per DSH session, cancellation, and persisted DSH-session-to-ChatGPT-URL mappings.

Limitations are intentional:

- text-only input/output;
- one dedicated Chrome worker tab and one active generation at a time;
- DSH tool schemas are accepted by the adapter but are not callable from ChatGPT in v0.1;
- an external Chrome/Chromium browser with the bundled unpacked extension is required;
- ChatGPT Web DOM changes can require updates to `extension/chatgpt-page-adapter.js`;
- sampling controls such as temperature/maxTokens/stop and DSH auxiliary `purpose` calls are unsupported in v0.1.

The extension never enumerates the ChatGPT sidebar and never searches for or adopts arbitrary existing ChatGPT tabs. It creates one dedicated worker tab and navigates only to managed conversation URLs created for this plugin. Pre-existing personal ChatGPT conversations are outside the plugin's scope.

## Requirements

- DeepSeek Harness `0.1.1-rc.2`;
- Node.js `^22.19.0 || >=24.0.0`;
- Chrome/Chromium with access to `https://chatgpt.com`;
- a logged-in ChatGPT Web session;
- the package manager prerequisites required by `dsh plugin` on your DSH installation.

## Development install

```bash
npm install
npm run check
npm test
npm run build

dsh plugin --profile web add .
```

Then start DSH:

```bash
dsh web
```

At startup the plugin logs both:

```text
[dsh-chatgpt-web] bridge listening on ws://127.0.0.1:8765
[dsh-chatgpt-web] Chrome extension directory: /absolute/path/to/dsh-chatgpt-web/extension
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that `extension` directory. The extension reconnects automatically if DSH is restarted.

In DSH select:

```text
chatgpt-web/auto
```

and use the normal DSH chat UI.

## Published install

Once the package is published to npm, the intended install command is:

```bash
dsh plugin --profile web add dsh-chatgpt-web
```

Start `dsh web`, copy the absolute extension directory from the plugin startup log, and load it once from `chrome://extensions` with **Load unpacked**.

## Conversation model

DSH remains the canonical durable transcript. The ChatGPT conversation is a provider-side conversational cache.

For a normal continuation, the adapter sends only the DSH history suffix that has not already been synchronized. It never sends ChatGPT's previous assistant output back into the same ChatGPT conversation as a new user message.

If the managed ChatGPT conversation is missing, history no longer matches the stored synchronization digest, generation is aborted after submission, or a post-send transport failure makes state uncertain, the next turn creates a fresh managed conversation and rehydrates it from canonical DSH history.

The plugin state contains only operational mapping/digests. It does not store ChatGPT cookies, login tokens, full DSH transcripts, or copies of personal ChatGPT chats.

## Local security boundary

The bridge is fixed to:

```text
ws://127.0.0.1:8765/
```

It binds loopback only and validates the deterministic `chrome-extension://...` Origin produced by the bundled manifest public key. The public key is an identity pin, not a secret.

This protects against ordinary remote/web-page access to the bridge. A malicious process already running as the same local user can forge a WebSocket Origin, so same-user local processes remain inside the v0.1 trust boundary.

The bridge exposes no shell, filesystem API, cookie reader, generic HTTP proxy, or arbitrary-command endpoint.

## Local tests

There is deliberately no GitHub Actions or CI workflow in this project. Run verification locally:

```bash
npm run check
npm test
npm run build
npm pack --dry-run
```

The real-browser acceptance test is manual because it depends on your authenticated ChatGPT Web session. See [`docs/manual-smoke.md`](docs/manual-smoke.md).

## Browser DOM maintenance

All ChatGPT-specific selectors and DOM mutation logic live in:

```text
extension/chatgpt-page-adapter.js
```

If ChatGPT changes its UI, update that file and its fixture regression tests first. Do not spread ChatGPT selectors into the DSH adapter, transport, session manager, or service worker.

## Roadmap

```text
v0.1  text + streaming + managed conversations + abort
v0.2  validated native DSH tool-call bridge
v0.3  continuable subagent/autonomous supervision loop
v0.4  optional managed/headless Chromium transport
```

This integration is unofficial browser automation and is not an OpenAI API integration.
