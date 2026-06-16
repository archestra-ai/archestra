"use client";

import type { SupportedProvider } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { GithubCopilotSignIn } from "@/components/github-copilot-sign-in";
import { Button } from "@/components/ui/button";
import { useCreateLlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";

interface ProviderAuthRequiredCardProps {
  provider: SupportedProvider;
  providerLabel: string;
  /**
   * Called once the user has connected their account (the personal key was
   * created). The chat uses this to auto-resend the original prompt so the user
   * doesn't have to retype it.
   */
  onConnected?: () => void;
}

/**
 * Rendered in the chat stream when the model needs a per-user credential the
 * acting user hasn't linked yet (ChatErrorCode.ProviderAuthRequired). Lets them
 * connect their own account inline — for GitHub Copilot via the device-flow
 * sign-in — instead of showing a generic key error.
 */
export function ProviderAuthRequiredCard({
  provider,
  providerLabel,
  onConnected,
}: ProviderAuthRequiredCardProps) {
  const createKey = useCreateLlmProviderApiKey();

  return (
    <div className="my-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="space-y-2">
          <div>
            <p className="font-medium text-sm">Connect {providerLabel}</p>
            <p className="text-xs text-muted-foreground">
              {providerLabel} is per-user — connect your own account to use this
              model, then send your message again.
            </p>
          </div>

          {provider === "github-copilot" ? (
            <GithubCopilotSignIn
              disabled={createKey.isPending}
              onToken={async (token) => {
                try {
                  await createKey.mutateAsync({
                    name: "GitHub Copilot",
                    provider: "github-copilot",
                    apiKey: token,
                    scope: "personal",
                  });
                  toast.success("GitHub Copilot connected — retrying…");
                  // Re-run the original prompt now that the key exists; the
                  // create mutation already invalidated the model/key caches.
                  onConnected?.();
                } catch {
                  // handleApiError already surfaced the failure (e.g. no seat)
                }
              }}
            />
          ) : (
            <Button asChild type="button" variant="outline" size="sm">
              <a href="/settings">Connect in Settings</a>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
