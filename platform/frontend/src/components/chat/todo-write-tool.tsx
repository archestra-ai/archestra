"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  ListTodo,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

interface TodoWriteToolProps {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText?: string;
  className?: string;
  onToolApprovalResponse?: (params: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;
}

export function TodoWriteTool({
  part,
  toolResultPart,
  errorText,
  className,
  onToolApprovalResponse,
}: TodoWriteToolProps) {
  const contentId = useId();

  const todos = useMemo(() => {
    try {
      if (
        part.input &&
        typeof part.input === "object" &&
        "todos" in part.input &&
        Array.isArray(part.input.todos)
      ) {
        return part.input.todos as Todo[];
      }
    } catch (error) {
      console.error("Failed to parse todos", error);
    }

    return [];
  }, [part.input]);

  const defaultIsOpen =
    todos.length === 0 || todos.some((todo) => todo.status !== "completed");
  const todoStateKey = useMemo(
    () =>
      JSON.stringify({
        toolCallId: part.toolCallId,
        todos,
        errorText,
        state: part.state,
      }),
    [errorText, part.state, part.toolCallId, todos],
  );
  const [isOpen, setIsOpen] = useState(defaultIsOpen);

  useEffect(() => {
    if (!todoStateKey) {
      return;
    }

    setIsOpen(defaultIsOpen);
  }, [defaultIsOpen, todoStateKey]);

  // Count todos by status
  const completedCount = todos.filter((t) => t.status === "completed").length;

  const getStatusIcon = (status: Todo["status"]) => {
    switch (status) {
      case "completed":
        return (
          <CheckCircle2 className="w-3 h-3 text-green-600 flex-shrink-0" />
        );
      case "in_progress":
        return (
          <Clock className="w-3 h-3 text-blue-600 animate-pulse flex-shrink-0" />
        );
      default:
        return (
          <Circle className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
        );
    }
  };

  const getStatusStyles = (status: Todo["status"]) => {
    switch (status) {
      case "completed":
        return "text-muted-foreground/60 line-through";
      case "in_progress":
        return "text-foreground";
      default:
        return "text-muted-foreground";
    }
  };

  if (todos.length === 0 && !errorText && !toolResultPart) {
    return null;
  }

  return (
    <div className={cn("rounded-md border bg-card/50", className)}>
      <button
        type="button"
        className="w-full px-3 py-2 border-b bg-muted/20 cursor-pointer hover:bg-muted/30 transition-colors text-left"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={contentId}
      >
        <div className="flex items-center gap-2">
          <ListTodo className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            Tasks
          </span>
          {todos.length > 0 && (
            <span className="text-xs text-muted-foreground/70 ml-auto">
              {completedCount}/{todos.length}
            </span>
          )}
          <ChevronDown
            className={cn(
              "w-3.5 h-3.5 text-muted-foreground transition-transform",
              !isOpen && "-rotate-90",
            )}
          />
        </div>
      </button>
      {isOpen && (
        <div id={contentId} className="px-3 py-2">
          {todos.length > 0 ? (
            <div className="space-y-0.5">
              {todos.map((todo) => (
                <div
                  key={`${todo.content}-${todo.status}`}
                  className="flex items-center gap-2 py-0.5"
                >
                  {getStatusIcon(todo.status)}
                  <span
                    className={cn(
                      "text-xs break-words",
                      getStatusStyles(todo.status),
                    )}
                  >
                    {todo.content}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No tasks</div>
          )}

          {/* Show error if any */}
          {errorText && (
            <div className="mt-2 p-1.5 bg-destructive/10 rounded text-xs text-destructive">
              {errorText}
            </div>
          )}

          {/* Show approval buttons when policy requires approval */}
          {part.state === "approval-requested" &&
            onToolApprovalResponse &&
            "approval" in part &&
            part.approval?.id && (
              <div className="flex items-center gap-2 mt-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: true,
                    });
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToolApprovalResponse({
                      id: (part as { approval: { id: string } }).approval.id,
                      approved: false,
                      reason: "User denied",
                    });
                  }}
                >
                  Deny
                </Button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
