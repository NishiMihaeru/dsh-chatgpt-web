export const PROTOCOL = 'dsh-chatgpt-web-v1' as const

export type RequestStage =
  | 'queued'
  | 'navigating'
  | 'ready'
  | 'sent'
  | 'generating'
  | 'completed'
  | 'aborted'
  | 'uncertain'
  | 'failed'

export interface GenerateRequest {
  requestId: string
  sessionId: string
  conversationUrl?: string
  prompt: string
}

export type TransportEvent =
  | { type: 'state'; requestId: string; stage: 'navigating' | 'ready' | 'sent' | 'generating'; seq: number }
  | { type: 'session-ready'; requestId: string; conversationUrl: string; seq: number }
  | { type: 'delta'; requestId: string; text: string; seq: number }
  | { type: 'complete'; requestId: string; text: string; seq: number }
  | { type: 'aborted'; requestId: string; seq: number }
  | { type: 'error'; requestId: string; code: string; message: string; afterSend: boolean; seq: number }

export interface ChatTransport {
  generate(request: GenerateRequest, signal?: AbortSignal): AsyncIterable<TransportEvent>
  abort(requestId: string): Promise<void>
  dispose(): Promise<void>
}

export type PluginToExtensionMessage =
  | {
      protocol: typeof PROTOCOL
      type: 'generate'
      requestId: string
      sessionId: string
      conversationUrl?: string
      prompt: string
    }
  | {
      protocol: typeof PROTOCOL
      type: 'abort'
      requestId: string
    }
  | {
      protocol: typeof PROTOCOL
      type: 'ping'
      nonce: string
    }

export type ExtensionToPluginMessage =
  | {
      protocol: typeof PROTOCOL
      type: 'hello'
      extensionVersion: string
    }
  | {
      protocol: typeof PROTOCOL
      type: 'request-state'
      requestId: string
      stage: 'navigating' | 'ready' | 'sent' | 'generating'
      seq: number
    }
  | {
      protocol: typeof PROTOCOL
      type: 'session-ready'
      requestId: string
      conversationUrl: string
      seq: number
    }
  | {
      protocol: typeof PROTOCOL
      type: 'delta'
      requestId: string
      text: string
      seq: number
    }
  | {
      protocol: typeof PROTOCOL
      type: 'generation-complete'
      requestId: string
      text: string
      seq: number
    }
  | {
      protocol: typeof PROTOCOL
      type: 'generation-aborted'
      requestId: string
      seq: number
    }
  | {
      protocol: typeof PROTOCOL
      type: 'error'
      requestId: string
      code: string
      message: string
      afterSend: boolean
      seq: number
    }
  | {
      protocol: typeof PROTOCOL
      type: 'pong'
      nonce: string
    }

function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bridge message must be a JSON object')
  }
  return value as Record<string, unknown>
}

function stringField(object: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = object[key]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`bridge message field ${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function seqField(object: Record<string, unknown>): number {
  const value = object.seq
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('bridge message field seq must be a non-negative safe integer')
  }
  return value as number
}

function requestStage(value: unknown): 'navigating' | 'ready' | 'sent' | 'generating' {
  if (value === 'navigating' || value === 'ready' || value === 'sent' || value === 'generating') return value
  throw new Error('bridge request-state has an invalid stage')
}

export function canonicalManagedConversationUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('managed conversation URL is invalid')
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'chatgpt.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error('managed conversation URL must use https://chatgpt.com')
  }

  const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname)
  if (match?.[1] === undefined || match[1].length === 0) {
    throw new Error('managed conversation URL must identify /c/<id>')
  }

  return `https://chatgpt.com/c/${match[1]}`
}

export function parseExtensionMessage(raw: string): ExtensionToPluginMessage {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('bridge message is not valid JSON')
  }

  const object = objectRecord(decoded)
  if (object.protocol !== PROTOCOL) throw new Error(`unsupported bridge protocol: ${String(object.protocol)}`)
  const type = stringField(object, 'type')

  switch (type) {
    case 'hello':
      return {
        protocol: PROTOCOL,
        type,
        extensionVersion: stringField(object, 'extensionVersion'),
      }
    case 'request-state':
      return {
        protocol: PROTOCOL,
        type,
        requestId: stringField(object, 'requestId'),
        stage: requestStage(object.stage),
        seq: seqField(object),
      }
    case 'session-ready':
      return {
        protocol: PROTOCOL,
        type,
        requestId: stringField(object, 'requestId'),
        conversationUrl: canonicalManagedConversationUrl(stringField(object, 'conversationUrl')),
        seq: seqField(object),
      }
    case 'delta':
      return {
        protocol: PROTOCOL,
        type,
        requestId: stringField(object, 'requestId'),
        text: stringField(object, 'text', true),
        seq: seqField(object),
      }
    case 'generation-complete':
      return {
        protocol: PROTOCOL,
        type,
        requestId: stringField(object, 'requestId'),
        text: stringField(object, 'text', true),
        seq: seqField(object),
      }
    case 'generation-aborted':
      return {
        protocol: PROTOCOL,
        type,
        requestId: stringField(object, 'requestId'),
        seq: seqField(object),
      }
    case 'error': {
      const afterSend = object.afterSend
      if (typeof afterSend !== 'boolean') throw new Error('bridge error field afterSend must be boolean')
      return {
        protocol: PROTOCOL,
        type,
        requestId: stringField(object, 'requestId'),
        code: stringField(object, 'code'),
        message: stringField(object, 'message'),
        afterSend,
        seq: seqField(object),
      }
    }
    case 'pong':
      return {
        protocol: PROTOCOL,
        type,
        nonce: stringField(object, 'nonce'),
      }
    default:
      throw new Error(`unsupported bridge message type: ${type}`)
  }
}

export function wireGenerateMessage(request: GenerateRequest): PluginToExtensionMessage {
  return {
    protocol: PROTOCOL,
    type: 'generate',
    requestId: request.requestId,
    sessionId: request.sessionId,
    ...(request.conversationUrl === undefined
      ? {}
      : { conversationUrl: canonicalManagedConversationUrl(request.conversationUrl) }),
    prompt: request.prompt,
  }
}

export function wireAbortMessage(requestId: string): PluginToExtensionMessage {
  if (requestId.length === 0) throw new Error('requestId must not be empty')
  return { protocol: PROTOCOL, type: 'abort', requestId }
}

export function wirePingMessage(nonce: string): PluginToExtensionMessage {
  if (nonce.length === 0) throw new Error('ping nonce must not be empty')
  return { protocol: PROTOCOL, type: 'ping', nonce }
}
