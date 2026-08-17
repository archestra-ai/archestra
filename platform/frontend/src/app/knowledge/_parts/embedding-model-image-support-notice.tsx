"use client";

import {
  DocsPage,
  getDocsUrl,
  type SupportedProvider,
} from "@archestra/shared";
import { Info, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ModelWithApiKeys } from "@/lib/llm-models.query";
import { cn } from "@/lib/utils";

const DISMISSED_MODEL_STORAGE_PREFIX =
  "knowledge-image-embedding-notice-dismissed-model";

export function EmbeddingModelImageSupportNotice({
  modelId,
  provider,
  dismissalScope,
  supportsImages,
  showSettingsLink = true,
  className,
}: {
  modelId: string;
  provider: SupportedProvider;
  dismissalScope: string;
  supportsImages: boolean | null;
  showSettingsLink?: boolean;
  className?: string;
}) {
  const modelKey = `${provider}/${modelId}`;
  const storageKey = `${DISMISSED_MODEL_STORAGE_PREFIX}:${dismissalScope}`;
  const dismissalId = `${storageKey}:${modelKey}`;
  const [dismissedId, setDismissedId] = useState(() =>
    readDismissedModelKey(storageKey) === modelKey ? dismissalId : null,
  );

  useEffect(() => {
    const storedModelKey = readDismissedModelKey(storageKey);
    if (storedModelKey && storedModelKey !== modelKey) {
      clearDismissedModelKey(storageKey);
      setDismissedId(null);
      return;
    }
    setDismissedId(storedModelKey === modelKey ? dismissalId : null);
  }, [dismissalId, modelKey, storageKey]);

  if (supportsImages !== false || dismissedId === dismissalId) return null;

  const handleDismiss = () => {
    writeDismissedModelKey(storageKey, modelKey);
    setDismissedId(dismissalId);
  };

  return (
    <div
      role="note"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground sm:flex-row sm:items-center",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">
            <code>{modelKey}</code>
          </span>{" "}
          handles text only. Choose a multimodal embedding model to sync
          supported image files.{" "}
          <a
            href={getDocsUrl(DocsPage.PlatformKnowledge, "image-embedding")}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
          >
            Learn more
          </a>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
        {showSettingsLink && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/knowledge#embedding-configuration">
              <Settings2 className="size-3.5" />
              <span>Embedding settings</span>
            </Link>
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          <span>Dismiss</span>
        </Button>
      </div>
    </div>
  );
}

export function embeddingModelSupportsImages(
  model: Pick<
    ModelWithApiKeys,
    "inputModalities" | "embeddingClientImageCapable"
  >,
): boolean {
  return (
    model.inputModalities?.includes("image") === true &&
    model.embeddingClientImageCapable !== false
  );
}

function readDismissedModelKey(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeDismissedModelKey(storageKey: string, modelKey: string) {
  try {
    localStorage.setItem(storageKey, modelKey);
  } catch {
    // Keep the in-memory dismissal when browser storage is unavailable.
  }
}

function clearDismissedModelKey(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // A blocked storage backend is already equivalent to no persisted dismissal.
  }
}
