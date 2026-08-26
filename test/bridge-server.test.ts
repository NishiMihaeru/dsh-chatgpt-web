import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { WebSocket } from 'ws'
import { BridgeServer } from '../src/bridge-server.js'
import { EXTENSION_ORIGIN } from '../src/extension-identity.js'
import { PROTOCOL, type TransportEvent } from '../src/protocol.js'

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
async function connect(port: number, bridge: BridgeServer, origin = EXTENSION_ORIGIN): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { origin })
  await once(socket, 'open')
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; nonce?: string }
      if (message.type === 'ping' && message.nonce) socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'pong', nonce: message.nonce }))
    } catch {}
  })
  socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'hello', extensionVersion: '0.1.0' }))
  const deadline = Date.now() + 1000
  while (!bridge.isConnected() && Date.now() < deadline) await sleep(5)
  assert.equal(bridge.isConnected(), true)
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
  await once(bad, 'unexpected-response'); bad.terminate()
  const good = await connect(address.port, bridge)
  assert.equal(good.readyState, WebSocket.OPEN)
  good.close(); await bridge.dispose()
})

test('bridge rejects a second extension connection while one is active', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const { port } = await bridge.start()
  const first = await connect(port, bridge)
  const second = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: EXTENSION_ORIGIN })
  await once(second, 'unexpected-response'); second.terminate(); first.close(); await bridge.dispose()
})

test('JSON heartbeat keeps a healthy extension connection alive', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 20 })
  const { port } = await bridge.start()
  const socket = await connect(port, bridge)
  await sleep(100)
  assert.equal(bridge.isConnected(), true)
  socket.close(); await bridge.dispose()
})

test('explicit pre-send extension error remains retry-safe', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const { port } = await bridge.start()
  const socket = await connect(port, bridge)
  socket.on('message', raw => {
    try {
      const outgoing = JSON.parse(raw.toString()) as { type?: string; requestId?: string }
      if (outgoing.type === 'generate' && outgoing.requestId) socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'error', requestId: outgoing.requestId, code: 'NAV', message: 'navigation failed', afterSend: false, seq: 0 }))
    } catch {}
  })
  const events = await collect(bridge.generate({ requestId: 'safe', sessionId: 's', prompt: 'p' }))
  const error = events.at(-1)
  assert.equal(error?.type, 'error')
  if (error?.type === 'error') assert.equal(error.afterSend, false)
  socket.close(); await bridge.dispose()
})

test('ready state is still pre-send when extension reports an explicit failure', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const { port } = await bridge.start()
  const socket = await connect(port, bridge)
  socket.on('message', raw => {
    try {
      const outgoing = JSON.parse(raw.toString()) as { type?: string; requestId?: string }
      if (outgoing.type === 'generate' && outgoing.requestId) {
        socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'request-state', requestId: outgoing.requestId, stage: 'ready', seq: 0 }))
        socket.send(JSON.stringify({ protocol: PROTOCOL, type: 'error', requestId: outgoing.requestId, code: 'COMPOSER', message: 'composer unavailable', afterSend: false, seq: 1 }))
      }
    } catch {}
  })
  const events = await collect(bridge.generate({ requestId: 'ready-safe', sessionId: 's', prompt: 'p' }))
  const error = events.at(-1)
  assert.equal(error?.type, 'error')
  if (error?.type === 'error') assert.equal(error.afterSend, false)
  socket.close(); await bridge.dispose()
})

test('silent disconnect after generate dispatch is conservatively uncertain', async () => {
  const bridge = new BridgeServer({ host: '127.0.0.1', port: 0, expectedOrigin: EXTENSION_ORIGIN, heartbeatMs: 1000 })
  const { port } = await bridge.start()
  const socket = await connect(port, bridge)
  socket.on('message', raw => {
    try { const outgoing = JSON.parse(raw.toString()) as { type?: string }; if (outgoing.type === 'generate') socket.close() } catch {}
  })
  const events = await collect(bridge.generate({ requestId: 'uncertain', sessionId: 's', prompt: 'p' }))
  const error = events.at(-1)
  assert.equal(error?.type, 'error')
  if (error?.type === 'error') assert.equal(error.afterSend, true)
  await bridge.dispose()
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
