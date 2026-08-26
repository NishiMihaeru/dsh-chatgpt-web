(() => {
  'use strict'

  const TRANSIENT_STATUS = new Set([
    'thinking',
    'thinking…',
    'thinking...',
    'думаю',
    'думаю…',
    'думаю...',
    'размышляю',
    'размышляю…',
    'размышляю...',
  ])

  let lastSendBaseline = { assistantCount: 0, assistantText: '' }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function composer() {
    return document.querySelector('#prompt-textarea')
      ?? document.querySelector('textarea[data-id="root"]')
      ?? document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('div[contenteditable="true"]')
  }

  function candidateButtons() {
    return Array.from(document.querySelectorAll('button'))
  }

  function buttonLabel(button) {
    return [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.textContent,
    ].filter(Boolean).join(' ').trim().toLowerCase()
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

  function assistantTurns() {
    const articles = Array.from(document.querySelectorAll('article[data-turn="assistant"]'))
    if (articles.length > 0) return articles
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
  }

  function cleanAssistantText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    while (lines.length > 0 && TRANSIENT_STATUS.has(lines[0].trim().toLowerCase())) lines.shift()
    const cleaned = lines.join('\n').trim()
    if (TRANSIENT_STATUS.has(cleaned.toLowerCase())) return ''
    return cleaned
  }

  function latestAssistantText() {
    const turns = assistantTurns()
    const turn = turns.at(-1)
    if (!turn) return ''
    const answer = turn.querySelector('[data-message-content]')
      ?? turn.querySelector('.markdown')
      ?? turn.querySelector('.prose')
      ?? turn.querySelector('[class*="markdown"]')
      ?? turn
    return cleanAssistantText(answer.innerText || answer.textContent || '')
  }

  function isReady() {
    return composer() !== null
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

  async function waitForSendButton(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const button = sendButton()
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return button
      await sleep(50)
    }
    throw new Error('ChatGPT send button did not become ready')
  }

  async function sendMessage(text) {
    const input = composer()
    if (!input) throw new Error('ChatGPT composer was not found')
    lastSendBaseline = {
      assistantCount: assistantTurns().length,
      assistantText: latestAssistantText(),
    }
    setComposerText(input, text)
    const button = await waitForSendButton()
    button.click()
    return { ...lastSendBaseline }
  }

  async function observeGeneration(options = {}) {
    const baseline = options.baseline ?? lastSendBaseline
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {}
    const startTimeoutMs = options.startTimeoutMs ?? 30000
    const completionStabilityMs = options.completionStabilityMs ?? 700
    const overallTimeoutMs = options.overallTimeoutMs ?? 10 * 60 * 1000
    const startedAt = Date.now()
    const startDeadline = startedAt + startTimeoutMs
    const overallDeadline = startedAt + overallTimeoutMs

    let started = false
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

      const fail = error => {
        cleanup()
        reject(error)
      }

      const inspect = () => {
        scheduled = false
        const now = Date.now()
        if (now >= overallDeadline) {
          fail(new Error('Timed out waiting for ChatGPT generation to complete'))
          return
        }

        const count = assistantTurns().length
        const text = latestAssistantText()
        const stopping = stopButton() !== null
        if (!started && (stopping || count > baseline.assistantCount || (text !== '' && text !== baseline.assistantText))) {
          started = true
          latestRaw = ''
          accepted = ''
          lastChangeAt = now
        }

        if (!started) {
          if (now >= startDeadline) fail(new Error('ChatGPT generation did not start'))
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

  function getConversationUrl(raw = location.href) {
    let url
    try {
      url = new URL(raw, location.href)
    } catch {
      return null
    }
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port !== '') return null
    const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname)
    if (!match?.[1]) return null
    return `https://chatgpt.com/c/${match[1]}`
  }

  globalThis.__DSH_CHATGPT_PAGE_ADAPTER__ = Object.freeze({
    isReady,
    sendMessage,
    observeGeneration,
    stopGeneration,
    getConversationUrl,
  })
})()
