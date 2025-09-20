import { type DynamicToolUIPart, ReasoningUIPart, type TextUIPart, UIMessage } from 'ai';
import { Edit2, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import ThinkBlock from '@ui/components/ThinkBlock';
import TokenUsageDisplay from '@ui/components/TokenUsageDisplay';
import ToolInvocation from '@ui/components/ToolInvocation';
import { AIResponse } from '@ui/components/kibo/ai-response';
import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';

import RegenerationSkeleton from './RegenerationSkeleton';

interface AssistantMessageProps {
  message: UIMessage;
  isEditing: boolean;
  editingContent: string;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onEditChange: (content: string) => void;
  onDelete: () => void;
  onRegenerate: () => void;
  isRegenerating?: boolean;
  tokenUsage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    model?: string | null;
    modelContextWindow?: number | null;
  };
}

export default function AssistantMessage({
  message,
  isEditing,
  editingContent,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditChange,
  onDelete,
  onRegenerate,
  isRegenerating = false,
  tokenUsage,
}: AssistantMessageProps) {
  const [isHovered, setIsHovered] = useState(false);

  if (!message.parts) {
    return null;
  }

  // Extract text content for editing
  let fullTextContent = '';
  if (message.parts) {
    fullTextContent = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as TextUIPart).text)
      .join('');
  }

  if (isEditing) {
    return (
      <div className="space-y-2">
        <Textarea
          value={editingContent}
          onChange={(e) => onEditChange(e.target.value)}
          className="min-h-[100px] resize-none"
          autoFocus
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={onEditSave}>
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={onEditCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Separate parts by type to ensure proper ordering
  const reasoningParts: ReasoningUIPart[] = [];
  const toolParts: DynamicToolUIPart[] = [];
  let accumulatedText = '';

  // First pass: collect and separate parts
  message.parts.forEach((part) => {
    if (part.type === 'text') {
      accumulatedText += part.text;
    } else if (part.type === 'reasoning') {
      reasoningParts.push(part);
    } else if (part.type === 'dynamic-tool') {
      toolParts.push(part);
    }
  });

  // Build ordered elements: reasoning blocks first, then tools, then text
  const orderedElements: React.ReactNode[] = [];

  // Add all reasoning blocks first (thinking blocks appear above final message)
  reasoningParts.forEach((reasoningPart, index) => {
    orderedElements.push(
      <ThinkBlock
        key={`reasoning-${index}`}
        content={reasoningPart.text || ''}
        isStreaming={reasoningPart.state !== 'done'}
      />
    );
  });

  // Add tool invocations
  toolParts.forEach((tool, index) => {
    orderedElements.push(<ToolInvocation key={tool.toolCallId || `tool-${index}`} tool={tool} />);
  });

  // Add final text content last
  if (accumulatedText.trim()) {
    orderedElements.push(<AIResponse key={`text-final`}>{accumulatedText.trim()}</AIResponse>);
  }

  return (
    <div className="relative group" onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
      <div className="gap-y-2 grid grid-cols-1 pr-24">
        {isRegenerating ? <RegenerationSkeleton /> : orderedElements}
      </div>

      {/* Token usage display */}
      {tokenUsage && tokenUsage.totalTokens && (
        <div className="mt-2 flex items-center gap-2">
          <TokenUsageDisplay
            promptTokens={tokenUsage.promptTokens}
            completionTokens={tokenUsage.completionTokens}
            totalTokens={tokenUsage.totalTokens}
            model={tokenUsage.model}
            contextWindow={tokenUsage.modelContextWindow}
            variant="inline"
          />
        </div>
      )}

      {isHovered && (
        <div className="absolute top-0 right-0 flex gap-1">
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => onEditStart()} title="Edit message">
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={onRegenerate}
            disabled={isRegenerating}
            title="Regenerate message"
          >
            <RefreshCw className={`h-3 w-3 ${isRegenerating ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onDelete} title="Delete message">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
