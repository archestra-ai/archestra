import { type TextUIPart, UIMessage } from 'ai';
import { Edit2, Trash2 } from 'lucide-react';

import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';

interface UserMessageProps {
  message: UIMessage;
  isEditing?: boolean;
  editingContent?: string;
  onEditStart?: () => void;
  onEditCancel?: () => void;
  onEditSave?: () => Promise<void>;
  onEditChange?: (content: string) => void;
  onDelete?: () => Promise<void>;
}

export default function UserMessage({
  message,
  isEditing,
  editingContent,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditChange,
  onDelete,
}: UserMessageProps) {
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
        <Textarea
          value={editingContent}
          onChange={(e) => onEditChange?.(e.target.value)}
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
