import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestQueue } from '../src/request-queue.js'

test('RequestQueue grants leases in FIFO order and release is idempotent', async () => {
  const queue = new RequestQueue()
  const first = await queue.acquire()
  const order: number[] = []
  const secondPromise = queue.acquire().then((release) => {
    order.push(2)
    return release
  })
  const thirdPromise = queue.acquire().then((release) => {
    order.push(3)
    return release
  })

  assert.deepEqual(order, [])
  first()
  const second = await secondPromise
  assert.deepEqual(order, [2])
  first()
  assert.deepEqual(order, [2])
  second()
  const third = await thirdPromise
  assert.deepEqual(order, [2, 3])
  third()
})

test('aborting a queued caller removes it without blocking later callers', async () => {
  const queue = new RequestQueue()
  const first = await queue.acquire()
  const aborter = new AbortController()
  const aborted = queue.acquire(aborter.signal)
  const later = queue.acquire()

  aborter.abort(new Error('cancelled'))
  await assert.rejects(aborted, /cancelled/)

  first()
  const releaseLater = await later
  releaseLater()
})

test('already aborted caller is rejected immediately', async () => {
  const queue = new RequestQueue()
  const aborter = new AbortController()
  aborter.abort(new Error('nope'))
  await assert.rejects(queue.acquire(aborter.signal), /nope/)
})
