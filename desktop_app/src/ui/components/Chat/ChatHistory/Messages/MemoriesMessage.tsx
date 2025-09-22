import { type TextUIPart, UIMessage } from 'ai';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface MemoriesMessageProps {
  message: UIMessage;
}

export default function MemoriesMessage({ message }: MemoriesMessageProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Extract text content from parts array
  let textContent = '';
  if (message.parts) {
    textContent = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as TextUIPart).text)
      .join('');
  }

  // Parse memories from the text content
  const lines = textContent.split('\n');
  const headerText = lines[0] || 'Memories loaded';

  // Parse memories more carefully to handle multi-line values
  const memories: Array<{ key: string; value: string }> = [];
  let currentKey = '';
  let currentValue: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Check if this line starts a new memory (contains a colon and looks like a key)
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0 && colonIndex < 50 && !line.substring(0, colonIndex).includes(' ')) {
      // Save previous memory if exists
      if (currentKey) {
        memories.push({ key: currentKey, value: currentValue.join('\n') });
      }
      // Start new memory
      currentKey = line.substring(0, colonIndex);
      currentValue = [line.substring(colonIndex + 1).trim()];
    } else if (currentKey && line.trim()) {
      // This is a continuation of the current memory value
      currentValue.push(line);
    }
  }

  // Don't forget the last memory
  if (currentKey) {
    memories.push({ key: currentKey, value: currentValue.join('\n') });
  }

  return (
    <div className="bg-green-500/10 border border-green-500/20 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-green-500/20 transition-colors text-left"
      >
        <Brain className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
        <span className="text-sm font-medium text-green-700 dark:text-green-300 flex-1">
          {headerText} ({memories.length} items)
        </span>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
        )}
      </button>

      {isExpanded && memories.length > 0 && (
        <div className="px-3 py-2 border-t border-green-500/20 space-y-2">
          {memories.map((memory, index) => (
            <div key={index} className="text-sm">
              <span className="font-medium text-green-700 dark:text-green-300">{memory.key}:</span>
              <pre className="text-green-600 dark:text-green-400 ml-2 inline whitespace-pre-wrap font-sans">
                {memory.value}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
