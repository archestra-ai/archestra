"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ArchestraPromptInput from "@/app/chat/prompt-input";
import { ApiKeyLoadError } from "@/components/api-key-load-error";
import { NoApiKeySetup } from "@/components/no-api-key-setup";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { useHasAnyApiKey } from "@/lib/llm-provider-api-keys.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

export function PolicyChatStarter() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const { hasAnyApiKey, isLoading, isLoadError, refetch } = useHasAnyApiKey();
  const models = useLlmModels({ enabled: hasAnyApiKey });
  useEffect(() => {
    if (selectedModel || !models.data?.length) return;
    setSelectedModel(
      models.data.find((model) => model.isBest)?.dbId ?? models.data[0].dbId,
    );
  }, [models.data, selectedModel]);
  const { data: canUpdate } = useHasPermissions({ toolPolicy: ["update"] });
  const sync = useAppaGithubSync();
  const usesGitHub = Boolean(sync.data?.source?.interval);
  const githubAppReady = Boolean(sync.data?.source?.githubAppConfigId);
  const submit = (request: string) => {
    if (request.trim().length < 8) {
      setError("Describe the change you want to make in a little more detail.");
      return;
    }
    setError(null);
    const prompt = [
      `Help me change the OpenAPPA policy: ${request.trim()}`,
      "Find the built-in OpenAPPA tools. Read the current policy, preserve unrelated rules and comments, preview and explain the diff, then publish the validated change.",
      "If GitHub sync is active, create a policy pull request and give me its link. Otherwise save a new local revision.",
    ].join("\n\n");
    const params = new URLSearchParams({ user_prompt: prompt });
    if (selectedModel) params.set("modelId", selectedModel);
    router.push(`/chat/new?${params.toString()}`);
  };

  return (
    <section aria-label="Change OpenAPPA policy with chat" className="pt-3">
      {(isLoading || isLoadError || hasAnyApiKey) && (
        <div className="mb-4">
          <h2 className="text-xl font-semibold tracking-tight">
            What should the policy do?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Describe a change. The agent will show you a diff before it{" "}
            {usesGitHub ? "opens a GitHub pull request" : "saves a revision"}.
          </p>
        </div>
      )}
      <div className="space-y-3">
        {usesGitHub && !githubAppReady && (
          <InlineNotice>
            <TriangleAlert />
            <span className="font-medium">GitHub App needed</span>
            <InlineNoticeText>
              Choose a GitHub App credential in OpenAPPA settings before the
              agent can open policy pull requests.
            </InlineNoticeText>
            <Button variant="outline" size="sm" className="ml-auto" asChild>
              <Link href="/settings/openappa">Open sync settings</Link>
            </Button>
          </InlineNotice>
        )}
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : isLoadError ? (
          <ApiKeyLoadError onRetry={refetch} />
        ) : !hasAnyApiKey ? (
          <NoApiKeySetup description="Connect an LLM provider to configure OpenAPPA with chat" />
        ) : models.isError ? (
          <QueryLoadError
            title="Could not load chat models"
            onRetry={() => models.refetch()}
          />
        ) : (
          <ArchestraPromptInput
            minimalMode
            placeholderOverride="Ask for a policy change…"
            agentId={null}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            status="ready"
            sendDisabled={
              !canUpdate ||
              !selectedModel ||
              models.isPending ||
              (usesGitHub && !githubAppReady)
            }
            onSubmit={({ text }) => submit(text)}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
