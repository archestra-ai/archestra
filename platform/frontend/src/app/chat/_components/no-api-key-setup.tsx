import { E2eTestId } from "@shared";
import { Plus } from "lucide-react";
import { useRouter } from "next/dist/client/components/navigation";
import { useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { Button } from "@/components/ui/button";

const DEFAULT_FORM_VALUES: LlmProviderApiKeyFormValues = {
  name: "",
  provider: "anthropic",
  apiKey: null,
  baseUrl: null,
  scope: "personal",
  teamId: null,
  vaultSecretPath: null,
  vaultSecretKey: null,
  isPrimary: true,
};

// =========================================================================
// No API Key Setup — shown when user has no API keys configured
// =========================================================================

export function NoApiKeySetup() {
  const router = useRouter();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="text-center space-y-4">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Add an LLM Provider Key</h2>
          <p className="text-sm text-muted-foreground">
            Connect an LLM provider to start chatting
          </p>
        </div>
        <Button
          data-testid={E2eTestId.QuickstartAddApiKeyButton}
          onClick={() => setIsDialogOpen(true)}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add API Key
        </Button>
      </div>
      <CreateLlmProviderApiKeyDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        title="Add API Key"
        description="Add an LLM provider API key to start chatting"
        defaultValues={DEFAULT_FORM_VALUES}
        showConsoleLink
        onSuccess={() => {
          // Navigate to clean /chat URL so there's no stale conversation param
          router.push("/chat");
        }}
      />
    </div>
  );
}
