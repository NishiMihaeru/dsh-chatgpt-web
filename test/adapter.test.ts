import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  CHATGPT_WEB_CODES,
  CHATGPT_WEB_MODEL,
  CHATGPT_WEB_PROVIDER,
  ChatGptWebAdapter,
} from '../src/adapter.js'
import type { ChatTransport, GenerateRequest, TransportEvent } from '../src/protocol.js'
import { RequestQueue } from '../src/request-queue.js'
import { SessionManager } from '../src/session-manager.js'

function user(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CHATGPT_WEB_PROVIDER,
    model: CHATGPT_WEB_MODEL,
    messages: [user('hello')],
    sessionId: 'session-1' as never,
    ...overrides,
  }
}

class FakeTransport implements ChatTransport {
  readonly requests: GenerateRequest[] = []
  readonly aborts: string[] = []

  constructor(private readonly events: TransportEvent[]) {}

  async *generate(request: GenerateRequest): AsyncIterable<TransportEvent> {
    this.requests.push(request)
    for (const event of this.events) yield { ...event, requestId: request.requestId } as TransportEvent
  }

  async abort(requestId: string): Promise<void> {
    this.aborts.push(requestId)
  }

  async dispose(): Promise<void> {}
}

async function adapterFor(transport: ChatTransport): Promise<ChatGptWebAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-adapter-'))
  return new ChatGptWebAdapter({
    transport,
    sessions: new SessionManager(join(directory, 'state.json')),
    queue: new RequestQueue(),
  })
}

