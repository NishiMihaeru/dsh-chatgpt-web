(() => {
  'use strict'

  let activeRun = null
  let emitChain = Promise.resolve()

  function page() {
    const adapter = globalThis.__DSH_CHATGPT_PAGE_ADAPTER__
    if (!adapter) throw new Error('ChatGPT page adapter is not loaded')
    return adapter
  }

  function emit(payload) {
    const operation = emitChain.then(async () => {
      try {
        const response = await chrome.runtime.sendMessage({ kind: 'dsh-event', payload })
        return response?.forwarded === true
      } catch {
        return false
      }
    })
    emitChain = operation.then(() => undefined, () => undefined)
    return operation
  }

  async function runGeneration(message) {
    const run = { requestId: message.requestId, seq: message.startSeq ?? 0, afterSend: false, aborted: false }
    activeRun = run
    let urlReported = false
    let urlReporting = false
    let urlTimer
    const nextSeq = () => run.seq++

    const reportUrl = async () => {
      if (run.aborted || urlReported || urlReporting || activeRun !== run) return
      const url = page().getConversationUrl()
      if (!url) return
      urlReporting = true
      const forwarded = await emit({ type: 'session-ready', requestId: run.requestId, conversationUrl: url, seq: nextSeq() })
      urlReporting = false
      if (forwarded) urlReported = true
    }

    try {
      if (!page().isReady()) throw new Error('ChatGPT page is not ready')
      if (message.conversationUrl) {
        await page().waitForManagedConversation(message.conversationUrl)
        if (run.aborted || activeRun !== run) return
      }
      const baseline = await page().sendMessage(message.prompt, {
        isAborted: () => run.aborted || activeRun !== run,
        beforeSend: async () => {
          if (run.aborted || activeRun !== run) throw new Error('generation aborted before Send')
          run.afterSend = true
          const forwarded = await emit({ type: 'request-state', requestId: run.requestId, stage: 'sent', seq: nextSeq() })
          if (!forwarded) throw new Error('local bridge disconnected before Send')
        },
      })
      if (run.aborted || activeRun !== run) return
      await reportUrl()
      urlTimer = setInterval(() => { void reportUrl() }, 100)
      void emit({ type: 'request-state', requestId: run.requestId, stage: 'generating', seq: nextSeq() })

      const finalText = await page().observeGeneration({
        baseline,
        onUpdate(update) {
          if (run.aborted || activeRun !== run) return
          void reportUrl()
          if (update.append && update.delta) void emit({ type: 'delta', requestId: run.requestId, text: update.delta, seq: nextSeq() })
        },
      })

      if (run.aborted || activeRun !== run) return
      await reportUrl()
      if (!urlReported) throw new Error('ChatGPT conversation URL was not created')
      await emit({ type: 'generation-complete', requestId: run.requestId, text: finalText, seq: nextSeq() })
    } catch (error) {
      if (!run.aborted && activeRun === run) {
        const code = error && typeof error === 'object' && typeof error.code === 'string'
          ? error.code
          : 'CHATGPT_PAGE'
        await emit({
          type: 'error', requestId: run.requestId, code,
          message: error instanceof Error ? error.message : String(error),
          afterSend: run.afterSend, seq: nextSeq(),
        })
      }
    } finally {
      if (urlTimer !== undefined) clearInterval(urlTimer)
      if (activeRun === run) activeRun = null
    }
  }

  async function abortGeneration(requestId) {
    const run = activeRun
    if (run === null || run.requestId !== requestId) return false
    run.aborted = true
    page().stopGeneration()
    await emit({ type: 'generation-aborted', requestId, seq: run.seq++ })
    if (activeRun === run) activeRun = null
    return true
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === 'dsh-ping') {
      sendResponse({ ready: page().isReady() })
      return false
    }
    if (message?.kind === 'dsh-generate') {
      if (activeRun !== null) {
        sendResponse({ accepted: false, error: 'worker tab already has an active request' })
        return false
      }
      void runGeneration(message)
      sendResponse({ accepted: true })
      return false
    }
    if (message?.kind === 'dsh-abort') {
      void abortGeneration(message.requestId).then(stopped => sendResponse({ stopped })).catch(error => {
        sendResponse({ stopped: false, error: error instanceof Error ? error.message : String(error) })
      })
      return true
    }
    return false
  })
})()
