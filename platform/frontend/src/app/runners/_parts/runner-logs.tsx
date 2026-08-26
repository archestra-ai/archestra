"use client";

import type {
  RunnerLogsEndedMessage,
  RunnerLogsErrorMessage,
  RunnerLogsMessage,
} from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import websocketService from "@/lib/websocket/websocket";

interface RunnerLogsProps {
  runnerId: string;
  isActive: boolean;
}

/**
 * Everything the session has printed. Distinct from attaching: this is
 * read-only and works after the session has ended, which is where you look
 * when a runner failed and there is no live pane left to attach to.
 */
export function RunnerLogs({ runnerId, isActive }: RunnerLogsProps) {
  const [lines, setLines] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    if (!isActive) return;
    setLines("");
    setError(null);
    setEnded(false);
    websocketService.connect();

    const unsubscribes = [
      websocketService.subscribe(
        "runner_logs",
        (message: RunnerLogsMessage) => {
          if (message.payload.runnerId !== runnerId) return;
          setLines((previous) => previous + message.payload.logs);
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
    ];

    websocketService.send({
      type: "subscribe_runner_logs",
      payload: { runnerId },
    });

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      websocketService.send({
        type: "unsubscribe_runner_logs",
        payload: { runnerId },
      });
    };
  }, [runnerId, isActive]);

  // Follow the tail, but stop following the moment the reader scrolls up —
  // yanking someone back to the bottom while they are reading is worse than
  // making them scroll down again.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      <h3 className="text-sm font-semibold flex-shrink-0">Session Output</h3>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            40;
        }}
        className="flex-1 min-h-0 overflow-auto rounded-md border bg-slate-950 p-4"
      >
        {error && <div className="text-red-400 font-mono text-xs">{error}</div>}
        {!error && lines.length === 0 && (
          <div className="text-slate-400 font-mono text-xs">
            Waiting for output...
          </div>
        )}
        <pre className="text-emerald-400 font-mono text-xs whitespace-pre-wrap break-all">
          {lines}
        </pre>
        {ended && (
          <div className="text-yellow-400 font-mono text-xs pt-2">
            Output ended.
          </div>
        )}
      </div>
    </div>
  );
}
