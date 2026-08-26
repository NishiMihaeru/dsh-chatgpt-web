'use strict'

const PROTOCOL = 'dsh-chatgpt-web-v1'
const BRIDGE_URL = 'ws://127.0.0.1:8765/'
const WORKER_TAB_KEY = 'dshChatGptWorkerTabId'

let socket = null
let reconnectTimer = null
let reconnectDelayMs = 500
let activeRequest = null
let activeWorkerTabId = null

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendWire(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ protocol: PROTOCOL, ...payload }))
  return true
}

async function storedWorkerTabId() {
  const value = await chrome.storage.session.get(WORKER_TAB_KEY)
  const id = value[WORKER_TAB_KEY]
  return Number.isInteger(id) ? id : null
}

async function clearWorkerTabId() {
  activeWorkerTabId = null
  await chrome.storage.session.remove(WORKER_TAB_KEY)
}

async function ensureWorkerTab() {
  let id = activeWorkerTabId ?? await storedWorkerTabId()
  if (id !== null) {
    try {
      const tab = await chrome.tabs.get(id)
      if (tab.id === id) {
        activeWorkerTabId = id
        return tab
      }
    } catch {
      await clearWorkerTabId()
      id = null
    }
  }

  // Privacy invariant: never search existing ChatGPT tabs. If our own stored
  // worker tab is gone, create a fresh dedicated tab instead of adopting one.
  const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false })
  if (tab.id === undefined) throw new Error('Chrome did not return an id for the ChatGPT worker tab')
  activeWorkerTabId = tab.id
  await chrome.storage.session.set({ [WORKER_TAB_KEY]: tab.id })
  return tab
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
    }
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId || changeInfo.status !== 'complete') return
      cleanup()
      resolve(tab)
    }
    chrome.tabs.onUpdated.addListener(listener)
    timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for ChatGPT worker tab to load'))
    }, timeoutMs)
    void chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        cleanup()
        resolve(tab)
      }
    }).catch(() => {})
  })
}

async function waitForContentScript(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { kind: 'dsh-ping' })
      if (response?.ready) return
    } catch {
      // Content script may not be injected until document_idle.
    }
    await sleep(100)
  }
  throw new Error('ChatGPT content script did not become ready')
}

async function navigateWorker(message) {
  const tab = await ensureWorkerTab()
  const tabId = tab.id
  if (tabId === undefined) throw new Error('ChatGPT worker tab lost its id')
  const target = message.conversationUrl ?? 'https://chatgpt.com/'
  const current = typeof tab.url === 'string' ? tab.url.split('#')[0] : ''
  if (current !== target) await chrome.tabs.update(tabId, { url: target, active: false })
  await waitForTabComplete(tabId)
  await waitForContentScript(tabId)
  return tabId
}

async function handleGenerate(message) {
  if (activeRequest !== null) {
    sendWire({
      type: 'error', requestId: message.requestId, code: 'WORKER_BUSY',
      message: 'Chrome worker tab already has an active request', afterSend: false, seq: 0,
    })
    return
  }
  const run = { requestId: message.requestId, nextSeq: 0, afterSend: false, contentAccepted: false }
  activeRequest = run
  try {
    sendWire({ type: 'request-state', requestId: run.requestId, stage: 'navigating', seq: run.nextSeq++ })
    const tabId = await navigateWorker(message)
    if (activeRequest !== run) return
    sendWire({ type: 'request-state', requestId: run.requestId, stage: 'ready', seq: run.nextSeq++ })
    const response = await chrome.tabs.sendMessage(tabId, {
      kind: 'dsh-generate',
      requestId: run.requestId,
      prompt: message.prompt,
      startSeq: run.nextSeq,
    })
    if (!response?.accepted) throw new Error(response?.error ?? 'ChatGPT content script refused generation')
    run.contentAccepted = true
  } catch (error) {
    if (activeRequest === run) {
      sendWire({
        type: 'error',
        requestId: run.requestId,
        code: 'WORKER_NAVIGATION',
        message: error instanceof Error ? error.message : String(error),
        afterSend: run.afterSend,
        seq: run.nextSeq,
      })
      activeRequest = null
    }
  }
}

async function handleAbort(requestId) {
  const run = activeRequest
  if (run === null || run.requestId !== requestId) return
  const tabId = activeWorkerTabId ?? await storedWorkerTabId()
  if (tabId !== null) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { kind: 'dsh-abort', requestId })
      if (response?.stopped) return
    } catch {
      // Fall through to a local terminal event. If content already crossed Send,
      // run.afterSend was updated from its request-state event below.
    }
  }
  if (activeRequest === run) {
    sendWire({ type: 'generation-aborted', requestId, seq: run.nextSeq++ })
    activeRequest = null
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.kind !== 'dsh-event') return
  if (sender.tab?.id === undefined || sender.tab.id !== activeWorkerTabId) return
  const payload = message.payload
  const run = activeRequest
  if (run === null || !payload || payload.requestId !== run.requestId) return
  if (!Number.isSafeInteger(payload.seq) || payload.seq !== run.nextSeq) {
    sendWire({
      type: 'error', requestId: run.requestId, code: 'WORKER_SEQ',
      message: 'Content-script event sequence was not contiguous', afterSend: run.afterSend,
      seq: run.nextSeq,
    })
    activeRequest = null
    return
  }
  run.nextSeq = payload.seq + 1
  if (payload.type === 'request-state' && (payload.stage === 'sent' || payload.stage === 'generating')) run.afterSend = true
  sendWire(payload)
  if (payload.type === 'generation-complete' || payload.type === 'generation-aborted' || payload.type === 'error') {
    activeRequest = null
  }
})

chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId !== activeWorkerTabId) return
  const run = activeRequest
  activeWorkerTabId = null
  void chrome.storage.session.remove(WORKER_TAB_KEY)
  if (run !== null) {
    sendWire({
      type: 'error', requestId: run.requestId, code: 'WORKER_TAB_CLOSED',
      message: 'Dedicated ChatGPT worker tab was closed', afterSend: run.afterSend,
      seq: run.nextSeq,
    })
    activeRequest = null
  }
})

function scheduleReconnect() {
  if (reconnectTimer !== null) return
  const jitter = Math.floor(Math.random() * Math.min(250, reconnectDelayMs / 2))
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBridge()
  }, reconnectDelayMs + jitter)
  reconnectDelayMs = Math.min(10000, reconnectDelayMs * 2)
}

function connectBridge() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  const ws = new WebSocket(BRIDGE_URL)
  socket = ws

  ws.addEventListener('open', () => {
    reconnectDelayMs = 500
    sendWire({ type: 'hello', extensionVersion: chrome.runtime.getManifest().version })
  })

  ws.addEventListener('message', event => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      ws.close(1002, 'invalid bridge JSON')
      return
    }
    if (message?.protocol !== PROTOCOL) {
      ws.close(1002, 'invalid bridge protocol')
      return
    }
    if (message.type === 'ping') {
      sendWire({ type: 'pong', nonce: message.nonce })
      return
    }
    if (message.type === 'generate') {
      void handleGenerate(message)
      return
    }
    if (message.type === 'abort') {
      void handleAbort(message.requestId)
      return
    }
    ws.close(1002, 'unknown bridge message')
  })

  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    const requestId = activeRequest?.requestId
    if (requestId !== undefined) void handleAbort(requestId)
    activeRequest = null
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    // close event owns reconnect scheduling.
  })
}

connectBridge()
