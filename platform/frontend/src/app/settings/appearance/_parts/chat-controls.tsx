"use client";

import { Info, Plus, X } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type {
  ChatLinkEditorValue,
  ChatLinkValidationError,
} from "./chat-links-editor.utils";

export function ChatPrompts({
  values,
  animated,
  disabled,
  onChange,
  onAnimationChange,
}: {
  values: string[];
  animated: boolean;
  disabled: boolean;
  onChange: (values: string[]) => void;
  onAnimationChange: (value: boolean) => void;
}) {
  const keys = useRowKeys(values.length);
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Label id={`${id}-label`}>Chat placeholders</Label>
          <FieldDescription id={`${id}-description`}>
            Text shown in the empty chat input. Up to 20 prompts, 80 characters
            each.
          </FieldDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {values.length}/20
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || values.length >= 20}
            onClick={() => onChange([...values, ""])}
          >
            <Plus />
            <span>Add prompt</span>
          </Button>
        </div>
      </div>
      <fieldset
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="max-h-80 space-y-2 overflow-y-auto"
      >
        {values.map((value, index) => (
          <div key={keys[index]} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground"
            >
              {String(index + 1).padStart(2, "0")}
            </span>
            <Input
              aria-label={`Chat placeholder ${index + 1}`}
              aria-describedby={`${id}-description`}
              value={value}
              maxLength={80}
              placeholder="Ask a question…"
              disabled={disabled}
              className="min-w-0"
              onChange={(event) =>
                onChange(
                  values.map((item, i) =>
                    i === index ? event.target.value : item,
                  ),
                )
              }
            />
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground"
              aria-label={`Remove placeholder ${index + 1}`}
              disabled={disabled}
              onClick={() => {
                keys.splice(index, 1);
                onChange(values.filter((_, i) => i !== index));
              }}
            >
              <X />
            </Button>
          </div>
        ))}
        {values.length === 0 && (
          <FieldDescription className="py-3">
            The default prompt is used until you add one.
          </FieldDescription>
        )}
      </fieldset>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-animation`}>Animate placeholders</Label>
          <FieldDescription id={`${id}-animation-description`}>
            Single prompts stay static.
          </FieldDescription>
        </div>
        <Switch
          id={`${id}-animation`}
          checked={animated}
          onCheckedChange={onAnimationChange}
          disabled={disabled}
          aria-describedby={`${id}-animation-description`}
        />
      </div>
    </div>
  );
}

export function ChatShortcutLinks({
  values,
  errors,
  disabled,
  onChange,
}: {
  values: ChatLinkEditorValue[];
  errors: ChatLinkValidationError[];
  disabled: boolean;
  onChange: (values: ChatLinkEditorValue[]) => void;
}) {
  const keys = useRowKeys(values.length);
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Label id={`${id}-label`}>Chat links</Label>
          <FieldDescription id={`${id}-description`}>
            Shortcuts on new chats. Labels up to 25 characters.
          </FieldDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {values.length}/3
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || values.length >= 3}
            onClick={() => onChange([...values, { label: "", url: "" }])}
          >
            <Plus />
            <span>Add link</span>
          </Button>
        </div>
      </div>
      <fieldset
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="space-y-2"
      >
        {values.length > 0 && (
          <div
            aria-hidden="true"
            className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_28px] gap-2 sm:grid"
          >
            <Label>Label</Label>
            <Label>Destination</Label>
          </div>
        )}
        {values.map((link, index) => {
          const error = errors[index]?.label || errors[index]?.url;
          return (
            <div key={keys[index]} className="space-y-2">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_28px] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_28px]">
                <Input
                  aria-label={`Link ${index + 1} label`}
                  aria-describedby={
                    error ? `${keys[index]}-error` : `${id}-description`
                  }
                  aria-invalid={!!errors[index]?.label}
                  value={link.label}
                  maxLength={25}
                  placeholder="Help Center"
                  disabled={disabled}
                  className="col-start-1 row-start-1 min-w-0"
                  onChange={(event) =>
                    onChange(
                      values.map((item, i) =>
                        i === index
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <Input
                  type="url"
                  aria-label={`Link ${index + 1} URL`}
                  aria-describedby={
                    error ? `${keys[index]}-error` : `${id}-description`
                  }
                  aria-invalid={!!errors[index]?.url}
                  value={link.url}
                  maxLength={2000}
                  placeholder="https://…"
                  disabled={disabled}
                  className="col-span-2 min-w-0 sm:col-span-1"
                  onChange={(event) =>
                    onChange(
                      values.map((item, i) =>
                        i === index
                          ? { ...item, url: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="col-start-2 row-start-1 text-muted-foreground sm:col-start-3"
                  aria-label={`Remove link ${index + 1}`}
                  disabled={disabled}
                  onClick={() => {
                    keys.splice(index, 1);
                    onChange(values.filter((_, i) => i !== index));
                  }}
                >
                  <X />
                </Button>
              </div>
              {error && (
                <InlineNotice id={`${keys[index]}-error`} variant="error">
                  <Info />
                  <span className="font-medium">{error}</span>
                </InlineNotice>
              )}
            </div>
          );
        })}
        {values.length === 0 && (
          <FieldDescription className="py-3">
            No shortcuts configured.
          </FieldDescription>
        )}
      </fieldset>
    </div>
  );
}

export function ChatErrorSettings({
  message,
  simplified,
  disabled,
  onMessageChange,
  onSimplifiedChange,
}: {
  message: string;
  simplified: boolean;
  disabled: boolean;
  onMessageChange: (value: string) => void;
  onSimplifiedChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-4">
      <Label>Chat errors</Label>
      <div className="space-y-2">
        <Label htmlFor={`${id}-support`}>Support message</Label>
        <FieldDescription id={`${id}-support-description`}>
          Shown when a chat response fails.
        </FieldDescription>
        <Input
          id={`${id}-support`}
          aria-describedby={`${id}-support-description`}
          value={message}
          maxLength={500}
          placeholder="Contact your support team for assistance"
          disabled={disabled}
          onChange={(event) => onMessageChange(event.target.value)}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-details`}>Show detailed errors</Label>
          <FieldDescription id={`${id}-details-description`}>
            Include provider, model, and technical diagnostics.
          </FieldDescription>
        </div>
        <Switch
          id={`${id}-details`}
          checked={!simplified}
          onCheckedChange={(showDetails) => onSimplifiedChange(!showDetails)}
          disabled={disabled}
          aria-describedby={`${id}-details-description`}
        />
      </div>
    </div>
  );
}

function useRowKeys(count: number) {
  const instance = useId();
  const next = useRef(0);
  const keys = useRef<string[]>([]);
  while (keys.current.length < count)
    keys.current.push(`${instance}-${++next.current}`);
  keys.current.length = count;
  return keys.current;
}
