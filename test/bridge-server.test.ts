import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import { BridgeServer } from '../src/bridge-server.js'
import { EXTENSION_ORIGIN } from '../src/extension-identity.js'
import { PROTOCOL, type TransportEvent } from '../src/protocol.js'

async function connect(port: number, origin = EXTENSION_ORIGIN): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { origin })
  await once(socket, 'open')
  socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'hello', extensionVersion: '0.1.0' }))
  return socket
}

async function collect(iterable: AsyncIterable<TransportEvent>): Promise<TransportEvent[]> {
  const result: TransportEvent[] = []
  for await (const event of iterable) result.push(event)
  return result
}

test('bridge binds loopback and accepts only expected extension origin', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const address = await bridge.start()
  assert.equal(address.host, '127.0.0.1')

  const bad = new WebSocket(`ws://127.0.0.1:${address.port}/`, { origin: 'https://example.com' })
  const rejected = once(bad, 'unexpected-response')
  await rejected
  bad.terminate()

  const good = await connect(address.port)
  assert.equal(good.readyState, WebSocket.OPEN)
  good.close()
  await bridge.dispose()
})

test('bridge rejects a second extension connection while one is active', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const { port } = await bridge.start()
  const first = await connect(port)
  const second = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: EXTENSION_ORIGIN })
  await once(second, 'unexpected-response')
  second.terminate()
  first.close()
  await bridge.dispose()
})

test('disconnect before sent is retry-safe and disconnect after sent is uncertain', async () => {
  const beforeBridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const beforeAddress = await beforeBridge.start()
  const beforeSocket = await connect(beforeAddress.port)
  beforeSocket.once('message', () => beforeSocket.close())
  const before = await collect(beforeBridge.generate({ requestId: 'before', sessionId: 's', prompt: 'p' }))
  const beforeError = before.at(-1)
  assert.equal(beforeError?.type, 'error')
  if (beforeError?.type === 'error') assert.equal(beforeError.afterSend, false)
  await beforeBridge.dispose()

  const afterBridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const afterAddress = await afterBridge.start()
  const afterSocket = await connect(afterAddress.port)
  afterSocket.once('message', raw => {
    const outgoing = JSON.parse(raw.toString()) as { requestId: string }
    afterSocket.send(JSON.stringify({ protocol: PROTOCOL, type: 'request-state', requestId: outgoing.requestId, stage: 'sent', seq: 0 }))
    afterSocket.close()
  })
  const after = await collect(afterBridge.generate({ requestId: 'after', sessionId: 's', prompt: 'p' }))
  assert.equal(after[0]?.type, 'state')
  const afterError = after.at(-1)
  assert.equal(afterError?.type, 'error')
  if (afterError?.type === 'error') assert.equal(afterError.afterSend, true)
  await afterBridge.dispose()
})

test('invalid protocol closes the extension socket', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const { port } = await bridge.start()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: EXTENSION_ORIGIN })
  await once(socket, 'open')
  socket.send('{bad-json')
  const [code] = await once(socket, 'close') as [number, Buffer]
  assert.equal(code, 1002)
  await bridge.dispose()
})
