#!/usr/bin/env node
/**
 * Script to apply tool action callbacks to page.tsx
 * Run with: node apply-tool-callbacks-patch.js
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'platform/frontend/src/app/chat/page.tsx');

// Read the file
let content = fs.readFileSync(filePath, 'utf8');

// Define the callbacks to insert
const callbacksCode = `
  // Handle tool run action - sends a new message requesting to run the tool
  const handleToolRun = useCallback(
    (toolName: string, toolInput: Record<string, unknown>) => {
      if (!sendMessage || status === "submitted" || status === "streaming") {
        return;
      }

      // Create a message that requests running the tool with the given input
      const toolMessage = \`Run tool: \${toolName}\\n\\nInput:\\n\${JSON.stringify(toolInput, null, 2)}\`;

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
`;

// Insert callbacks after handleSubmit function
const handleSubmitEnd = '  };';
const handleInitialPromptChangeStart = '  // Handle initial prompt change (when no conversation exists)';

// Find the position to insert
const insertPosition = content.indexOf(handleInitialPromptChangeStart);
if (insertPosition === -1) {
  console.error('Could not find insertion point for callbacks');
  process.exit(1);
}

// Insert the callbacks
content = content.slice(0, insertPosition) + callbacksCode + '\n' + content.slice(insertPosition);

// Add props to ChatMessages component
const chatMessagesPattern = /(<ChatMessages[\s\S]*?error={error})/;
const match = content.match(chatMessagesPattern);

if (!match) {
  console.error('Could not find ChatMessages component');
  process.exit(1);
}

const replacement = match[1] + '\n                onToolRun={handleToolRun}\n                onToolOutputAsPrompt={handleToolOutputAsPrompt}';
content = content.replace(chatMessagesPattern, replacement);

// Write the file back
fs.writeFileSync(filePath, content, 'utf8');

console.log('✅ Successfully applied tool callbacks patch to page.tsx');
console.log('   - Added handleToolRun callback');
console.log('   - Added handleToolOutputAsPrompt callback');
console.log('   - Updated ChatMessages component props');
