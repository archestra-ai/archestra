"use client";

import { EmojiPicker } from "@ferrucc-io/emoji-picker";

interface AgentEmojiPickerProps {
  onEmojiSelect: (emoji: string) => void;
}

export function AgentEmojiPicker({ onEmojiSelect }: AgentEmojiPickerProps) {
  return (
    <EmojiPicker
      className="w-full max-w-full overflow-hidden rounded-none border-0"
      onEmojiSelect={onEmojiSelect}
      emojisPerRow={8}
      emojiSize={32}
    >
      <EmojiPicker.Header className="p-2">
        <EmojiPicker.Input placeholder="Search emoji..." className="mb-0" />
      </EmojiPicker.Header>
      <EmojiPicker.Group>
        <EmojiPicker.List hideStickyHeader containerHeight={280} />
      </EmojiPicker.Group>
    </EmojiPicker>
  );
}
