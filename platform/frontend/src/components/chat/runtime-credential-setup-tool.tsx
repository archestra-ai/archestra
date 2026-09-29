"use client";

import { useEffect, useState } from "react";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { Button } from "@/components/ui/button";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";

/** The same credential forms used in Settings, mounted in the chat tool result. */
export function RuntimeCredentialSetupTool({
  ready,
  toolCallId,
  onSendMessage,
}: {
  ready: boolean;
  toolCallId: string;
  onSendMessage?: (text: string) => void;
}) {
  const [step, setStep] = useState<"closed" | "define" | "connect">("closed");
  const [newId, setNewId] = useState<string | null>(null);
  const credentials = useRuntimeCredentials(ready);
  const definition = credentials.data?.find((item) => item.id === newId);

  useEffect(() => {
    if (!ready) return;
    const key = `runtime-credential-setup:${toolCallId}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "shown");
    setStep("define");
  }, [ready, toolCallId]);

  return (
    <>
      <div className="flex items-center gap-3 py-2">
        <span className="text-sm">
          Set up an organization GitHub App credential.
        </span>
        <Button size="sm" variant="outline" onClick={() => setStep("define")}>
          <span>Set up credential</span>
        </Button>
      </div>
      {step === "define" && (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="github_app"
          initialScope="organization"
          onClose={() => setStep("closed")}
          onCreated={(id) => {
            setNewId(id);
            setStep("connect");
          }}
        />
      )}
      {step === "connect" && definition && (
        <RuntimeCredentialConnectionDialog
          definition={definition}
          scope="organization"
          onClose={() => setStep("closed")}
          onConnected={() =>
            onSendMessage?.(
              `I connected the organization GitHub App credential ${definition.name}. Please continue setting up OpenAPPA GitHub sync.`,
            )
          }
        />
      )}
    </>
  );
}
