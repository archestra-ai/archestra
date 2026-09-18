import { WebSocket } from "ws";
import type { TerminalChannel } from "./types";

/** Keeps Kubernetes exec framing and connection lifetime inside the provider. */
export class KubernetesTerminalChannel implements TerminalChannel {
  private detached = false;
  private closed: boolean;
  private lastError: Error | null = null;
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(private readonly socket: WebSocket) {
    this.closed = socket.readyState === WebSocket.CLOSED;
    if (!this.closed) {
      socket.on("close", this.handleClose);
      socket.on("error", this.handleError);
    }
  }

  resize({ cols, rows }: { cols: number; rows: number }): void {
    if (this.detached || this.socket.readyState !== WebSocket.OPEN) return;
    // Kubernetes exec reserves channel 4 for terminal dimensions.
    const dimensions = Buffer.from(
      JSON.stringify({ Width: cols, Height: rows }),
    );
    this.socket.send(Buffer.concat([Buffer.from([4]), dimensions]));
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.closeListeners.clear();
    this.errorListeners.clear();
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close();
    // Keep the error handler until close: closing a connecting websocket can
    // still emit an error asynchronously, after the viewer has gone away.
  }

  onClose(listener: () => void): () => void {
    if (this.detached) return () => {};
    this.closeListeners.add(listener);
    if (this.closed) {
      queueMicrotask(() => {
        if (this.closeListeners.delete(listener)) listener();
      });
    }
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    if (this.detached) return () => {};
    this.errorListeners.add(listener);
    const error = this.lastError;
    if (error) {
      queueMicrotask(() => {
        if (this.errorListeners.has(listener)) listener(error);
      });
    }
    return () => this.errorListeners.delete(listener);
  }

  private readonly handleClose = () => {
    this.closed = true;
    this.socket.off("close", this.handleClose);
    this.socket.off("error", this.handleError);
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.errorListeners.clear();
  };

  private readonly handleError = (error: Error) => {
    this.lastError = error;
    for (const listener of this.errorListeners) listener(error);
  };
}
