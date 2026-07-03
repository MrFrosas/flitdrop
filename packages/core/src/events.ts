import type { WebSocket } from 'ws'

/** Diffuse les événements temps réel vers l'interface du PC. */
export class Hub {
  private clients = new Set<WebSocket>()

  add(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => this.clients.delete(ws))
  }

  broadcast(type: string, data: unknown): void {
    const msg = JSON.stringify({ type, data, ts: Date.now() })
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(msg)
    }
  }
}
