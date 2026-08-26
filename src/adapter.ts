import { randomUUID } from 'node:crypto'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ChatTransport, TransportEvent } from './protocol.js'
import { RequestQueue } from './request-queue.js'
import { SessionManager } from './session-manager.js'

export const CHATGPT_WEB_PROVIDER = 'chatgpt-web'
export const CHATGPT_WEB_MODEL = 'auto'

export const CHATGPT_WEB_CODES = Object.freeze({
  INVALID_PROVIDER: 'CHATGPT_WEB_INVALID_PROVIDER',
  INVALID_MODEL: 'CHATGPT_WEB_INVALID_MODEL',
  SESSION_REQUIRED: 'CHATGPT_WEB_SESSION_REQUIRED',
  UNSUPPORTED: 'CHATGPT_WEB_UNSUPPORTED',
  UNCERTAIN: 'CHATGPT_WEB_UNCERTAIN',
  STREAM_REWRITE: 'CHATGPT_WEB_STREAM_REWRITE',
  CONVERSATION_MISSING: 'CHATGPT_WEB_CONVERSATION_MISSING',
  BRIDGE: 'CHATGPT_WEB_BRIDGE',
} as const)

const BROWSER_CONVERSATION_MISSING = 'CHATGPT_CONVERSATION_MISSING'

export interface ChatGptWebAdapterOptions {
  transport: ChatTransport
  sessions: SessionManager
  queue: RequestQueue
}

const MODEL_INFO: LlmResolvedModelInfo = Object.freeze({
  provider: CHATGPT_WEB_PROVIDER,
  id: CHATGPT_WEB_MODEL,
  name: 'ChatGPT Web (Auto)',
  description: 'Uses the model selected/defaulted by the authenticated ChatGPT Web UI',
  inputModalities: Object.freeze(['text'] as const),
})

const ABORTED = Symbol('aborted')

function validateRoute(provider: string, model?: string): void {
  if (provider !== CHATGPT_WEB_PROVIDER) {
    throw new LlmError(`ChatGPT Web adapter does not own provider route "${provider}"`, CHATGPT_WEB_CODES.INVALID_PROVIDER)
  }
  if (model !== undefined && model !== CHATGPT_WEB_MODEL) {
    throw new LlmError(`ChatGPT Web supports only model "${CHATGPT_WEB_MODEL}", not "${model}"`, CHATGPT_WEB_CODES.INVALID_MODEL)
  }
}

function assertSupportedRequest(options: GenerateOptions): void {
  validateRoute(options.provider, options.model)
  if (options.sessionId === undefined) {
    throw new LlmError('ChatGPT Web requires a DSH sessionId for managed-conversation routing', CHATGPT_WEB_CODES.SESSION_REQUIRED)
  }

  const unsupported: string[] = []
  if (options.reasoningEffort !== undefined) unsupported.push('reasoningEffort')
  if (options.temperature !== undefined) unsupported.push('temperature')
  if (options.maxTokens !== undefined) unsupported.push('maxTokens')
  if (options.stop !== undefined) unsupported.push('stop')
  if (options.purpose !== undefined) unsupported.push('purpose')
  if (unsupported.length > 0) {
    throw new LlmError(
      `ChatGPT Web v0.1 cannot honor GenerateOptions fields: ${unsupported.join(', ')}`,
      CHATGPT_WEB_CODES.UNSUPPORTED,
    )
  }
}

function textBlockEnd(text: string): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'text', text } }
}

function abortedFinish(message = 'ChatGPT Web generation was aborted'): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'aborted',
      failure: { message, code: 'ABORTED' },
    },
  }
}

function preview(text: string): string {
  return JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text)
}

