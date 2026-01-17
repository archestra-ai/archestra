#!/usr/bin/env python3
"""
Script to apply tool action callbacks to page.tsx
This script fetches the file, applies the modifications, and can output the result.
"""

import re

# The callbacks code to insert
CALLBACKS_CODE = '''
  // Handle tool run action - sends a new message requesting to run the tool
  const handleToolRun = useCallback(
    (toolName: string, toolInput: Record<string, unknown>) => {
      if (!sendMessage || status === "submitted" || status === "streaming") {
        return;
      }

      // Create a message that requests running the tool with the given input
      const toolMessage = `Run tool: ${toolName}\\n\\nInput:\\n${JSON.stringify(toolInput, null, 2)}`;

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
'''

def apply_patch(content: str) -> str:
    """Apply the tool callbacks patch to the page.tsx content"""
    
    # Step 1: Insert callbacks after handleSubmit function
    # Find the position right before "// Handle initial prompt change"
    marker = "  // Handle initial prompt change (when no conversation exists)"
    if marker not in content:
        raise ValueError("Could not find insertion point for callbacks")
    
    content = content.replace(marker, CALLBACKS_CODE + "\n" + marker)
    
    # Step 2: Add props to ChatMessages component
    # Find the ChatMessages component and add the props after error={error}
    pattern = r'(error={error}\n)'
    replacement = r'\1                onToolRun={handleToolRun}\n                onToolOutputAsPrompt={handleToolOutputAsPrompt}\n'
    
    content = re.sub(pattern, replacement, content, count=1)
    
    return content

def main():
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python apply-tool-callbacks.py <input_file> [output_file]")
        print("If output_file is not specified, prints to stdout")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    # Read the input file
    with open(input_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Apply the patch
    try:
        modified_content = apply_patch(content)
        
        if output_file:
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(modified_content)
            print(f"✅ Successfully applied patch to {output_file}")
        else:
            print(modified_content)
            
    except Exception as e:
        print(f"❌ Error applying patch: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
