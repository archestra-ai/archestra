"use client";

import { useCallback, useEffect, useState } from "react";
import { type GetChatsResponse, getChats } from "shared/api-client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Chat = GetChatsResponse[number];

export default function HistoryPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchChats = useCallback(async () => {
    try {
      const { data } = await getChats();
      setChats(data || []);
    } catch (error) {
      console.error("Failed to fetch chats:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChats();
  }, [fetchChats]);

  // biome-ignore lint/suspicious/noExplicitAny: this can legitimately be anything..
  const formatContent = (content: any): string => {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "image_url") return "[Image]";
          if (part.type === "input_audio") return "[Audio]";
          if (part.type === "file")
            return `[File: ${part.file?.filename || "unknown"}]`;
          return "";
        })
        .join(" ");
    }
    return "";
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case "user":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
      case "assistant":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "tool":
        return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200";
      case "system":
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        Loading...
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <h1 className="text-3xl font-bold mb-6">Chat History</h1>

      {chats.length === 0 ? (
        <p className="text-muted-foreground">No chats found</p>
      ) : (
        <div className="space-y-6">
          {chats.map((chat) => {
            const taintedCount = chat.interactions.filter(
              (i) => i.tainted,
            ).length;

            return (
              <Card key={chat.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">Chat {chat.id}</CardTitle>
                      <div className="text-sm text-muted-foreground mt-1">
                        <p>Agent: {chat.agentId}</p>
                        <p>
                          Created: {new Date(chat.createdAt).toLocaleString()}
                        </p>
                        <p>
                          {chat.interactions.length} interaction
                          {chat.interactions.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    {taintedCount > 0 && (
                      <Badge variant="destructive">
                        {taintedCount} Tainted
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {chat.interactions.map((interaction) => (
                      <div
                        key={interaction.id}
                        className={`p-3 rounded border ${
                          interaction.tainted
                            ? "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950"
                            : "border-gray-200 dark:border-gray-800"
                        }`}
                      >
                        <div className="flex items-start gap-2 mb-2">
                          <Badge
                            className={getRoleBadgeColor(
                              interaction.content.role,
                            )}
                          >
                            {interaction.content.role}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(interaction.createdAt).toLocaleString()}
                          </span>
                          {interaction.tainted && (
                            <Badge variant="destructive" className="text-xs">
                              Tainted
                            </Badge>
                          )}
                        </div>

                        {interaction.content.role === "assistant" &&
                          interaction.content.tool_calls && (
                            <div className="mb-2 text-sm">
                              <p className="font-semibold">Tool Calls:</p>
                              <div className="space-y-1 mt-1">
                                {interaction.content.tool_calls.map((tc) => (
                                  <div
                                    key={tc.id}
                                    className="bg-muted p-2 rounded font-mono text-xs"
                                  >
                                    {tc.type === "function" && (
                                      <>
                                        <span className="font-semibold">
                                          {tc.function.name}
                                        </span>
                                        (
                                        {tc.function.arguments.substring(
                                          0,
                                          100,
                                        )}
                                        {tc.function.arguments.length > 100
                                          ? "..."
                                          : ""}
                                        )
                                      </>
                                    )}
                                    {tc.type === "custom" && (
                                      <span className="font-semibold">
                                        [Custom] {tc.custom.name}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                        <div className="text-sm">
                          {formatContent(interaction.content.content)}
                        </div>

                        {interaction.tainted && interaction.taintReason && (
                          <div className="mt-2 text-xs text-red-700 dark:text-red-400 italic">
                            Taint reason: {interaction.taintReason}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
