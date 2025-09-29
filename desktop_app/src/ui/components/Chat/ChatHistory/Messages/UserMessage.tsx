import { type TextUIPart, UIMessage } from 'ai';
import { Edit2, Trash2 } from 'lucide-react';
import { memo, useRef } from 'react';

import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';

interface UserMessageProps {
  message: UIMessage;
  isEditing?: boolean;
  defaultValue?: string;
  onEditStart?: () => void;
  onEditCancel?: () => void;
  onSave: (content?: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}

function UserMessage({
  message,
  isEditing,
  defaultValue,
  onEditStart,
  onEditCancel,
  onSave,
  onDelete,
}: UserMessageProps) {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  // Extract text content from parts array (UIMessage in ai SDK v5 uses parts)
  let textContent = '';

  if (message.parts) {
    textContent = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as TextUIPart).text)
      .join('');
  }

  if (isEditing) {
    return (
      <div className="space-y-2">
        <Textarea ref={textAreaRef} defaultValue={defaultValue} className="min-h-[100px] resize-none" autoFocus />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onSave(textAreaRef.current?.value)}>
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={onEditCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative group">
      <div className="text-sm whitespace-pre-wrap pr-20 min-h-6 pt-0.5">{textContent}</div>

      <div className="absolute hidden group-hover:flex top-0 right-0 gap-1">
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onEditStart} title="Edit message">
          <Edit2 className="h-3 w-3" />
        </Button>

        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onDelete} title="Delete message">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

const MemoizedUserMessage = memo(UserMessage);

export default MemoizedUserMessage;
