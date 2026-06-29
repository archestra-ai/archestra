"use client";

import { Plus, X } from "lucide-react";
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  ChatLinkEditorValue,
  ChatLinkValidationError,
} from "./chat-links-editor.utils";

interface ChatLinksEditorProps {
  links: ChatLinkEditorValue[];
  validationErrors: ChatLinkValidationError[];
  onChange: (links: ChatLinkEditorValue[]) => void;
}

export function ChatLinksEditor({
  links,
  validationErrors,
  onChange,
}: ChatLinksEditorProps) {
  const nextIdRef = useRef(0);
  const generateId = useCallback(() => `chat-link-${++nextIdRef.current}`, []);

  const keysRef = useRef<string[]>([]);
  while (keysRef.current.length < links.length) {
    keysRef.current.push(generateId());
  }
  keysRef.current.length = links.length;

  const handleAdd = useCallback(() => {
    if (links.length >= 3) return;
    keysRef.current.push(generateId());
    onChange([
      ...links,
      {
        label: "",
        url: "",
      },
    ]);
  }, [generateId, links, onChange]);

  const handleRemove = useCallback(
    (index: number) => {
      keysRef.current.splice(index, 1);
      onChange(links.filter((_, currentIndex) => currentIndex !== index));
    },
    [links, onChange],
  );

  const handleFieldChange = useCallback(
    (params: {
      index: number;
      field: keyof ChatLinkEditorValue;
      value: string;
    }) => {
      const updatedLinks = [...links];
      updatedLinks[params.index] = {
        ...updatedLinks[params.index],
        [params.field]: params.value,
      };
      onChange(updatedLinks);
    },
    [links, onChange],
  );

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Chat Links</Label>
        <p className="text-xs text-muted-foreground">
          Add up to 3 optional buttons shown on the new chat page. Labels are
          required and limited to 25 characters.
        </p>
      </div>
      <div className="space-y-3">
        {links.map((link, index) => {
          const errors = validationErrors[index];

          return (
            <div
              key={keysRef.current[index]}
              className="rounded-lg border p-3 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Link {index + 1}</p>
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
              <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  <Label htmlFor={`chatLinkLabel-${index}`}>Label</Label>
                  <Input
                    id={`chatLinkLabel-${index}`}
                    value={link.label}
                    onChange={(event) =>
                      handleFieldChange({
                        index,
                        field: "label",
                        value: event.target.value,
                      })
                    }
                    placeholder="Help Center"
                    maxLength={25}
                    aria-invalid={!!errors?.label}
                  />
                  <p
                    className={
                      errors?.label
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {errors?.label ?? "Required. Max 25 characters."}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`chatLinkUrl-${index}`}>URL</Label>
                  <Input
                    id={`chatLinkUrl-${index}`}
                    type="url"
                    value={link.url}
                    onChange={(event) =>
                      handleFieldChange({
                        index,
                        field: "url",
                        value: event.target.value,
                      })
                    }
                    placeholder="https://docs.example.com"
                    maxLength={2000}
                    aria-invalid={!!errors?.url}
                  />
                  <p
                    className={
                      errors?.url
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {errors?.url ?? "Required. Must use HTTP or HTTPS."}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {links.length < 3 && (
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus className="h-4 w-4" />
          Add Link
        </Button>
      )}
    </div>
  );
}
