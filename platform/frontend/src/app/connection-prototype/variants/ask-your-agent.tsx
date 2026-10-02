"use client";

import { Bot, User } from "lucide-react";
import { getClient, ProtoPage } from "../_parts/proto-ui";
import type { PrototypeVariantProps } from "../variants";

// Avenue J (stretch): the connected agent explains its own connection. This
// variant is a mock transcript, to judge whether the idea is worth building.
export default function AskYourAgentVariant({
  scenario,
}: PrototypeVariantProps) {
  const client = getClient("claude-code");
  const servers = scenario.servers.slice(0, 3).map((server) => server.name);
  const messages = [
    { from: "user", text: "What can you do with Archestra?" },
    {
      from: "agent",
      text: `I'm connected to ${servers.join(", ") || "no integrations yet"} and know ${scenario.skills.length} team skills. Try: “${scenario.servers[0]?.exampleAsk ?? "list what you can access"}”.`,
    },
    { from: "user", text: "How do I disconnect you?" },
    {
      from: "agent",
      text: "Open My connections in Archestra and press Disconnect, or tell me “disconnect Archestra” and I'll remove the entry from my config.",
    },
  ];

  return (
    <ProtoPage
      title="Ask your agent"
      subtitle={`After connecting, ${client.label} can answer questions about its own connection.`}
    >
      <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4 font-mono text-sm">
        {messages.map((message) => (
          <div key={message.text} className="flex gap-3">
            {message.from === "user" ? (
              <User className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
            )}
            <span>{message.text}</span>
          </div>
        ))}
      </div>
    </ProtoPage>
  );
}
