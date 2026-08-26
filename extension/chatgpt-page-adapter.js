(() => {
  'use strict'

  const TRANSIENT_STATUS = new Set([
    'thinking', 'thinking…', 'thinking...',
    'думаю', 'думаю…', 'думаю...',
    'размышляю', 'размышляю…', 'размышляю...',
  ])

  let lastSendBaseline = { assistantCount: 0, assistantText: '' }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

  function composer() {
    return document.querySelector('#prompt-textarea')
      ?? document.querySelector('textarea[data-id="root"]')
      ?? document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('div[contenteditable="true"]')
  }

  function candidateButtons() { return Array.from(document.querySelectorAll('button')) }

  function buttonLabel(button) {
    return [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
      .filter(Boolean).join(' ').trim().toLowerCase()
  }

  function sendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      ?? document.querySelector('button[aria-label="Send prompt"]')
      ?? document.querySelector('button[aria-label="Отправить запрос"]')
      ?? candidateButtons().find(button => /(^|\s)(send|отправить)(\s|$)/i.test(buttonLabel(button)))
      ?? null
  }

  function stopButton() {
    return document.querySelector('button[data-testid="stop-button"]')
      ?? document.querySelector('button[aria-label="Stop streaming"]')
      ?? document.querySelector('button[aria-label="Stop generating"]')
      ?? document.querySelector('button[aria-label="Остановить создание"]')
      ?? candidateButtons().find(button => /(stop|остановить)/i.test(buttonLabel(button)))
      ?? null
  }

  function conversationTurns() {
    const articles = Array.from(document.querySelectorAll('article[data-turn]'))
    if (articles.length > 0) return articles
    return Array.from(document.querySelectorAll('[data-message-author-role]'))
  }

  function turnRole(turn) {
    return turn.getAttribute('data-turn') ?? turn.getAttribute('data-message-author-role') ?? ''
  }

  function turnContent(turn) {
    return turn.querySelector('[data-message-content]')
      ?? turn.querySelector('.whitespace-pre-wrap')
      ?? turn.querySelector('.markdown')
      ?? turn.querySelector('.prose')
      ?? turn.querySelector('[class*="markdown"]')
      ?? turn
  }

  function normalizedTurnText(turn) {
    const content = turnContent(turn)
    return String(content.innerText || content.textContent || '').replace(/\r\n/g, '\n').trim()
  }

  function assistantTurns() {
    return conversationTurns().filter(turn => turnRole(turn) === 'assistant')
  }

  function cleanAssistantText(text) {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    while (lines.length > 0 && TRANSIENT_STATUS.has(lines[0].trim().toLowerCase())) lines.shift()
    const cleaned = lines.join('\n').trim()
    return TRANSIENT_STATUS.has(cleaned.toLowerCase()) ? '' : cleaned
  }

  function assistantText(turn) {
    if (!turn) return ''
    const answer = turnContent(turn)
    return cleanAssistantText(answer.innerText || answer.textContent || '')
  }

  function latestAssistantText() {
    return assistantText(assistantTurns().at(-1))
  }

  function assistantTurnAfterPrompt(requestPrompt) {
    const expected = String(requestPrompt ?? '').replace(/\r\n/g, '\n').trim()
    if (!expected) return null
    const turns = conversationTurns()
    let userIndex = -1
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turnRole(turns[index]) === 'user' && normalizedTurnText(turns[index]) === expected) {
        userIndex = index
        break
      }
    }
    if (userIndex < 0) return null
    for (let index = userIndex + 1; index < turns.length; index += 1) {
      const role = turnRole(turns[index])
      if (role === 'assistant') return turns[index]
      if (role === 'user') return null
    }
    return null
  }

  function isReady() { return composer() !== null }

  function getConversationUrl(raw = location.href) {
    let url
    try { url = new URL(raw, location.href) } catch { return null }
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port !== '') return null
    const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname)
    const id = match?.[1]
    if (!id || id.startsWith('WEB:')) return null
    return `https://chatgpt.com/c/${id}`
  }

  function managedConversationMissing(expectedUrl) {
    const error = new Error(`Managed ChatGPT conversation is unavailable: ${expectedUrl}`)
    error.code = 'CHATGPT_CONVERSATION_MISSING'
    return error
  }

  async function waitForManagedConversation(expectedUrl, timeoutMs = 10000) {
    const expected = getConversationUrl(expectedUrl)
    if (!expected) throw managedConversationMissing(expectedUrl)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (getConversationUrl() === expected && conversationTurns().length > 0) return
      await sleep(100)
    }
    throw managedConversationMissing(expected)
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (descriptor?.set) descriptor.set.call(element, value)
    else element.value = value
  }

  function setComposerText(element, text) {
    element.focus()
    if ('value' in element && typeof element.value === 'string') {
      setNativeValue(element, text)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    const selection = globalThis.getSelection?.()
    if (selection && document.createRange) {
      const range = document.createRange()
      range.selectNodeContents(element)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    let inserted = false
    try {
      inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
    } catch {
      inserted = false
    }
    if (!inserted) {
      element.textContent = text
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
  }

  async function waitForSendButton(timeoutMs = 5000, isAborted = () => false) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (isAborted()) throw new Error('generation aborted before Send')
      const button = sendButton()
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return button
      await sleep(50)
    }
    throw new Error('ChatGPT send button did not become ready')
  }

  async function sendMessage(text, options = {}) {
    const input = composer()
    if (!input) throw new Error('ChatGPT composer was not found')
    const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false
    const beforeSend = typeof options.beforeSend === 'function' ? options.beforeSend : async () => {}
    if (isAborted()) throw new Error('generation aborted before Send')

    lastSendBaseline = { assistantCount: assistantTurns().length, assistantText: latestAssistantText() }
    setComposerText(input, text)
    const button = await waitForSendButton(options.sendTimeoutMs ?? 5000, isAborted)
    if (isAborted()) throw new Error('generation aborted before Send')

    // Publish the conservative boundary before the synchronous click. If this
    // acknowledgement cannot reach the local bridge, the prompt is not sent.
    await beforeSend()
    if (isAborted()) throw new Error('generation aborted at Send boundary')
    button.click()
    return { ...lastSendBaseline }
  }

  async function observeGeneration(options = {}) {
    const baseline = options.baseline ?? lastSendBaseline
    const requestPrompt = typeof options.requestPrompt === 'string' && options.requestPrompt.trim() !== ''
      ? options.requestPrompt
      : null
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {}
    const startTimeoutMs = options.startTimeoutMs ?? 30000
    const completionStabilityMs = options.completionStabilityMs ?? 700
    const overallTimeoutMs = options.overallTimeoutMs ?? 10 * 60 * 1000
    const startedAt = Date.now()
    const startDeadline = startedAt + startTimeoutMs
    const overallDeadline = startedAt + overallTimeoutMs

    let started = false
    let responseVisible = false
    let latestRaw = ''
    let accepted = ''
    let lastChangeAt = Date.now()
    let scheduled = false

    return await new Promise((resolve, reject) => {
      let interval
      let observer
      const cleanup = () => {
        if (interval !== undefined) clearInterval(interval)
        observer?.disconnect()
      }
      const fail = error => { cleanup(); reject(error) }

      const inspect = () => {
        scheduled = false
        const now = Date.now()
        if (now >= overallDeadline) {
          fail(new Error('Timed out waiting for ChatGPT generation to complete'))
          return
        }

        const anchoredTurn = requestPrompt === null ? null : assistantTurnAfterPrompt(requestPrompt)
        const count = assistantTurns().length
        const text = requestPrompt === null ? latestAssistantText() : assistantText(anchoredTurn)
        const stopping = stopButton() !== null
        const newAssistantTurn = requestPrompt === null ? count > baseline.assistantCount : anchoredTurn !== null

        if (!started && (stopping || newAssistantTurn)) {
          started = true
          lastChangeAt = now
        }
        if (!started) {
          if (now >= startDeadline) fail(new Error('ChatGPT generation did not start'))
          return
        }

        // ChatGPT may briefly mount a new assistant node whose contents are a
        // clone of the previous answer. That node proves the new turn exists,
        // but its baseline-identical text is not safe to stream yet. If the
        // real answer diverges we start streaming then; if generation finishes
        // with the same text, return it only as the authoritative final value.
        if (!responseVisible && newAssistantTurn && text === baseline.assistantText) {
          if (text !== latestRaw) {
            latestRaw = text
            lastChangeAt = now
          }
          if (!stopping && text !== '' && now - lastChangeAt >= completionStabilityMs) {
            cleanup()
            resolve(text)
            return
          }
          if (now >= startDeadline && !stopping && text === '') {
            fail(new Error('ChatGPT generation started but no new assistant response appeared'))
          }
          return
        }

        // With requestPrompt present, the response is anchored to the assistant
        // turn following this exact submitted user turn. Remounted older history
        // therefore cannot become the current response merely by appearing last.
        if (!responseVisible && newAssistantTurn) {
          responseVisible = true
          latestRaw = ''
          accepted = ''
          lastChangeAt = now
        }
        if (!responseVisible) {
          // A live Stop control proves that generation is still in progress.
          // ChatGPT can spend longer than the normal first-content deadline in
          // reasoning before it inserts visible assistant text, so keep waiting
          // while Stop is present and let the overall timeout be the hard cap.
          if (now >= startDeadline && !stopping) fail(new Error('ChatGPT generation started but no new assistant response appeared'))
          return
        }

        if (text !== latestRaw) {
          latestRaw = text
          lastChangeAt = now
          if (text.startsWith(accepted)) {
            const delta = text.slice(accepted.length)
            accepted = text
            onUpdate({ text, append: true, delta })
          } else {
            onUpdate({ text, append: false, delta: '' })
          }
        }

        if (!stopping && text !== '' && now - lastChangeAt >= completionStabilityMs) {
          cleanup()
          resolve(text)
        }
      }

      const scheduleInspect = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(inspect)
      }
      observer = new MutationObserver(scheduleInspect)
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
      interval = setInterval(inspect, 100)
      inspect()
    })
  }

  function stopGeneration() {
    const button = stopButton()
    if (!button) return false
    button.click()
    return true
  }

  globalThis.__DSH_CHATGPT_PAGE_ADAPTER__ = Object.freeze({
    isReady,
    waitForManagedConversation,
    sendMessage,
    observeGeneration,
    stopGeneration,
    getConversationUrl,
  })
})()