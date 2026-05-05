import type {
  ServerWebSocketMessage,
  ServerWebSocketMessageType,
} from "@shared";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef } from "react";
import websocketService from "@/lib/websocket/websocket";

/**
 * Subscribes to a WebSocket event type and invalidates the given query keys
 * whenever a matching message arrives.
 */
export function useWebSocketQueryInvalidation<
  T extends ServerWebSocketMessageType,
>(
  eventType: T,
  queryKeys: QueryKey[],
  filter?: (msg: Extract<ServerWebSocketMessage, { type: T }>) => boolean,
  options?: { enabled?: boolean },
): void {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;

  const filterRef = useRef(filter);

  useLayoutEffect(() => {
    filterRef.current = filter;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }

    websocketService.connect();

    const unsubscribe = websocketService.subscribe(eventType, (msg) => {
      const currentFilter = filterRef.current;
      if (
        currentFilter &&
        !currentFilter(msg as Extract<ServerWebSocketMessage, { type: T }>)
      ) {
        return;
      }
      for (const key of queryKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    for (const key of queryKeys) {
      queryClient.invalidateQueries({ queryKey: key });
    }

    return unsubscribe;

    // filter is accessed via filterRef so it always reflects the latest value without re-subscribing.
  }, [enabled, eventType, queryClient, queryKeys]);
}
