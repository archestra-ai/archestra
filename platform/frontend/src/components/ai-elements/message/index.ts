"use client";

import {
  MessageAvatar,
  type MessageAvatarProps,
  MessageContent,
  type MessageContentProps,
  Message as RootMessage,
  type MessageProps,
} from "./message";

export type { MessageAvatarProps, MessageContentProps, MessageProps };

export const Message = Object.assign(RootMessage, {
  Avatar: MessageAvatar,
  Content: MessageContent,
});
