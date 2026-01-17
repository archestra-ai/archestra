# Tool Action Callbacks Implementation Guide

## Overview
This PR adds interactive tool action buttons to the chat interface, allowing users to:
1. **Run Again**: Re-execute a tool with the same inputs
2. **Use as Prompt**: Copy tool output to the input textarea

## Changes Made

### 1. Updated `chat-messages.tsx` ✅
- Added `onToolRun` and `onToolOutputAsPrompt` props to `ChatMessagesProps`
- Passed callbacks down to `MessageTool` component
- `MessageTool` creates handlers and passes them to `ToolOutput`

### 2. Need to Update `page.tsx`

Add these two callback functions after the `handleSubmit` function (around line 665):

```typescript
  // Handle tool run action - sends a new message requesting to run the tool
  const handleToolRun = useCallback(
    (toolName: string, toolInput: Record<string, unknown>) => {
      if (!sendMessage || status === "submitted" || status === "streaming") {
        return;
      }

      // Create a message that requests running the tool with the given input
      const toolMessage = `Run tool: ${toolName}\n\nInput:\n${JSON.stringify(toolInput, null, 2)}`;

      sendMessage({
        role: "user",
        parts: [{ type: "text", text: toolMessage }],
      });
    },
    [sendMessage, status],
  );

  // Handle tool output as prompt - populates textarea with tool output
  const handleToolOutputAsPrompt = useCallback((output: unknown) => {
    // Convert output to string format
    let outputText: string;
    if (typeof output === "string") {
      try {
        // Try to parse and pretty-print JSON
        const parsed = JSON.parse(output);
        outputText = JSON.stringify(parsed, null, 2);
      } catch {
        // Not JSON, use as-is
        outputText = output;
      }
    } else {
      outputText = JSON.stringify(output, null, 2);
    }

    // Set the textarea value
    if (textareaRef.current) {
      textareaRef.current.value = outputText;
      textareaRef.current.focus();
      // Trigger input event to update any controlled state
      const event = new Event("input", { bubbles: true });
      textareaRef.current.dispatchEvent(event);
    }
  }, []);
```

Then update the `ChatMessages` component call (around line 998) to add these two props:

```typescript
<ChatMessages
  conversationId={conversationId}
  agentId={currentProfileId}
  messages={messages}
  hideToolCalls={hideToolCalls}
  status={status}
  isLoadingConversation={isLoadingConversation}
  onMessagesUpdate={setMessages}
  onUserMessageEdit={(editedMessage, updatedMessages, editedPartIndex) => {
    // ... existing code ...
  }}
  error={error}
  onToolRun={handleToolRun}  // ADD THIS LINE
  onToolOutputAsPrompt={handleToolOutputAsPrompt}  // ADD THIS LINE
/>
```

## Testing
1. Start a chat conversation
2. Use a tool that generates output
3. Verify "Run Again" button appears and re-executes the tool
4. Verify "Use as Prompt" button copies output to textarea

## Files Modified
- ✅ `platform/frontend/src/components/chat/chat-messages.tsx`
- ⏳ `platform/frontend/src/app/chat/page.tsx` (needs manual update)
