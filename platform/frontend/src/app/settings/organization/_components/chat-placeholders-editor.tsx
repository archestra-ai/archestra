"use client";

import { Plus, X } from "lucide-react";
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ChatPlaceholdersEditorProps {
  placeholders: string[];
  onChange: (placeholders: string[]) => void;
}

export function ChatPlaceholdersEditor({
  placeholders,
  onChange,
}: ChatPlaceholdersEditorProps) {
  // Stable ID generator scoped to this component instance
  const nextIdRef = useRef(0);
  const generateId = useCallback(
    () => `placeholder-${++nextIdRef.current}`,
    [],
  );

  // Maintain stable keys for each placeholder entry
  const keysRef = useRef<string[]>([]);
  while (keysRef.current.length < placeholders.length) {
    keysRef.current.push(generateId());
  }
  keysRef.current.length = placeholders.length;

  const handleAdd = useCallback(() => {
    if (placeholders.length >= 20) return;
    keysRef.current.push(generateId());
    onChange([...placeholders, ""]);
  }, [placeholders, onChange, generateId]);

  const handleRemove = useCallback(
    (index: number) => {
      keysRef.current.splice(index, 1);
      onChange(placeholders.filter((_, i) => i !== index));
    },
    [placeholders, onChange],
  );

  const handleChange = useCallback(
    (index: number, value: string) => {
      const updated = [...placeholders];
      updated[index] = value;
      onChange(updated);
    },
    [placeholders, onChange],
  );

  return (
    <div className="space-y-2">
      <Label>Chat Placeholders</Label>
      <p className="text-xs text-muted-foreground">
        Custom placeholder texts for the chat input. Max 20 entries, 80 chars
        each.
      </p>
      <div className="space-y-2">
        {placeholders.map((placeholder, index) => (
          <div key={keysRef.current[index]} className="flex items-center gap-2">
            <Input
              value={placeholder}
              onChange={(e) => handleChange(index, e.target.value)}
              placeholder={`Placeholder ${index + 1}`}
              maxLength={80}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleRemove(index)}
              className="shrink-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {placeholders.length < 20 && (
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus className="h-4 w-4" />
          Add Placeholder
        </Button>
      )}
    </div>
  );
}
