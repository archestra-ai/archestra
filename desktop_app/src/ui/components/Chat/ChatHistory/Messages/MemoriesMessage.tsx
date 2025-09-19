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
  const memories = lines.slice(1).filter((line) => line.trim());

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
        <div className="px-3 py-2 border-t border-green-500/20 space-y-1">
          {memories.map((memory, index) => {
            const [key, ...valueParts] = memory.split(':');
            const value = valueParts.join(':').trim();

            return (
              <div key={index} className="text-sm">
                <span className="font-medium text-green-700 dark:text-green-300">{key}:</span>
                <span className="text-green-600 dark:text-green-400 ml-2">{value}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
