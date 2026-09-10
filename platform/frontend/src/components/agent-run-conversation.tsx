"use client";

import type {
  AgentRunControl,
  AgentRunReadableTranscript,
} from "@archestra/shared";
import { ArrowDown, Loader2, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Response } from "@/components/ai-elements/response";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import websocketService from "@/lib/websocket/websocket";

export function AgentRunConversation({
  transcript,
  taskId,
  canControl,
}: {
  transcript: AgentRunReadableTranscript;
  taskId: string;
  canControl: boolean;
}) {
  const viewport = useRef<HTMLElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(websocketService.isConnected());
  const submittedMessage = useRef(false);
  const form = useForm({ defaultValues: { message: "" } });
  const state = transcript.session?.state;
  const working = state === "working" || state === "input_required";

  useEffect(() => websocketService.onConnectionChange(setConnected), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Streamed content changes the viewport height.
  useEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [transcript]);
  useEffect(
    () =>
      websocketService.subscribe("agent_run_control_result", (message) => {
        if (
          message.payload.runId !== taskId ||
          message.payload.commandId !== pending
        )
          return;
        setPending(null);
        setError(message.payload.error);
        if (!message.payload.error && submittedMessage.current) form.reset();
      }),
    [taskId, pending, form],
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(null);
      setError(
        "No acknowledgement received. Check the conversation before sending again.",
      );
    }, 15_000);
    return () => clearTimeout(timer);
  }, [pending]);
  const send = (control: AgentRunControl) => {
    if (!connected || pending) return;
    const commandId = crypto.randomUUID();
    submittedMessage.current = control.type === "message";
    setPending(commandId);
    setError(undefined);
    websocketService.send({
      type: "agent_run_control",
      payload: { runId: taskId, commandId, control },
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-background">
      <section
        ref={viewport}
        aria-label="Agent conversation"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable history must be keyboard accessible.
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6"
        onScroll={() => {
          const node = viewport.current;
          if (!node) return;
          following.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          setShowLatest(!following.current);
        }}
      >
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-5">
          {transcript.entries.map((entry, index) =>
            entry.type === "message" ? (
              <article
                key={entry.id ?? index}
                className="min-w-0 break-words text-sm [overflow-wrap:anywhere]"
              >
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {entry.role === "user" ? "You" : "Assistant"}
                </div>
                {entry.role === "assistant" ? (
                  <Response>{entry.text}</Response>
                ) : (
                  <div className="whitespace-pre-wrap">{entry.text}</div>
                )}
              </article>
            ) : (
              <details
                key={entry.id ?? index}
                className="min-w-0 rounded-md border bg-muted/20 p-3 text-sm"
              >
                <summary className="cursor-pointer break-words">
                  {entry.type === "tool_call"
                    ? entry.name
                    : entry.isError
                      ? "Tool error"
                      : "Tool result"}
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">
                  {entry.type === "tool_call" ? entry.input : entry.text}
                </pre>
              </details>
            ),
          )}
          {state === "starting" && (
            <output className="text-sm text-muted-foreground">
              Starting agent…
            </output>
          )}
          {working && (
            <output className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>
                {state === "input_required"
                  ? "Waiting for your response"
                  : "Working…"}
              </span>
            </output>
          )}
          {transcript.session?.error && (
            <p role="alert" className="text-sm text-destructive">
              {transcript.session.error}
            </p>
          )}
        </div>
      </section>
      {showLatest && (
        <Button
          variant="outline"
          size="sm"
          className="mx-auto my-2"
          onClick={() => {
            following.current = true;
            if (viewport.current)
              viewport.current.scrollTop = viewport.current.scrollHeight;
            setShowLatest(false);
          }}
        >
          <ArrowDown />
          <span>Latest messages</span>
        </Button>
      )}
      {canControl && (
        <div className="max-h-[60%] shrink-0 space-y-3 overflow-y-auto border-t p-3">
          {!connected && (
            <output className="text-sm text-muted-foreground">
              Reconnecting…
            </output>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {transcript.session?.requests.map((request) => (
            <SessionQuestion
              key={request.id}
              request={request}
              disabled={!connected || !!pending}
              onRespond={send}
            />
          ))}
          <form
            className="flex items-end gap-2"
            onSubmit={form.handleSubmit(({ message }) =>
              send({ type: "message", text: message }),
            )}
          >
            <Textarea
              {...form.register("message", {
                required: true,
                validate: (text) => !!text.trim(),
              })}
              aria-label="Message the agent"
              placeholder={
                working ? "Write your next instruction…" : "Message the agent…"
              }
              className="max-h-48 min-h-16 resize-y"
            />
            {working ? (
              <Button
                type="button"
                variant="outline"
                disabled={!connected || !!pending}
                onClick={() => send({ type: "interrupt" })}
              >
                <Square />
                <span>Interrupt</span>
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!connected || !!pending || state !== "idle"}
                aria-label="Send message"
              >
                <Send />
              </Button>
            )}
          </form>
        </div>
      )}
    </div>
  );
}

function SessionQuestion({
  request,
  disabled,
  onRespond,
}: {
  request: NonNullable<
    AgentRunReadableTranscript["session"]
  >["requests"][number];
  disabled: boolean;
  onRespond: (control: AgentRunControl) => void;
}) {
  const form = useForm<{ answers: string[] }>({
    defaultValues: { answers: [] },
  });
  return (
    <form
      className="space-y-3 rounded-md border p-3"
      onSubmit={form.handleSubmit(({ answers }) =>
        onRespond({
          type: "respond",
          requestId: request.id,
          answers: Object.fromEntries(
            (request.questions ?? []).map((question, index) => [
              question.id,
              answers[index] ?? "",
            ]),
          ),
        }),
      )}
    >
      <p className="font-medium">{request.title}</p>
      {request.description && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
          {request.description}
        </pre>
      )}
      {request.questions?.map((question, index) => (
        <div key={question.id} className="space-y-2">
          <Label htmlFor={`${request.id}-${index}`}>{question.text}</Label>
          {question.options && (
            <div className="flex flex-wrap gap-2">
              {question.options.map((option) => (
                <Button
                  key={option}
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={disabled}
                  onClick={() => form.setValue(`answers.${index}`, option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Input
            id={`${request.id}-${index}`}
            {...form.register(`answers.${index}`, { required: true })}
            disabled={disabled}
          />
        </div>
      ))}
      {request.questions?.length ? (
        <Button type="submit" disabled={disabled}>
          Submit response
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {request.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onRespond({
                type: "respond",
                requestId: request.id,
                optionId: option.id,
              })
            }
          >
            {option.label}
          </Button>
        ))}
      </div>
    </form>
  );
}