async function nextEvent(
  iterator: AsyncIterator<TransportEvent>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<TransportEvent> | typeof ABORTED> {
  if (signal === undefined) return iterator.next()
  if (signal.aborted) return ABORTED
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      resolve(ABORTED)
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    void iterator.next().then(
      result => {
        cleanup()
        resolve(result)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

function closeIteratorInBackground(iterator: AsyncIterator<TransportEvent>): void {
  const closing = iterator.return?.()
  if (closing !== undefined) void Promise.resolve(closing).catch(() => {})
}

export class ChatGptWebAdapter extends LlmAdapter {
  private readonly transport: ChatTransport
  private readonly sessions: SessionManager
  private readonly queue: RequestQueue

  constructor(options: ChatGptWebAdapterOptions) {
    super()
    this.transport = options.transport
    this.sessions = options.sessions
    this.queue = options.queue
  }

  override providerInfo(provider: string): LlmProviderInfo {
    validateRoute(provider)
    return { id: CHATGPT_WEB_PROVIDER, name: 'ChatGPT Web' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    validateRoute(provider)
    return [MODEL_INFO]
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    validateRoute(provider, model)
    if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
    return MODEL_INFO
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    assertSupportedRequest(options)
    const sessionId = String(options.sessionId)
    const release = await this.queue.acquire(options.signal)

    try {
      let plan = await this.sessions.plan(sessionId, options.system, options.messages)

      attemptLoop:
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const requestId = `req_${randomUUID()}`
        let uncertainBoundary = false
        let blockStarted = false
        let streamed = ''
        let conversationUrl = plan.kind === 'continue' ? plan.conversationUrl : undefined

        const iterable = this.transport.generate({
          requestId,
          sessionId,
          ...(conversationUrl === undefined ? {} : { conversationUrl }),
          prompt: plan.prompt,
        }, options.signal)
        const iterator = iterable[Symbol.asyncIterator]()

        while (true) {
          const next = await nextEvent(iterator, options.signal)
          if (next === ABORTED) {
            await this.transport.abort(requestId)
            await this.sessions.markUncertain(sessionId)
            closeIteratorInBackground(iterator)
            if (blockStarted) yield textBlockEnd(streamed)
            yield abortedFinish()
            return
          }
          if (next.done) break

          const event = next.value
          switch (event.type) {
            case 'state':
              if (event.stage === 'sent' || event.stage === 'generating') uncertainBoundary = true
              break
            case 'session-ready':
              conversationUrl = event.conversationUrl
              break
            case 'delta':
              if (event.text.length === 0) break
              if (!blockStarted) {
                blockStarted = true
                yield { type: 'block-start', index: 0, blockType: 'text' }
              }
              streamed += event.text
              yield { type: 'text-delta', index: 0, text: event.text }
              break
            case 'complete': {
              const finalText = event.text
              if (!finalText.startsWith(streamed)) {
                if (blockStarted) yield textBlockEnd(streamed)
                await this.sessions.markUncertain(sessionId)
                throw new LlmError(
                  `ChatGPT Web rewrote already-streamed assistant text; streamed=${preview(streamed)} (${streamed.length} chars), final=${preview(finalText)} (${finalText.length} chars)`,
                  CHATGPT_WEB_CODES.STREAM_REWRITE,
                )
              }
              const suffix = finalText.slice(streamed.length)
              if (suffix.length > 0) {
                if (!blockStarted) {
                  blockStarted = true
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                }
                streamed += suffix
                yield { type: 'text-delta', index: 0, text: suffix }
              }
              if (finalText.length === 0) {
                await this.sessions.markUncertain(sessionId)
                throw new LlmError('ChatGPT Web produced an empty assistant response', 'EMPTY_RESPONSE')
              }
              if (conversationUrl === undefined) {
                if (blockStarted) yield textBlockEnd(finalText)
                await this.sessions.markUncertain(sessionId)
                throw new LlmError(
                  'ChatGPT Web completed a new conversation without reporting its managed URL',
                  CHATGPT_WEB_CODES.CONVERSATION_MISSING,
                )
              }

              await this.sessions.commitSuccess(sessionId, options.system, options.messages, conversationUrl, finalText)
              if (blockStarted) yield textBlockEnd(finalText)
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            case 'aborted':
              await this.sessions.markUncertain(sessionId)
              if (blockStarted) yield textBlockEnd(streamed)
              yield abortedFinish()
              return
            case 'error':
              if (
                event.code === BROWSER_CONVERSATION_MISSING
                && !event.afterSend
                && !uncertainBoundary
                && plan.kind === 'continue'
                && attempt === 0
                && !blockStarted
              ) {
                closeIteratorInBackground(iterator)
                await this.sessions.reset(sessionId)
                plan = await this.sessions.plan(sessionId, options.system, options.messages)
                continue attemptLoop
              }
              if (blockStarted) yield textBlockEnd(streamed)
              if (event.afterSend || uncertainBoundary) {
                await this.sessions.markUncertain(sessionId)
                throw new LlmError(
                  `ChatGPT Web request became uncertain after dispatch: ${event.message}`,
                  CHATGPT_WEB_CODES.UNCERTAIN,
                )
              }
              throw new LlmError(
                `ChatGPT Web bridge error (${event.code}): ${event.message}`,
                CHATGPT_WEB_CODES.BRIDGE,
              )
          }
        }

        if (blockStarted) yield textBlockEnd(streamed)
        if (uncertainBoundary) await this.sessions.markUncertain(sessionId)
        throw new LlmError(
          'ChatGPT Web bridge ended before generation completed',
          uncertainBoundary ? CHATGPT_WEB_CODES.UNCERTAIN : CHATGPT_WEB_CODES.BRIDGE,
        )
      }

      throw new LlmError('ChatGPT Web managed-conversation recovery was exhausted', CHATGPT_WEB_CODES.BRIDGE)
    } finally {
      release()
    }
  }
}