async function collect(adapter: ChatGptWebAdapter, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

async function expectStreamCode(adapter: ChatGptWebAdapter, request: GenerateOptions, code: string): Promise<void> {
  try {
    await collect(adapter, request)
    assert.fail(`expected stream to fail with ${code}`)
  } catch (error) {
    assert.equal((error as { code?: unknown }).code, code)
  }
}

test('provider and model metadata expose exactly chatgpt-web/auto text-only', async () => {
  const adapter = await adapterFor(new FakeTransport([]))
  assert.deepEqual(adapter.providerInfo(CHATGPT_WEB_PROVIDER), { id: 'chatgpt-web', name: 'ChatGPT Web' })
  const models = await adapter.listModels(CHATGPT_WEB_PROVIDER)
  assert.equal(models.length, 1)
  assert.equal(models[0]?.id, 'auto')
  assert.deepEqual(models[0]?.inputModalities, ['text'])
  await assert.rejects(adapter.resolveModel(CHATGPT_WEB_PROVIDER, 'other'), error => (error as { code?: unknown }).code === CHATGPT_WEB_CODES.INVALID_MODEL)
  assert.throws(() => adapter.providerInfo('other'), error => (error as { code?: unknown }).code === CHATGPT_WEB_CODES.INVALID_PROVIDER)
})

test('adapter requires sessionId and rejects unsupported generation controls', async () => {
  const adapter = await adapterFor(new FakeTransport([]))
  await expectStreamCode(adapter, options({ sessionId: undefined }), CHATGPT_WEB_CODES.SESSION_REQUIRED)

  for (const override of [
    { reasoningEffort: 'high' as never },
    { temperature: 0 },
    { maxTokens: 10 },
    { stop: [] },
    { purpose: 'session-title' as const },
  ]) {
    await expectStreamCode(adapter, options(override), CHATGPT_WEB_CODES.UNSUPPORTED)
  }
})

test('tools are accepted but transport receives only browser prompt fields', async () => {
  const transport = new FakeTransport([
    { type: 'session-ready', requestId: 'placeholder', conversationUrl: 'https://chatgpt.com/c/a', seq: 0 },
    { type: 'complete', requestId: 'placeholder', text: 'ok', seq: 1 },
  ])
  const adapter = await adapterFor(transport)
  const chunks = await collect(adapter, options({
    tools: [{ name: 'bash', description: 'not exposed in v0.1', parameters: { type: 'object' } }],
  }))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(transport.requests.length, 1)
  assert.deepEqual(Object.keys(transport.requests[0] ?? {}).sort(), ['prompt', 'requestId', 'sessionId'])
})

test('image input fails with the dedicated unsupported-image code', async () => {
  const adapter = await adapterFor(new FakeTransport([]))
  const imageMessage = {
    ...user('x'),
    content: [{ type: 'image', attachment: {} }],
  } as never
  await expectStreamCode(adapter, options({ messages: [imageMessage] }), 'CHATGPT_WEB_UNSUPPORTED_IMAGE')
})

test('stream emits append-only deltas and authoritative final block', async () => {
  const transport = new FakeTransport([
    { type: 'state', requestId: 'placeholder', stage: 'sent', seq: 0 },
    { type: 'session-ready', requestId: 'placeholder', conversationUrl: 'https://chatgpt.com/c/a', seq: 1 },
    { type: 'delta', requestId: 'placeholder', text: 'hel', seq: 2 },
    { type: 'complete', requestId: 'placeholder', text: 'hello', seq: 3 },
  ])
  const adapter = await adapterFor(transport)
  const chunks = await collect(adapter, options())
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('non-prefix final snapshot is refused because already-streamed text cannot be rewritten', async () => {
  const transport = new FakeTransport([
    { type: 'state', requestId: 'placeholder', stage: 'sent', seq: 0 },
    { type: 'session-ready', requestId: 'placeholder', conversationUrl: 'https://chatgpt.com/c/a', seq: 1 },
    { type: 'delta', requestId: 'placeholder', text: 'abc', seq: 2 },
    { type: 'complete', requestId: 'placeholder', text: 'axc', seq: 3 },
  ])
  const adapter = await adapterFor(transport)
  await expectStreamCode(adapter, options(), CHATGPT_WEB_CODES.STREAM_REWRITE)
})

test('explicit error after ready but before Send stays a retry-safe bridge failure', async () => {
  const transport = new FakeTransport([
    { type: 'state', requestId: 'placeholder', stage: 'ready', seq: 0 },
    { type: 'error', requestId: 'placeholder', code: 'COMPOSER', message: 'composer unavailable', afterSend: false, seq: 1 },
  ])
  const adapter = await adapterFor(transport)
  await expectStreamCode(adapter, options(), CHATGPT_WEB_CODES.BRIDGE)
})

test('after-send bridge error marks the request uncertain', async () => {
  const transport = new FakeTransport([
    { type: 'state', requestId: 'placeholder', stage: 'sent', seq: 0 },
    { type: 'error', requestId: 'placeholder', code: 'DOM', message: 'page disappeared', afterSend: true, seq: 1 },
  ])
  const adapter = await adapterFor(transport)
  await expectStreamCode(adapter, options(), CHATGPT_WEB_CODES.UNCERTAIN)
})

test('AbortSignal calls transport.abort and ends with aborted finish', async () => {
  let releaseEvent: (() => void) | undefined
  const transport: ChatTransport & { aborts: string[] } = {
    aborts: [],
    async *generate(request) {
      yield { type: 'state', requestId: request.requestId, stage: 'sent', seq: 0 }
      await new Promise<void>(resolve => { releaseEvent = resolve })
      yield { type: 'complete', requestId: request.requestId, text: 'late', seq: 1 }
    },
    async abort(requestId) { this.aborts.push(requestId); releaseEvent?.() },
    async dispose() {},
  }
  const adapter = await adapterFor(transport)
  const controller = new AbortController()
  const run = collect(adapter, options({ signal: controller.signal }))
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  const chunks = await run
  assert.equal(transport.aborts.length, 1)
  assert.equal(chunks.at(-1)?.type, 'finish')
  const finish = chunks.at(-1)
  if (finish?.type === 'finish') assert.equal(finish.reason.kind, 'aborted')
})

test('two concurrent calls are serialized by RequestQueue', async () => {
  let releaseFirst: (() => void) | undefined
  let starts = 0
  const transport: ChatTransport = {
    async *generate(request) {
      starts += 1
      const ordinal = starts
      if (ordinal === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
      yield { type: 'session-ready', requestId: request.requestId, conversationUrl: `https://chatgpt.com/c/${ordinal}`, seq: 0 }
      yield { type: 'complete', requestId: request.requestId, text: `ok${ordinal}`, seq: 1 }
    },
    async abort() {},
    async dispose() {},
  }
  const adapter = await adapterFor(transport)
  const first = collect(adapter, options({ sessionId: 's1' as never }))
  const second = collect(adapter, options({ sessionId: 's2' as never }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts, 1)
  releaseFirst?.()
  await Promise.all([first, second])
  assert.equal(starts, 2)
})
