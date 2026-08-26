"use client";

import type {
  RunnerLogsEndedMessage,
  RunnerLogsErrorMessage,
  RunnerLogsMessage,
} from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import { LogConsole } from "@/components/log-console";
import websocketService from "@/lib/websocket/websocket";

interface RunnerLogsProps {
  runnerId: string;
  isActive: boolean;
}

/**
 * Everything the session has printed. Distinct from attaching: read-only, and
 * it works after the session has ended — which is exactly when you most want
 * to read one, because there is no live pane left to attach to.
 */
export function RunnerLogs({ runnerId, isActive }: RunnerLogsProps) {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    if (!isActive) return;
    setContent("");
    setError(null);
    setEnded(false);

    const subscribe = () => {
      websocketService.send({
        type: "subscribe_runner_logs",
        payload: { runnerId },
      });
    };

    const unsubscribes = [
      websocketService.subscribe(
        "runner_logs",
        (message: RunnerLogsMessage) => {
          if (message.payload.runnerId !== runnerId) return;
          setContent((previous) => previous + message.payload.logs);
        },
      ),
      websocketService.subscribe(
        "runner_logs_error",
        (message: RunnerLogsErrorMessage) => {
          if (message.payload.runnerId !== runnerId) return;
          setError(message.payload.error);
        },
      ),
      websocketService.subscribe(
        "runner_logs_ended",
        (message: RunnerLogsEndedMessage) => {
          if (message.payload.runnerId !== runnerId) return;
          setEnded(true);
        },
      ),
      // The server forgets every subscription along with the socket it was
      // made on, so a reconnect has to re-send this one — otherwise the panel
      // sits there looking connected and never receives another line.
      websocketService.onConnectionChange((connected) => {
        if (connected) subscribe();
      }),
    ];

    websocketService.connect();
    subscribe();

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      websocketService.send({
        type: "unsubscribe_runner_logs",
        payload: { runnerId },
      });
    };
  }, [runnerId, isActive]);

  // Follow the tail, but stop the moment the reader scrolls up: yanking
  // someone back down while they are reading is worse than making them scroll.
  useEffect(() => {
    if (!pinnedToBottomRef.current) return;
    const viewport = scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]",
    );
    if (viewport instanceof HTMLElement) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, []);

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      <h3 className="text-sm font-semibold flex-shrink-0">Session Output</h3>
      <LogConsole
        content={content}
        error={error}
        className="flex-1 min-h-0"
        emptyMessage="This session has not printed anything."
        placeholder={ended ? undefined : "Waiting for output..."}
        status={
          ended ? (
            <span className="text-yellow-400 text-xs font-mono">
              Output ended
            </span>
          ) : undefined
        }
        scrollAreaRef={scrollAreaRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            40;
        }}
      />
    </div>
  );
}
