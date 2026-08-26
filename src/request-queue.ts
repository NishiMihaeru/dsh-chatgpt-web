interface Waiter {
  resolve: (release: () => void) => void
  reject: (reason?: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('operation aborted')
}

export class RequestQueue {
  private locked = false
  private readonly waiters: Waiter[] = []

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal))

    if (!this.locked) {
      this.locked = true
      return Promise.resolve(this.makeRelease())
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseNext()
    }
  }

  private releaseNext(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) continue
      if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      if (waiter.signal?.aborted === true) {
        waiter.reject(abortReason(waiter.signal))
        continue
      }
      waiter.resolve(this.makeRelease())
      return
    }
    this.locked = false
  }
}
