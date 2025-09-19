import { Pencil } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { Input } from '@ui/components/ui/input';

import { TypewriterText } from '../TypewriterText';

interface EditableTitleProps {
  title: string;
  isAnimated: boolean;
  onSave: (newTitle: string) => Promise<void>;
  className?: string;
}

export function EditableTitle({ title, isAnimated, onSave, className = '' }: EditableTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(title);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditedTitle(title);
  }, [title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (isSaving) {
      return;
    }

    setIsSaving(true);
    try {
      await onSave(editedTitle.trim());
      setIsEditing(false);
    } catch (error) {
      // Reset to original title on error
      setEditedTitle(title);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedTitle(title);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (isEditing) {
    return (
      <Input
        ref={inputRef}
        value={editedTitle}
        onChange={(e) => setEditedTitle(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={isSaving}
        className={`h-6 px-1 py-0 text-sm bg-background text-foreground selection:bg-primary selection:text-primary-foreground ${className}`}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div
      className={`cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 flex items-center gap-1 ${className}`}
      onDoubleClick={() => setIsEditing(true)}
    >
      <span className="truncate">{isAnimated ? <TypewriterText text={title} speed={20} /> : title}</span>
      <Pencil className="h-3 w-3 opacity-0 group-hover/chat-button:opacity-50" />
    </div>
  );
}
