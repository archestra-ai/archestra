import type { ChangeEvent, FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ChatInputProps {
  input: string;
  onInputChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  isLoading: boolean;
}

export function ChatInput({
  input,
  onInputChange,
  onSubmit,
  onStop,
  isLoading,
}: ChatInputProps) {
  return (
    <div className="border-t p-4">
      <form onSubmit={onSubmit} className="max-w-3xl mx-auto flex gap-2">
        <Input
          value={input}
          onChange={onInputChange}
          placeholder="Type a message..."
          disabled={isLoading}
          className="flex-1"
        />
        {isLoading ? (
          <Button type="button" onClick={onStop} variant="outline">
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()}>
            Send
          </Button>
        )}
      </form>
    </div>
  );
}
