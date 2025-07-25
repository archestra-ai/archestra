import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface DeleteChatConfirmationProps {
  onDelete: () => void;
}

export function DeleteChatConfirmation({ onDelete }: DeleteChatConfirmationProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleDelete = () => {
    onDelete();
    setOpen(false);
  };

  const handleCancel = () => {
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity ml-1"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
          <span className="sr-only">Delete chat</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="center" className="w-auto p-3" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-2">
          <p className="text-sm font-medium">Delete this chat?</p>
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
