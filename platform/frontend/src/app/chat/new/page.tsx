"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Chat New Page - Creates a conversation with an agent and sends initial message
 *
 * URL format: /chat/new?agent_id=<uuid>&user_prompt=<message>
 */
export default function ChatNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    const agentId = searchParams.get("agent_id");
    const userPrompt = searchParams.get("user_prompt");

    if (!agentId) {
      setError("Missing required parameter: agent_id");
      return;
    }

    if (!userPrompt) {
      setError("Missing required parameter: user_prompt");
      return;
    }

    async function createConversation() {
      setIsCreating(true);
      try {
        const response = await fetch(
          `/api/chat/agents/${agentId}/conversation`,
          {
            method: "GET",
            credentials: "include",
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.message || `Failed to create conversation: ${response.status}`,
          );
        }

        const conversation = await response.json();

        // Redirect with pending_message to trigger auto-send
        router.replace(
          `/chat?conversation=${conversation.id}&pending_message=${encodeURIComponent(userPrompt as string)}`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create conversation");
        setIsCreating(false);
      }
    }

    createConversation();
  }, [searchParams, router]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="max-w-md rounded-lg border border-destructive bg-destructive/10 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-destructive">Error</h2>
          <p className="text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => router.push("/chat")}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
          >
            Go to Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-muted-foreground">
        {isCreating ? "Creating conversation..." : "Loading..."}
      </p>
    </div>
  );
}
