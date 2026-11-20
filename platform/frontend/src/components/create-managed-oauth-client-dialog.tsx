"use client";
import type { archestraApiTypes } from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { WizardSteps } from "@/components/credential-billing/wizard-steps";
import { FormDialog } from "@/components/form-dialog";
import { OAuthClientBasicsFields } from "@/components/oauth-client/basics-fields";
import {
  newOauthClientFormValues,
  OAuthClientAccessFields,
  OAuthClientAdvancedFields,
  type OAuthClientFormValues,
  oauthClientFormReady,
  resolveOauthClientFormBody,
  useOauthClientScopeChange,
} from "@/components/oauth-client/configuration-fields";
import { OAuthClientReview } from "@/components/oauth-client/review";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";

const steps = [
  { id: "client", title: "Client" },
  { id: "access", title: "Access" },
  { id: "review", title: "Review" },
];
export function CreateManagedOAuthClientDialog({
  open,
  onOpenChange,
  gateways: providedGateways,
  providerApiKeys,
  onSubmit,
  isSubmitting,
  defaultClientType = "mcp",
  defaultAllowedGatewayIds,
  defaultProviderApiKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateways?: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    body: archestraApiTypes.CreateOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
  defaultClientType?: "mcp" | "llm";
  defaultAllowedGatewayIds?: string[];
  /** Provider keys an LLM client starts mapped to, e.g. a model pool's. */
  defaultProviderApiKeys?: ProviderApiKeyMappings;
}) {
  const form = useForm<OAuthClientFormValues>({
    defaultValues: newOauthClientFormValues(),
  });
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const defaultTargetIds = defaultAllowedGatewayIds?.join(",") ?? "";
  // Read when the dialog opens, like the gateways: a new array on re-render
  // must not reset the form.
  const defaultProviderApiKeysRef = useRef(defaultProviderApiKeys);
  defaultProviderApiKeysRef.current = defaultProviderApiKeys;
  const [step, setStep] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const values = form.watch();
  const selectedTargets = useAgentOptionsByIds({
    ids: (values.allowedGatewayIds ?? []).slice(0, 20),
    enabled: providedGateways === undefined && open,
  });
  const gateways = providedGateways ?? selectedTargets.data ?? [];
  const scopeChange = useOauthClientScopeChange(form, providedGateways);
  useEffect(() => {
    if (open) {
      setStep(0);
      setAdvancedOpen(false);
      form.reset(
        newOauthClientFormValues({
          clientType: defaultClientType,
          allowedGatewayIds: defaultTargetIds
            ? defaultTargetIds.split(",")
            : [],
          providerApiKeys: defaultProviderApiKeysRef.current,
        }),
      );
    }
  }, [open, form, defaultClientType, defaultTargetIds]);
  const ready = oauthClientFormReady(values) && !scopeChange.isPending;
  const hasAdvanced =
    values.grantType === "client_credentials" ||
    values.scopes.includes("llm:proxy");
  const editAdvanced = () => {
    setStep(1);
    setAdvancedOpen(true);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New OAuth client"
      description="One credential set for the APIs your application needs."
      size="small"
      className="sm:max-w-[720px]"
      isDirty={form.formState.isDirty}
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={form.handleSubmit(async () => {
          const labels = labelsRef.current?.saveUnsavedLabel() ?? values.labels;
          if (step < 2) {
            setStep(step + 1);
            return;
          }
          if (ready)
            await onSubmit(
              await resolveOauthClientFormBody(
                { ...values, labels },
                providedGateways,
              ),
            );
        })}
      >
        <DialogBody className="space-y-5 pb-0">
          <WizardSteps
            steps={steps}
            activeStep={steps[step].id}
            onStepClick={(id) =>
              setStep(steps.findIndex((item) => item.id === id))
            }
            canVisitStep={(id) =>
              steps.findIndex((item) => item.id === id) <= step
            }
          />
          {step === 0 && (
            <OAuthClientBasicsFields form={form} scopeChange={scopeChange} />
          )}
          {step === 1 && (
            <>
              <OAuthClientAccessFields
                form={form}
                gateways={gateways}
                remoteGateways={providedGateways === undefined}
                providerApiKeys={providerApiKeys}
                showServiceAccount={false}
                providerAccessSurface="create"
              />
              {hasAdvanced && (
                <Accordion
                  type="single"
                  collapsible
                  value={advancedOpen ? "advanced" : ""}
                  onValueChange={(value) =>
                    setAdvancedOpen(value === "advanced")
                  }
                  className="border-t"
                >
                  <AccordionItem value="advanced">
                    <AccordionTrigger>Advanced</AccordionTrigger>
                    <AccordionContent>
                      <OAuthClientAdvancedFields
                        form={form}
                        labelsRef={labelsRef}
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}
            </>
          )}
          {step === 2 && (
            <OAuthClientReview
              values={values}
              gateways={gateways}
              providerApiKeys={providerApiKeys}
              onEdit={(target, advanced) =>
                target === "details"
                  ? setStep(0)
                  : advanced
                    ? editAdvanced()
                    : setStep(1)
              }
            />
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {step > 0 && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => setStep(step - 1)}
            >
              <span>Back</span>
            </Button>
          )}
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={
              isSubmitting ||
              form.formState.isSubmitting ||
              scopeChange.isPending ||
              (step === 0
                ? !values.name.trim() || !values.scopes.length
                : !ready)
            }
          >
            <span>{step === 2 ? "Create client" : "Continue"}</span>
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}
