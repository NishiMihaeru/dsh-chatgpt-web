import { createHash } from 'node:crypto'
import {
  createAssistantMessage,
  LlmError,
  type ContentBlock,
  type Message,
} from '@deepseek-ai/dsh-llm'

export const UNSUPPORTED_IMAGE_CODE = 'CHATGPT_WEB_UNSUPPORTED_IMAGE'
export const UNSUPPORTED_BLOCK_CODE = 'CHATGPT_WEB_UNSUPPORTED'

function normalizedBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'image':
      throw new LlmError('ChatGPT Web v0.1 does not support image input', UNSUPPORTED_IMAGE_CODE)
    case 'tool-call':
      return {
        type: 'tool-call',
        id: String(block.id),
        name: block.name,
        arguments: block.arguments,
      }
    case 'tool-result':
      return {
        type: 'tool-result',
        toolCallId: String(block.toolCallId),
        ...(block.isError === undefined ? {} : { isError: block.isError }),
        content: block.content.map(normalizedBlock),
      }
    default:
      throw new LlmError(
        `ChatGPT Web v0.1 cannot serialize content block type ${String((block as { type?: unknown }).type)}`,
        UNSUPPORTED_BLOCK_CODE,
      )
  }
}

export function normalizedMessage(message: Message): unknown {
  return {
    role: message.role,
    content: message.content.map(normalizedBlock),
  }
}

export function historyDigest(messages: readonly Message[]): string {
  const normalized = messages.map(normalizedMessage)
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function indent(value: string, prefix = '  '): string {
  return value.split('\n').map(line => `${prefix}${line}`).join('\n')
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return `[text]\n${block.text}`
    case 'reasoning':
      return `[reasoning-context]\n${block.text}`
    case 'image':
      throw new LlmError('ChatGPT Web v0.1 does not support image input', UNSUPPORTED_IMAGE_CODE)
    case 'tool-call':
      return `[historical-tool-call name=${JSON.stringify(block.name)} id=${JSON.stringify(String(block.id))}]\n${block.arguments}`
    case 'tool-result': {
      const nested = block.content.map(serializeBlock).join('\n')
      return `[historical-tool-result callId=${JSON.stringify(String(block.toolCallId))} isError=${String(block.isError ?? false)}]\n${indent(nested)}`
    }
    default:
      throw new LlmError(
        `ChatGPT Web v0.1 cannot serialize content block type ${String((block as { type?: unknown }).type)}`,
        UNSUPPORTED_BLOCK_CODE,
      )
  }
}

export function serializeHistory(messages: readonly Message[]): string {
  return messages.map((message, index) => {
    const blocks = message.content.map(serializeBlock).join('\n\n')
    return `--- message ${index + 1} role=${message.role} ---\n${blocks}`
  }).join('\n\n')
}

export function syntheticAssistantMessage(text: string): Message {
  return createAssistantMessage({
    content: [{ type: 'text', text }],
    source: {
      provider: 'chatgpt-web',
      model: 'auto',
    },
  })
}
