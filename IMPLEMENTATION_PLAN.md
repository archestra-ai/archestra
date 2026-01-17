# Implementation Plan: Tool Run and Use as Prompt Actions

## Overview
Add interactive "Run Tool" and "Use as Prompt" buttons to tool outputs in the chat interface.

## Files to Modify

### 1. ✅ `platform/frontend/src/components/ai-elements/tool.tsx`
**Status**: COMPLETED
- Added `onRunTool` and `onUseAsPrompt` optional callback props to `ToolOutput`
- Added action buttons with Play and MessageSquare icons
- Added tooltips for better UX
- Buttons hidden for error outputs

### 2. `platform/frontend/src/components/chat/chat-messages.tsx`
**Changes Needed**:
- Add callback props to `ChatMessagesProps` interface:
  ```typescript
  onToolRun?: (toolName: string, toolInput: Record<string, unknown>) => void;
  onToolOutputAsPrompt?: (output: unknown) => void;
  ```
- Update `ChatMessages` function signature to destructure new props
- Pass callbacks to `MessageTool` component
- Update `MessageTool` to accept and use callbacks:
  ```typescript
  function MessageTool({
    part,
    toolResultPart,
    toolName,
    agentId,
    onToolRun,
    onToolOutputAsPrompt,
  }: {
    part: ToolUIPart | DynamicToolUIPart;
    toolResultPart: ToolUIPart | DynamicToolUIPart | null;
    toolName: string;
    agentId?: string;
    onToolRun?: (toolName: string, toolInput: Record<string, unknown>) => void;
    onToolOutputAsPrompt?: (output: unknown) => void;
  })
  ```
- Create handlers in `MessageTool` and pass to `ToolOutput`:
  ```typescript
  const handleRunTool = onToolRun && part.input
    ? () => onToolRun(toolName, part.input)
    : undefined;
  
  const handleUseAsPrompt = onToolOutputAsPrompt && (toolResultPart || part.output)
    ? () => onToolOutputAsPrompt(toolResultPart?.output || part.output)
    : undefined;
  ```

### 3. `platform/frontend/src/app/chat/page.tsx`
**Changes Needed**:
- Implement `handleToolRun` callback:
  ```typescript
  const handleToolRun = useCallback((toolName: string, toolInput: Record<string, unknown>) => {
    if (!session) return;
    
    // Create a message that triggers the tool
    const toolMessage = `Run the ${toolName} tool with these parameters:\n${JSON.stringify(toolInput, null, 2)}`;
    
    session.sendMessage({
      role: "user",
      content: toolMessage,
    });
  }, [session]);
  ```
- Implement `handleToolOutputAsPrompt` callback:
  ```typescript
  const handleToolOutputAsPrompt = useCallback((output: unknown) => {
    const outputText = typeof output === "string" 
      ? output 
      : JSON.stringify(output, null, 2);
    
    // Set the output as the input text
    // This requires access to the prompt input controller
    // We'll need to expose a method to set input text
    controller?.textInput.setInput(outputText);
    
    // Focus the textarea
    textareaRef.current?.focus();
  }, [controller, textareaRef]);
  ```
- Pass callbacks to `ChatMessages` component:
  ```typescript
  <ChatMessages
    conversationId={conversationId}
    agentId={currentAgentId}
    messages={session.messages}
    hideToolCalls={hideToolCalls}
    status={session.status}
    isLoadingConversation={isLoadingConversation}
    onMessagesUpdate={session.setMessages}
    onUserMessageEdit={handleUserMessageEdit}
    error={session.error}
    onToolRun={handleToolRun}
    onToolOutputAsPrompt={handleToolOutputAsPrompt}
  />
  ```

## Implementation Steps

1. ✅ Update `tool.tsx` with action buttons
2. Update `chat-messages.tsx` to accept and pass callbacks
3. Update `chat/page.tsx` to implement callbacks
4. Test the feature
5. Create PR

## Testing Checklist

- [ ] "Run Tool" button appears on successful tool outputs
- [ ] "Run Tool" button triggers tool re-execution with same parameters
- [ ] "Use as Prompt" button copies output to chat input
- [ ] Buttons don't appear on error outputs
- [ ] Tooltips display correctly
- [ ] Buttons work for both `tool-*` and `dynamic-tool` types
- [ ] No TypeScript errors
- [ ] No linting errors
