import assert from 'node:assert/strict'
import test from 'node:test'
import { EXTENSION_ID, EXTENSION_ORIGIN, EXTENSION_PUBLIC_KEY, extensionIdFromManifestKey } from '../src/extension-identity.js'
import { ExternalChromeTransport } from '../src/transport.js'

const EXPECTED_ID = 'hekamonfnjniofllombaancencdbjoag'

test('manifest public key deterministically produces the expected extension id and origin', () => {
  assert.equal(extensionIdFromManifestKey(EXTENSION_PUBLIC_KEY), EXPECTED_ID)
  assert.equal(EXTENSION_ID, EXPECTED_ID)
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${EXPECTED_ID}`)
})

test('ExternalChromeTransport delegates to its bridge', async () => {
  const calls: string[] = []
  const bridge = {
    async *generate() {
      calls.push('generate')
      yield { type: 'complete' as const, requestId: 'r', text: 'ok', seq: 0 }
    },
    async abort(requestId: string) { calls.push(`abort:${requestId}`) },
    async dispose() { calls.push('dispose') },
  }
  const transport = new ExternalChromeTransport(bridge as never)
  const events = []
  for await (const event of transport.generate({ requestId: 'r', sessionId: 's', prompt: 'p' })) events.push(event)
  assert.equal(events.length, 1)
  await transport.abort('r')
  await transport.dispose()
  assert.deepEqual(calls, ['generate', 'abort:r', 'dispose'])
})
