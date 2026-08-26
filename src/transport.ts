import type { BridgeServer } from './bridge-server.js'
import type { ChatTransport, GenerateRequest, TransportEvent } from './protocol.js'

export class ExternalChromeTransport implements ChatTransport {
  constructor(private readonly bridge: BridgeServer) {}

  generate(request: GenerateRequest, signal?: AbortSignal): AsyncIterable<TransportEvent> {
    return this.bridge.generate(request, signal)
  }

  abort(requestId: string): Promise<void> {
    return this.bridge.abort(requestId)
  }

  dispose(): Promise<void> {
    return this.bridge.dispose()
  }
}
