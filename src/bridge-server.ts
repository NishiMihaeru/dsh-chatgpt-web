import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import {
  parseExtensionMessage,
  wireAbortMessage,
  wireGenerateMessage,
  wirePingMessage,
  type GenerateRequest,
  type PluginToExtensionMessage,
  type TransportEvent,
} from './protocol.js'

interface BridgeServerOptions {
  host: '127.0.0.1'
  port: number
  expectedOrigin: string
  heartbeatMs?: number
}

interface PendingRequest {
  request: GenerateRequest
  stream: EventStream<TransportEvent>
  lastSeq: number
  afterSend: boolean
}

class EventStream<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(item: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve))
      },
    }
  }
}

function rawHttpReject(socket: import('node:stream').Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export class BridgeServer {
  private readonly options: Required<BridgeServerOptions>
  private httpServer: Server | undefined
  private websocketServer: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private helloReceived = false
  private heartbeat: NodeJS.Timeout | undefined
  private lastPongAt = 0
  private readonly pending = new Map<string, PendingRequest>()

  constructor(options: BridgeServerOptions) {
    this.options = {
      ...options,
      heartbeatMs: options.heartbeatMs ?? 15_000,
    }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.httpServer !== undefined) throw new Error('bridge server already started')

    const httpServer = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
    })
    const websocketServer = new WebSocketServer({ noServer: true })
    this.httpServer = httpServer
    this.websocketServer = websocketServer

    httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
    websocketServer.on('connection', socket => this.attachSocket(socket))

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        httpServer.off('error', onError)
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(this.options.port, this.options.host)
    })

    const address = httpServer.address() as AddressInfo
    return { host: this.options.host, port: address.port }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.helloReceived
  }

  async *generate(request: GenerateRequest, _signal?: AbortSignal): AsyncIterable<TransportEvent> {
    if (this.pending.has(request.requestId)) {
      yield {
        type: 'error',
        requestId: request.requestId,
        code: 'BRIDGE_DUPLICATE_REQUEST',
        message: `duplicate request id ${request.requestId}`,
        afterSend: false,
        seq: 0,
      }
      return
    }

    if (!this.isConnected()) {
      yield {
        type: 'error',
        requestId: request.requestId,
        code: 'BRIDGE_EXTENSION_UNAVAILABLE',
        message: 'ChatGPT Web extension is not connected to the local bridge',
        afterSend: false,
        seq: 0,
      }
      return
    }

    const stream = new EventStream<TransportEvent>()
    const pending: PendingRequest = {
      request,
      stream,
      lastSeq: -1,
      afterSend: false,
    }
    this.pending.set(request.requestId, pending)

    try {
      this.send(wireGenerateMessage(request))
    } catch (error) {
      this.pending.delete(request.requestId)
      yield {
        type: 'error',
        requestId: request.requestId,
        code: 'BRIDGE_SEND_FAILED',
        message: error instanceof Error ? error.message : String(error),
        afterSend: false,
        seq: 0,
      }
      return
    }

    try {
      for await (const event of stream) yield event
    } finally {
      this.pending.delete(request.requestId)
    }
  }

  async abort(requestId: string): Promise<void> {
    if (!this.pending.has(requestId)) return
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.send(wireAbortMessage(requestId))
  }

  async dispose(): Promise<void> {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }

    const socket = this.socket
    this.socket = undefined
    this.helloReceived = false
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.close(1001, 'bridge shutdown')

    for (const pending of this.pending.values()) {
      pending.stream.push({
        type: 'error',
        requestId: pending.request.requestId,
        code: 'BRIDGE_SHUTDOWN',
        message: 'ChatGPT Web bridge shut down',
        afterSend: pending.afterSend,
        seq: pending.lastSeq + 1,
      })
      pending.stream.end()
    }
    this.pending.clear()

    const websocketServer = this.websocketServer
    this.websocketServer = undefined
    websocketServer?.close()

    const httpServer = this.httpServer
    this.httpServer = undefined
    if (httpServer !== undefined) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    if (request.headers.origin !== this.options.expectedOrigin) {
      rawHttpReject(socket, 403, 'Forbidden')
      return
    }
    if (request.url !== '/') {
      rawHttpReject(socket, 404, 'Not Found')
      return
    }
    if (this.socket !== undefined && this.socket.readyState !== WebSocket.CLOSED) {
      rawHttpReject(socket, 409, 'Conflict')
      return
    }
    this.websocketServer?.handleUpgrade(request, socket, head, upgraded => {
      this.websocketServer?.emit('connection', upgraded, request)
    })
  }

  private attachSocket(socket: WebSocket): void {
    this.socket = socket
    this.helloReceived = false
    this.lastPongAt = Date.now()

    socket.on('message', data => {
      try {
        const message = parseExtensionMessage(data.toString())
        if (message.type === 'hello') {
          if (this.helloReceived) throw new Error('duplicate extension hello')
          this.helloReceived = true
          this.lastPongAt = Date.now()
          this.startHeartbeat()
          return
        }
        if (!this.helloReceived) throw new Error('extension must send hello before other messages')
        if (message.type === 'pong') {
          this.lastPongAt = Date.now()
          return
        }

        const pending = this.pending.get(message.requestId)
        if (pending === undefined) throw new Error(`event for unknown request id ${message.requestId}`)
        if (message.seq <= pending.lastSeq) throw new Error(`non-monotonic seq for request ${message.requestId}`)
        pending.lastSeq = message.seq

        switch (message.type) {
          case 'request-state':
            // Once the browser reports `ready`, it may cross Send before a later
            // state reaches the bridge. A disconnect from this point is treated
            // conservatively as uncertain rather than retry-safe.
            if (message.stage === 'ready' || message.stage === 'sent' || message.stage === 'generating') pending.afterSend = true
            pending.stream.push({ type: 'state', requestId: message.requestId, stage: message.stage, seq: message.seq })
            break
          case 'session-ready':
            pending.stream.push({ type: 'session-ready', requestId: message.requestId, conversationUrl: message.conversationUrl, seq: message.seq })
            break
          case 'delta':
            pending.stream.push({ type: 'delta', requestId: message.requestId, text: message.text, seq: message.seq })
            break
          case 'generation-complete':
            pending.stream.push({ type: 'complete', requestId: message.requestId, text: message.text, seq: message.seq })
            pending.stream.end()
            break
          case 'generation-aborted':
            pending.stream.push({ type: 'aborted', requestId: message.requestId, seq: message.seq })
            pending.stream.end()
            break
          case 'error':
            pending.stream.push({
              type: 'error',
              requestId: message.requestId,
              code: message.code,
              message: message.message,
              afterSend: message.afterSend || pending.afterSend,
              seq: message.seq,
            })
            pending.stream.end()
            break
        }
      } catch {
        socket.close(1002, 'bridge protocol error')
      }
    })

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined
        this.helloReceived = false
        if (this.heartbeat !== undefined) {
          clearInterval(this.heartbeat)
          this.heartbeat = undefined
        }
      }
      for (const pending of this.pending.values()) {
        pending.stream.push({
          type: 'error',
          requestId: pending.request.requestId,
          code: 'BRIDGE_DISCONNECTED',
          message: 'ChatGPT Web extension disconnected during the request',
          afterSend: pending.afterSend,
          seq: pending.lastSeq + 1,
        })
        pending.stream.end()
      }
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    const interval = this.options.heartbeatMs
    this.heartbeat = setInterval(() => {
      const socket = this.socket
      if (socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > interval * 2) {
        socket.terminate()
        return
      }
      this.send(wirePingMessage(randomUUID()))
    }, interval)
    this.heartbeat.unref?.()
  }

  private send(message: PluginToExtensionMessage): void {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('ChatGPT Web extension is not connected')
    socket.send(JSON.stringify(message))
  }
}
