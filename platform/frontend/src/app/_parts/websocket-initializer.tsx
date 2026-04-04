"use client";

import { useEffect } from "react";
import websocketService from "@/lib/websocket/websocket";

/**
 * Establishes the shared WebSocket connection once the client hydrates.
 * Rendering this component anywhere in the app tree is enough—it renders nothing.
 */
export function WebsocketInitializer() {
  useEffect(() => {
    websocketService.connect().catch(console.error);
  }, []);

  return null;
}
