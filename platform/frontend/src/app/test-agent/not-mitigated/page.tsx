"use client";

import ChatBotDemo from "../../../components/chatbot-demo";
import { useMockedMessages } from "../_parts/chatbot-demo.hooks";

export default function NotMitigatedPage() {
  const { messages, reload, isEnded } = useMockedMessages({
    isMitigated: false,
  });
  return <ChatBotDemo messages={messages} reload={reload} isEnded={isEnded} />;
}
