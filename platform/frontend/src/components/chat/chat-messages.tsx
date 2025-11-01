import type { UIMessage } from "@ai-sdk/react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChatMessagesProps {
  messages: UIMessage[];
}

export function ChatMessages({ messages }: ChatMessagesProps) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg mb-2">No messages yet</p>
          <p className="text-sm">Start a conversation by sending a message</p>
        </div>
      </div>
    );
  }

  const renderMessagePart = (part: any, index: number) => {
    // Text content
    if (part.type === "text") {
      return (
        <div key={index} className="whitespace-pre-wrap">
          {part.text}
        </div>
      );
    }

    // Step start (thinking indicator)
    if (part.type === "step-start") {
      return (
        <div
          key={index}
          className="my-2 p-2 rounded border border-purple-300 bg-purple-50 dark:bg-purple-950 dark:border-purple-700"
        >
          <div className="text-xs text-purple-600 dark:text-purple-400">
            💭 Thinking...
          </div>
        </div>
      );
    }

    // Tool invocation (type is "tool-{toolName}")
    if (part.type?.startsWith("tool-")) {
      const toolName = part.type.replace("tool-", "");
      const state = part.state;

      // Input streaming
      if (state === "input-streaming") {
        return (
          <div
            key={index}
            className="my-2 p-3 rounded border border-blue-300 bg-blue-50 dark:bg-blue-950 dark:border-blue-700"
          >
            <div className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-1">
              🔧 Calling: {toolName}
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400">
              Loading...
            </div>
          </div>
        );
      }

      // Input available (tool called with input)
      if (state === "input-available") {
        return (
          <div
            key={index}
            className="my-2 p-3 rounded border border-blue-300 bg-blue-50 dark:bg-blue-950 dark:border-blue-700"
          >
            <div className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-1">
              🔧 Tool Call: {toolName}
            </div>
            {part.input && Object.keys(part.input).length > 0 && (
              <details className="text-xs text-blue-600 dark:text-blue-400">
                <summary className="cursor-pointer">Arguments</summary>
                <pre className="mt-1 overflow-x-auto">
                  {JSON.stringify(part.input, null, 2)}
                </pre>
              </details>
            )}
          </div>
        );
      }

      // Output available (tool completed successfully)
      if (state === "output-available") {
        return (
          <div
            key={index}
            className="my-2 p-3 rounded border border-green-300 bg-green-50 dark:bg-green-950 dark:border-green-700"
          >
            <div className="text-xs font-medium text-green-700 dark:text-green-300 mb-2">
              ✅ Tool Result: {toolName}
            </div>
            {part.input && Object.keys(part.input).length > 0 && (
              <details className="text-xs text-green-600 dark:text-green-400 mb-2">
                <summary className="cursor-pointer">Input</summary>
                <pre className="mt-1 overflow-x-auto">
                  {JSON.stringify(part.input, null, 2)}
                </pre>
              </details>
            )}
            <div className="text-sm text-green-800 dark:text-green-200 whitespace-pre-wrap">
              {typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </div>
          </div>
        );
      }

      // Output error (tool failed)
      if (state === "output-error") {
        return (
          <div
            key={index}
            className="my-2 p-3 rounded border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-700"
          >
            <div className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">
              ❌ Tool Error: {toolName}
            </div>
            <div className="text-sm text-red-800 dark:text-red-200">
              {part.errorText || "Unknown error"}
            </div>
          </div>
        );
      }

      // Unknown tool state
      return (
        <div
          key={index}
          className="my-2 p-2 rounded border border-gray-300 bg-gray-50 dark:bg-gray-950 dark:border-gray-700"
        >
          <div className="text-xs text-gray-600 dark:text-gray-400">
            🔧 {toolName} (state: {state || "unknown"})
          </div>
        </div>
      );
    }

    // Dynamic tool (MCP tools at runtime)
    if (part.type === "dynamic-tool") {
      const state = part.state;
      const toolName = part.toolName;

      if (state === "output-available") {
        return (
          <div
            key={index}
            className="my-2 p-3 rounded border border-green-300 bg-green-50 dark:bg-green-950 dark:border-green-700"
          >
            <div className="text-xs font-medium text-green-700 dark:text-green-300 mb-1">
              ✅ Dynamic Tool Result: {toolName}
            </div>
            <div className="text-sm text-green-800 dark:text-green-200 whitespace-pre-wrap">
              {typeof part.output === "string"
                ? part.output
                : JSON.stringify(part.output, null, 2)}
            </div>
          </div>
        );
      }
    }

    // Reasoning part
    if (part.type === "reasoning") {
      return (
        <div
          key={index}
          className="my-2 p-3 rounded border border-indigo-300 bg-indigo-50 dark:bg-indigo-950 dark:border-indigo-700"
        >
          <div className="text-xs font-medium text-indigo-700 dark:text-indigo-300 mb-1">
            🧠 Reasoning
          </div>
          <div className="text-sm text-indigo-800 dark:text-indigo-200 whitespace-pre-wrap">
            {part.text}
          </div>
        </div>
      );
    }

    // Fallback for unknown part types
    return (
      <div key={index} className="text-xs text-muted-foreground">
        [Unknown part type: {part.type}]
      </div>
    );
  };

  return (
    <ScrollArea className="flex-1 p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        {messages.map((message, index) => (
          <div
            key={message.id || index}
            className={`flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 ${
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              }`}
            >
              <div className="text-sm font-medium mb-1">
                {message.role === "user" ? "You" : "Assistant"}
              </div>
              <div className="space-y-2">
                {message.parts?.map((part, partIndex) =>
                  renderMessagePart(part, partIndex),
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
