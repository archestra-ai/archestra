"use client";

import ChatBotDemo from "../../../components/chatbot-demo";
import { useMockedMessages } from "../_parts/chatbot-demo.hooks";

export default function MitigatedPage() {
  const { messages, reload, isEnded } = useMockedMessages({
    isMitigated: true,
  });
  return <ChatBotDemo messages={messages} reload={reload} isEnded={isEnded} />;
}
