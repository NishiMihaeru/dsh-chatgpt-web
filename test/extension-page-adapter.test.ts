import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Window } from 'happy-dom'

interface PageAdapter {
  isReady(): boolean
  sendMessage(text: string, options?: {
    isAborted?: () => boolean
    beforeSend?: () => void | Promise<void>
    sendTimeoutMs?: number
  }): Promise<{ assistantCount: number; assistantText: string }>
  observeGeneration(options?: {
    baseline?: { assistantCount: number; assistantText: string }
    onUpdate?: (update: { text: string; append: boolean; delta: string }) => void
    startTimeoutMs?: number
    completionStabilityMs?: number
    overallTimeoutMs?: number
  }): Promise<string>
  stopGeneration(): boolean
  getConversationUrl(raw?: string): string | null
}

const source = await readFile(new URL('../extension/chatgpt-page-adapter.js', import.meta.url), 'utf8')

async function fixture(name: string, url = 'https://chatgpt.com/'): Promise<{ window: Window; adapter: PageAdapter }> {
  const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  const window = new Window({ url })
  window.document.write(html)
  window.eval(source)
  const adapter = (window as unknown as { __DSH_CHATGPT_PAGE_ADAPTER__: PageAdapter }).__DSH_CHATGPT_PAGE_ADAPTER__
  return { window, adapter }
}

test('page adapter detects composer and accepts only managed conversation URLs', async () => {
  const { adapter } = await fixture('chatgpt-ready.html', 'https://chatgpt.com/c/abc?x=1#hash')
  assert.equal(adapter.isReady(), true)
  assert.equal(adapter.getConversationUrl(), 'https://chatgpt.com/c/abc')
  assert.equal(adapter.getConversationUrl('https://chatgpt.com/'), null)
  assert.equal(adapter.getConversationUrl('https://example.com/c/abc'), null)
})

test('sendMessage publishes the sent boundary before clicking Send', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const order: string[] = []
  window.document.querySelector('button')?.addEventListener('click', () => { order.push('click') })
  await adapter.sendMessage('hello from DSH', { beforeSend: () => { order.push('boundary') } })
  assert.match(window.document.querySelector('#prompt-textarea')?.textContent ?? '', /hello from DSH/)
  assert.deepEqual(order, ['boundary', 'click'])
})

test('sendMessage never clicks Send after cancellation while waiting', async () => {
  const { window, adapter } = await fixture('chatgpt-ready.html')
  const button = window.document.querySelector('button')
  assert.ok(button)
  button.disabled = true
  let aborted = false
  let clicked = 0
  button.addEventListener('click', () => { clicked += 1 })
  const sending = adapter.sendMessage('do not send', { isAborted: () => aborted, sendTimeoutMs: 500 })
  setTimeout(() => { aborted = true }, 20)
  await assert.rejects(sending, /aborted before Send/)
  assert.equal(clicked, 0)
})

test('thinking status is filtered and append-compatible updates emit only suffix', async () => {
  const { window, adapter } = await fixture('chatgpt-thinking.html')
  const updates: Array<{ text: string; append: boolean; delta: string }> = []
  const observation = adapter.observeGeneration({
    baseline: { assistantCount: 0, assistantText: '' },
    onUpdate: update => updates.push(update),
    startTimeoutMs: 1000,
    completionStabilityMs: 30,
    overallTimeoutMs: 2000,
  })
  const body = window.document.querySelector('.markdown')
  assert.ok(body)
  setTimeout(() => { body.textContent = '1' }, 20)
  setTimeout(() => { body.textContent = '12' }, 40)
  const final = await observation
  assert.equal(final, '12')
  assert.deepEqual(updates.filter(update => update.delta !== '').map(update => update.delta), ['1', '2'])
  assert.equal(updates.some(update => /Думаю/i.test(update.text)), false)
})

test('rewritten snapshot is marked non-append and later compatible snapshot resumes', async () => {
  const { window, adapter } = await fixture('chatgpt-thinking.html')
  const updates: Array<{ text: string; append: boolean; delta: string }> = []
  const observation = adapter.observeGeneration({
    baseline: { assistantCount: 0, assistantText: '' },
    onUpdate: update => updates.push(update),
    startTimeoutMs: 1000,
    completionStabilityMs: 40,
    overallTimeoutMs: 2000,
  })
  const body = window.document.querySelector('.markdown')
  assert.ok(body)
  setTimeout(() => { body.textContent = 'ab' }, 10)
  setTimeout(() => { body.textContent = 'ax' }, 25)
  setTimeout(() => { body.textContent = 'abc' }, 45)
  const final = await observation
  assert.equal(final, 'abc')
  assert.equal(updates.some(update => update.text === 'ax' && update.append === false), true)
  assert.deepEqual(updates.filter(update => update.delta !== '').map(update => update.delta), ['ab', 'c'])
})
