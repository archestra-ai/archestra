import { type DynamicToolUIPart, type TextUIPart, UIMessage } from 'ai';
import { Edit2, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import ThinkBlock from '@ui/components/ThinkBlock';
import TokenUsageDisplay from '@ui/components/TokenUsageDisplay';
import ToolInvocation from '@ui/components/ToolInvocation';
import { AIResponse } from '@ui/components/kibo/ai-response';
import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';
import { ToolCallStatus } from '@ui/types';

import RegenerationSkeleton from './RegenerationSkeleton';

interface AssistantMessageProps {
  message: UIMessage;
  messageIndex: number;
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

const THINK_TAG_LENGTH = '<think>'.length;
const THINK_END_TAG_LENGTH = '</think>'.length;

export default function AssistantMessage({
  message,
  messageIndex,
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

  // Process parts in order to maintain sequence
  const orderedElements: React.ReactNode[] = [];
  let accumulatedText = '';
  let currentThinkBlock: string | null = null;
  let isInThinkBlock = false;

  message.parts.forEach((part, index) => {
    if (part.type === 'text') {
      const textPart = part as TextUIPart;
      const text = textPart.text;

      // Process text character by character to handle think blocks
      let i = 0;
      while (i < text.length) {
        if (!isInThinkBlock) {
          // Look for <think> tag
          const thinkStart = text.indexOf('<think>', i);
          if (thinkStart !== -1) {
            // Add any text before think block
            const beforeThink = text.substring(i, thinkStart);
            accumulatedText += beforeThink;

            // Start think block
            isInThinkBlock = true;
            currentThinkBlock = '';
            i = thinkStart + THINK_TAG_LENGTH; // Skip '<think>'
          } else {
            // No think block, add remaining text
            accumulatedText += text.substring(i);
            break;
          }
        } else {
          // We're in a think block, look for </think>
          const thinkEnd = text.indexOf('</think>', i);
          if (thinkEnd !== -1) {
            // Complete think block
            currentThinkBlock += text.substring(i, thinkEnd);

            // Flush accumulated text if any
            if (accumulatedText.trim()) {
              orderedElements.push(
                <AIResponse key={`text-${orderedElements.length}`}>{accumulatedText.trim()}</AIResponse>
              );
              accumulatedText = '';
            }

            // Add think block
            orderedElements.push(
              <ThinkBlock
                key={`think-${orderedElements.length}`}
                content={currentThinkBlock || ''}
                isStreaming={false}
              />
            );

            isInThinkBlock = false;
            currentThinkBlock = null;
            i = thinkEnd + THINK_END_TAG_LENGTH; // Skip '</think>'
          } else {
            // Still in think block
            currentThinkBlock += text.substring(i);
            break;
          }
        }
      }
    } else if (part.type === 'dynamic-tool') {
      // Flush any accumulated text before tool
      if (accumulatedText.trim()) {
        orderedElements.push(<AIResponse key={`text-${orderedElements.length}`}>{accumulatedText.trim()}</AIResponse>);
        accumulatedText = '';
      }

      // Add tool invocation
      const tool = part as DynamicToolUIPart;
      orderedElements.push(
        <ToolInvocation
          key={tool.toolCallId || `tool-${orderedElements.length}`}
          toolName={tool.toolName}
          args={'input' in tool ? tool.input : {}}
          result={'output' in tool ? tool.output : undefined}
          state={
            tool.state === 'output-available'
              ? ToolCallStatus.Completed
              : tool.state === 'output-error'
                ? ToolCallStatus.Error
                : tool.state === 'input-streaming'
                  ? ToolCallStatus.Pending
                  : ToolCallStatus.Pending
          }
        />
      );
    }
  });

  // Handle any remaining content
  if (isInThinkBlock && currentThinkBlock !== null) {
    // Incomplete think block (still streaming)
    if (accumulatedText.trim()) {
      orderedElements.push(<AIResponse key={`text-${orderedElements.length}`}>{accumulatedText.trim()}</AIResponse>);
    }
    orderedElements.push(<ThinkBlock key={`think-streaming`} content={currentThinkBlock || ''} isStreaming={true} />);
  } else if (accumulatedText.trim()) {
    // Remaining text
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
