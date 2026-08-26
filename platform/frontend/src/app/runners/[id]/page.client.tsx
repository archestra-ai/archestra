"use client";

import { formatDistanceToNow } from "date-fns";
import { Send, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useDeleteRunner,
  useRunner,
  useRunnerEvents,
  useSteerRunner,
  useStopRunner,
} from "@/lib/runners.query";
import { RunnerAttachTerminal } from "../_parts/runner-attach-terminal";
import { RunnerLogs } from "../_parts/runner-logs";
import { RunnerStateBadge } from "../_parts/runner-state-badge";

export function RunnerDetailClient({ runnerId }: { runnerId: string }) {
  const router = useRouter();
  const { data: runner, isLoading } = useRunner(runnerId);
  const { data: events } = useRunnerEvents(runnerId);
  const steer = useSteerRunner(runnerId);
  const stop = useStopRunner();
  const remove = useDeleteRunner();
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState("session");

  if (isLoading)
    return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (!runner) return <div className="p-6">Runner not found.</div>;

  const isLive = runner.state === "running";

  const sendMessage = async () => {
    const trimmed = message.trim();
    if (!trimmed) return;
    try {
      await steer.mutateAsync(trimmed);
      setMessage("");
      toast.success("Message sent to the session");
    } catch {
      // The mutation surfaces the reason; nothing useful to add here.
    }
  };

  return (
    <div className="p-6 flex flex-col gap-4 h-full min-h-0">
      <div className="flex items-start justify-between gap-4 flex-shrink-0">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold truncate">{runner.name}</h1>
            <RunnerStateBadge
              state={runner.state}
              statusReason={runner.statusReason}
            />
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            {runner.image} · started{" "}
            {formatDistanceToNow(new Date(runner.createdAt), {
              addSuffix: true,
            })}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={!isLive || stop.isPending}
            onClick={() => stop.mutate(runnerId)}
          >
            <Square className="h-3 w-3" /> Stop
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={async () => {
              await remove.mutateAsync(runnerId);
              router.push("/runners");
            }}
          >
            <Trash2 className="h-3 w-3" /> Delete
          </Button>
        </div>
      </div>

      {runner.task && (
        <Card className="p-4 flex-shrink-0">
          <h3 className="text-sm font-semibold mb-1">Task</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {runner.task}
          </p>
        </Card>
      )}

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex flex-col flex-1 min-h-0"
      >
        <TabsList className="flex-shrink-0">
          <TabsTrigger value="session">Live Session</TabsTrigger>
          <TabsTrigger value="output">Output</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="session" className="flex flex-col flex-1 min-h-0">
          {isLive ? (
            // Mounted only while the tab is showing: a background tab holding
            // an attach would keep a pod's exec open for no reason.
            <RunnerAttachTerminal
              runnerId={runnerId}
              isActive={tab === "session"}
            />
          ) : (
            <Card className="p-6 text-muted-foreground">
              This session is {runner.state}. There is no live pane to attach to
              — its output is under Output.
            </Card>
          )}
        </TabsContent>

        <TabsContent value="output" className="flex flex-col flex-1 min-h-0">
          <RunnerLogs runnerId={runnerId} isActive={tab === "output"} />
        </TabsContent>

        <TabsContent
          value="timeline"
          className="flex flex-col flex-1 min-h-0 overflow-auto"
        >
          <div className="flex flex-col gap-2">
            {events?.map((event) => (
              <Card key={event.id} className="p-3 flex items-start gap-3">
                <span className="text-xs font-mono text-muted-foreground w-28 flex-shrink-0">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
                <span className="text-xs font-mono text-muted-foreground w-24 flex-shrink-0">
                  {event.kind}
                </span>
                <span className="text-sm whitespace-pre-wrap break-words">
                  {event.message}
                </span>
              </Card>
            ))}
            {(events?.length ?? 0) === 0 && (
              <p className="text-muted-foreground">Nothing recorded yet.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2 flex-shrink-0">
        <Input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
          placeholder={
            isLive
              ? "Send a message into the session..."
              : "The session is not running"
          }
          disabled={!isLive || steer.isPending}
        />
        <Button
          onClick={() => void sendMessage()}
          disabled={!isLive || steer.isPending || !message.trim()}
        >
          <Send className="h-3 w-3" /> Send
        </Button>
      </div>
    </div>
  );
}
