"use client";

import { BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS } from "@archestra/shared";
import { Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SystemPromptEditor } from "@/components/system-prompt-editor";
import { Button } from "@/components/ui/button";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { useUpdateProfile } from "@/lib/agent.query";

export function AgentSystemPromptCard({
  agent,
  readOnly,
  builtInAgentName,
}: {
  agent: { id: string; systemPrompt?: string | null };
  readOnly: boolean;
  builtInAgentName?: keyof typeof BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS;
}) {
  const router = useRouter();
  const savedPrompt = agent.systemPrompt ?? "";
  const [systemPrompt, setSystemPrompt] = useState(savedPrompt);
  const previousSavedPromptRef = useRef(savedPrompt);
  const pendingHrefRef = useRef<string | null>(null);
  const updateAgent = useUpdateProfile({
    successMessage: "System prompt saved",
  });
  const isDirty = systemPrompt.trim() !== savedPrompt.trim();
  const defaultSystemPrompt = builtInAgentName
    ? (BUILT_IN_AGENT_DEFAULT_SYSTEM_PROMPTS[builtInAgentName] ?? "")
    : undefined;

  useBeforeUnloadWhileDirty(isDirty);

  useEffect(() => {
    const previousSavedPrompt = previousSavedPromptRef.current;
    previousSavedPromptRef.current = savedPrompt;
    setSystemPrompt((currentPrompt) =>
      currentPrompt.trim() === previousSavedPrompt.trim()
        ? savedPrompt
        : currentPrompt,
    );
  }, [savedPrompt]);

  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) router.push(href);
    },
  });

  useEffect(() => {
    if (!isDirty) return;

    const guardNavigation = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      const anchor =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download")
      ) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search &&
        url.hash
      ) {
        return;
      }

      event.preventDefault();
      pendingHrefRef.current = `${url.pathname}${url.search}${url.hash}`;
      guard.requestClose();
    };

    document.addEventListener("click", guardNavigation, true);
    return () => document.removeEventListener("click", guardNavigation, true);
  }, [guard.requestClose, isDirty]);

  return (
    <>
      <form
        aria-label="System prompt"
        className="space-y-4 rounded-lg border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isDirty || readOnly || updateAgent.isPending) return;
          updateAgent.mutate({
            id: agent.id,
            data: { systemPrompt: systemPrompt.trim() || null },
          });
        }}
      >
        <SystemPromptEditor
          title="System prompt"
          value={systemPrompt}
          onChange={setSystemPrompt}
          readOnly={readOnly}
          variant="detail-card"
          builtInAgentId={builtInAgentName}
          headerExtra={
            !readOnly && builtInAgentName ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={systemPrompt === defaultSystemPrompt}
                onClick={() => setSystemPrompt(defaultSystemPrompt ?? "")}
              >
                <RotateCcw className="size-4" />
                <span>Reset to Default</span>
              </Button>
            ) : undefined
          }
        />
        {!readOnly && (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!isDirty || updateAgent.isPending}
              onClick={() => setSystemPrompt(savedPrompt)}
            >
              Discard changes
            </Button>
            <Button type="submit" disabled={!isDirty || updateAgent.isPending}>
              {updateAgent.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <span>Save system prompt</span>
              )}
            </Button>
          </div>
        )}
      </form>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />
    </>
  );
}
