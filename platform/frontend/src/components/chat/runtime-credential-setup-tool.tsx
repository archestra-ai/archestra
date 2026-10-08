"use client";

import { GithubIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { OpenAppaGithubAppRequirements } from "@/components/openappa-github-app-requirements";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES } from "@/lib/openappa-github-credential";
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
      <InlineNotice variant="neutral" className="my-2 w-full max-w-2xl">
        <GithubIcon aria-hidden />
        <span className="font-medium">GitHub sync</span>
        <InlineNoticeText className="flex-1">
          Install an App on the future repository owner with Administration,
          Contents, and Pull requests Read &amp; write.
        </InlineNoticeText>
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          onClick={() => setStep("define")}
        >
          <span>Connect GitHub App</span>
        </Button>
      </InlineNotice>
      {step === "define" && (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="github_app"
          initialScope="organization"
          initialValues={OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES}
          setupNotice={<OpenAppaGithubAppRequirements />}
          hideProvidedBy
          size="medium"
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
