import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CHATGPT_WEB_CODES, ChatGptWebAdapter } from '../src/adapter.js'
import type { ChatTransport, TransportEvent } from '../src/protocol.js'
import { RequestQueue } from '../src/request-queue.js'
import { SessionManager } from '../src/session-manager.js'

function request(signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'chatgpt-web',
    model: 'auto',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    sessionId: 'terminal-test' as never,
    ...(signal === undefined ? {} : { signal }),
  }
}

async function makeAdapter(transport: ChatTransport): Promise<{ adapter: ChatGptWebAdapter; sessions: SessionManager }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-terminal-'))
  const sessions = new SessionManager(join(directory, 'state.json'))
  return {
    adapter: new ChatGptWebAdapter({ transport, sessions, queue: new RequestQueue() }),
    sessions,
  }
}

async function collectFailure(adapter: ChatGptWebAdapter, options: GenerateOptions): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    assert.fail('expected adapter stream to fail')
  } catch (error) {
    return { chunks, error }
  }
}

test('post-delta transport failure exposes no unstable browser text before throwing', async () => {
  const transport: ChatTransport = {
    async *generate(req): AsyncIterable<TransportEvent> {
      yield { type: 'state', requestId: req.requestId, stage: 'sent', seq: 0 }
      yield { type: 'session-ready', requestId: req.requestId, conversationUrl: 'https://chatgpt.com/c/failure', seq: 1 }
      yield { type: 'delta', requestId: req.requestId, text: 'partial', seq: 2 }
      yield { type: 'error', requestId: req.requestId, code: 'DOM', message: 'page vanished', afterSend: true, seq: 3 }
    },
    async abort() {},
    async dispose() {},
  }
  const { adapter } = await makeAdapter(transport)
  const { chunks, error } = await collectFailure(adapter, request())
  assert.equal((error as { code?: unknown }).code, CHATGPT_WEB_CODES.UNCERTAIN)
  assert.deepEqual(chunks, [])
})

test('abort after a browser delta exposes no unstable text before aborted finish', async () => {
  let release: (() => void) | undefined
  let sawDelta: (() => void) | undefined
  const deltaSeen = new Promise<void>(resolve => { sawDelta = resolve })
  const transport: ChatTransport = {
    async *generate(req): AsyncIterable<TransportEvent> {
      yield { type: 'state', requestId: req.requestId, stage: 'sent', seq: 0 }
      yield { type: 'delta', requestId: req.requestId, text: 'partial', seq: 1 }
      sawDelta?.()
      await new Promise<void>(resolve => { release = resolve })
    },
    async abort() { release?.() },
    async dispose() {},
  }
  const { adapter } = await makeAdapter(transport)
  const controller = new AbortController()
  const chunks: StreamChunk[] = []
  const running = (async () => {
    for await (const chunk of adapter.stream(request(controller.signal))) chunks.push(chunk)
  })()
  await deltaSeen
  controller.abort()
  await running

  assert.equal(chunks.length, 1)
  const finish = chunks[0]
  assert.equal(finish?.type, 'finish')
  if (finish?.type === 'finish') assert.equal(finish.reason.kind, 'aborted')
})

test('empty ChatGPT completion fails with canonical EMPTY_RESPONSE and invalidates mapping', async () => {
  const transport: ChatTransport = {
    async *generate(req): AsyncIterable<TransportEvent> {
      yield { type: 'state', requestId: req.requestId, stage: 'sent', seq: 0 }
      yield { type: 'session-ready', requestId: req.requestId, conversationUrl: 'https://chatgpt.com/c/empty', seq: 1 }
      yield { type: 'complete', requestId: req.requestId, text: '', seq: 2 }
    },
    async abort() {},
    async dispose() {},
  }
  const { adapter, sessions } = await makeAdapter(transport)
  const { chunks, error } = await collectFailure(adapter, request())
  assert.deepEqual(chunks, [])
  assert.equal((error as { code?: unknown }).code, 'EMPTY_RESPONSE')
  assert.equal((await sessions.get('terminal-test'))?.status, 'uncertain')
})

test('unstable browser deltas stay internal and authoritative completion is the only DSH text', async () => {
  const transport: ChatTransport = {
    async *generate(req): AsyncIterable<TransportEvent> {
      yield { type: 'state', requestId: req.requestId, stage: 'sent', seq: 0 }
      yield { type: 'session-ready', requestId: req.requestId, conversationUrl: 'https://chatgpt.com/c/rewrite', seq: 1 }
      yield { type: 'delta', requestId: req.requestId, text: 'первый', seq: 2 }
      yield { type: 'complete', requestId: req.requestId, text: 'второй', seq: 3 }
    },
    async abort() {},
    async dispose() {},
  }
  const { adapter } = await makeAdapter(transport)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request())) chunks.push(chunk)

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'второй' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'второй' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})
