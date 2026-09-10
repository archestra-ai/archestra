"use client";

import type {
  AgentRunControl,
  AgentRunReadableTranscript,
} from "@archestra/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { ChatComposer, ChatThread } from "@/components/chat/chat-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { runtimeChatMessages } from "@/lib/chat/runtime-chat-messages";
import websocketService from "@/lib/websocket/websocket";

export function AgentRunConversation({
  transcript,
  taskId,
  canControl,
  agentId,
  agentName,
}: {
  transcript: AgentRunReadableTranscript;
  taskId: string;
  canControl: boolean;
  agentId: string;
  agentName: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(websocketService.isConnected());
  const acknowledgement = useRef<{
    id: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const state = transcript.session?.state;
  const working = state === "working" || state === "input_required";
  const messages = useMemo(() => runtimeChatMessages(transcript), [transcript]);
  useEffect(() => websocketService.onConnectionChange(setConnected), []);
  useEffect(() => {
    const unsubscribe = websocketService.subscribe(
      "agent_run_control_result",
      (message) => {
        const current = acknowledgement.current;
        if (
          message.payload.runId !== taskId ||
          message.payload.commandId !== current?.id
        )
          return;
        clearTimeout(current.timer);
        acknowledgement.current = null;
        setPending(false);
        if (message.payload.error) {
          setError(message.payload.error);
          current.reject(new Error(message.payload.error));
        } else current.resolve();
      },
    );
    return () => {
      unsubscribe();
      const current = acknowledgement.current;
      if (current) {
        clearTimeout(current.timer);
        current.reject(new Error("Conversation closed before acknowledgement"));
        acknowledgement.current = null;
      }
    };
  }, [taskId]);
  const send = (control: AgentRunControl): Promise<void> => {
    if (!connected || acknowledgement.current)
      return Promise.reject(new Error("Agent connection is not ready"));
    setPending(true);
    setError(undefined);
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        acknowledgement.current = null;
        setPending(false);
        const message =
          "No acknowledgement received. Check the conversation before sending again.";
        setError(message);
        reject(new Error(message));
      }, 15_000);
      acknowledgement.current = { id, resolve, reject, timer };
      websocketService.send({
        type: "agent_run_control",
        payload: { runId: taskId, commandId: id, control },
      });
    });
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatThread>
        <ChatMessages
          readOnlyHistory
          conversationId={undefined}
          agentId={agentId}
          agentName={agentName}
          messages={messages}
          status={
            working ? "streaming" : state === "starting" ? "submitted" : "ready"
          }
          error={
            transcript.session?.error
              ? new Error(transcript.session.error)
              : undefined
          }
        />
      </ChatThread>
      {canControl && (
        <ChatComposer>
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
              disabled={!connected || pending}
              onRespond={(control) => {
                void send(control).catch(() => {});
              }}
            />
          ))}
          <ArchestraPromptInput
            agentId={agentId}
            runtimeMode
            runtimeTaskId={taskId}
            selectedModel=""
            onModelChange={() => {}}
            status={working ? "streaming" : "ready"}
            sendDisabled={
              !connected || pending || (!working && state !== "idle")
            }
            onStop={() => {
              void send({ type: "interrupt" }).catch(() => {});
            }}
            onSubmit={({ text }) => send({ type: "message", text })}
          />
        </ChatComposer>
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
