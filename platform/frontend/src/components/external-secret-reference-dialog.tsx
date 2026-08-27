"use client";

import { parseVaultReference } from "@archestra/shared";
import { Key, Loader2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";

const ExternalSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/external-secret-selector.ee"),
);

export function ExternalSecretReferenceDialog({
  fieldLabel,
  initialValue,
  description = "Select a secret from your team's external Vault.",
  onClose,
  onConfirm,
}: {
  fieldLabel: string;
  initialValue?: string;
  description?: string;
  onClose: () => void;
  onConfirm: (reference: string) => void;
}) {
  const parsed = initialValue ? parseVaultReference(initialValue) : null;
  const [teamId, setTeamId] = useState<string | null>(null);
  const [secretPath, setSecretPath] = useState<string | null>(
    parsed?.path ?? null,
  );
  const [secretKey, setSecretKey] = useState<string | null>(
    parsed?.key ?? null,
  );

  return (
    <StandardDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      title={
        <span className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          Set external secret
          <span className="font-mono text-muted-foreground">{fieldLabel}</span>
        </span>
      }
      description={description}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (secretPath && secretKey) {
                onConfirm(`${secretPath}#${secretKey}`);
              }
            }}
            disabled={!secretPath || !secretKey}
          >
            Confirm
          </Button>
        </>
      }
    >
      <Suspense
        fallback={
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading...
          </div>
        }
      >
        <ExternalSecretSelector
          selectedTeamId={teamId}
          selectedSecretPath={secretPath}
          selectedSecretKey={secretKey}
          onTeamChange={setTeamId}
          onSecretChange={setSecretPath}
          onSecretKeyChange={setSecretKey}
        />
      </Suspense>
    </StandardDialog>
  );
}
