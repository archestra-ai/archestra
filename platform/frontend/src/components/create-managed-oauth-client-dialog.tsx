"use client";
import type { archestraApiTypes } from "@archestra/shared";
import { Server, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import {
  BudgetFields,
  formatSpendCap,
  UsersPayNotice,
} from "@/components/credential-billing/budget-fields";
import {
  ReviewList,
  ReviewListRow,
} from "@/components/credential-billing/review-list";
import { WizardSteps } from "@/components/credential-billing/wizard-steps";
import { FormDialog } from "@/components/form-dialog";
import { ChoiceCards } from "@/components/oauth-client/choice-cards";
import {
  OAuthClientAccessFields,
  type OAuthClientFormValues,
  OAuthClientScopePicker,
  oauthCapabilities,
  oauthClientFormBody,
  oauthClientFormReady,
  setOauthClientScopes,
} from "@/components/oauth-client/configuration-fields";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useServiceAccounts } from "@/lib/service-account.query";
import { useTeams } from "@/lib/teams/team.query";

const steps = [
  { id: "client", title: "Client" },
  { id: "access", title: "Access" },
  { id: "review", title: "Review" },
];
export function CreateManagedOAuthClientDialog({
  open,
  onOpenChange,
  gateways,
  providerApiKeys,
  onSubmit,
  isSubmitting,
  defaultClientType = "mcp",
  defaultAllowedGatewayIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateways: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    body: archestraApiTypes.CreateOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
  defaultClientType?: "mcp" | "llm";
  defaultAllowedGatewayIds?: string[];
}) {
  const form = useForm<OAuthClientFormValues>({
    defaultValues: {
      name: "",
      serviceAccountId: null,
      grantType: "client_credentials",
      scopes: ["mcp", "a2a"],
      providerApiKeys: [],
      allowedGatewayIds: [],
      redirectUrisText: "",
      spendCap: null,
      billingTeamId: null,
      labels: [],
      initialGrants: [],
    },
  });
  const defaultTargetIds = defaultAllowedGatewayIds?.join(",") ?? "";
  const [step, setStep] = useState(0);
  const values = form.watch();
  useEffect(() => {
    if (open) {
      setStep(0);
      form.reset({
        name: "",
        serviceAccountId: null,
        grantType: "client_credentials",
        scopes: defaultClientType === "llm" ? ["llm:proxy"] : ["mcp", "a2a"],
        providerApiKeys: [],
        allowedGatewayIds: defaultTargetIds ? defaultTargetIds.split(",") : [],
        redirectUrisText: "",
        spendCap: null,
        billingTeamId: null,
        labels: [],
        initialGrants: [],
      });
    }
  }, [open, form, defaultClientType, defaultTargetIds]);
  const ready = oauthClientFormReady(values);
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
          if (step < 2) {
            setStep(step + 1);
            return;
          }
          if (ready) await onSubmit(oauthClientFormBody(values, gateways));
        })}
      >
        <DialogBody className="space-y-5">
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
            <>
              <div className="space-y-2">
                <Label htmlFor="oauth-client-name">Name</Label>
                <Input
                  id="oauth-client-name"
                  placeholder="support-assistant-prod"
                  {...form.register("name")}
                  autoFocus
                />
              </div>
              <OAuthClientScopePicker
                value={values.scopes}
                onChange={(scopes) =>
                  setOauthClientScopes(form, scopes, gateways)
                }
              />
              <ChoiceCards
                label="How does it sign in?"
                idPrefix="oauth-client-signin"
                value={values.grantType ?? "client_credentials"}
                onValueChange={(
                  value: "client_credentials" | "authorization_code",
                ) => form.setValue("grantType", value, { shouldDirty: true })}
                options={[
                  {
                    value: "client_credentials",
                    title: "As itself",
                    description: "A service or bot uses its own credentials.",
                    icon: <Server className="size-4" />,
                  },
                  {
                    value: "authorization_code",
                    title: "For its users",
                    description:
                      "An app signs users in and acts with their identity.",
                    icon: <Users className="size-4" />,
                  },
                ]}
              />
            </>
          )}
          {step === 1 && (
            <>
              <OAuthClientAccessFields
                form={form}
                gateways={gateways}
                providerApiKeys={providerApiKeys}
              />
              {values.scopes.includes("llm:proxy") && (
                <>
                  <div className="border-t pt-4">
                    <Label>Budget</Label>
                  </div>
                  {values.grantType === "authorization_code" && (
                    <UsersPayNotice />
                  )}
                  <BudgetFields
                    subject="client"
                    idPrefix="oauth-client-budget"
                    showBillingTeam={values.grantType !== "authorization_code"}
                    billingTeamId={values.billingTeamId ?? null}
                    onBillingTeamIdChange={(value) =>
                      form.setValue("billingTeamId", value, {
                        shouldDirty: true,
                      })
                    }
                    spendCap={values.spendCap ?? null}
                    onSpendCapChange={(value) =>
                      form.setValue("spendCap", value, { shouldDirty: true })
                    }
                  />
                </>
              )}
            </>
          )}
          {step === 2 && (
            <ReviewList>
              <ReviewListRow label="Name" onEdit={() => setStep(0)}>
                <span>{values.name}</span>
              </ReviewListRow>
              <ReviewListRow label="Capabilities" onEdit={() => setStep(0)}>
                <span>
                  {oauthCapabilities
                    .filter((item) => values.scopes.includes(item.scope))
                    .map((item) => item.label)
                    .join(", ")}
                </span>
              </ReviewListRow>
              <ReviewListRow label="Signs in" onEdit={() => setStep(0)}>
                <span>
                  {values.grantType === "authorization_code"
                    ? "For its users"
                    : "As itself"}
                </span>
              </ReviewListRow>
              {values.grantType === "client_credentials" && (
                <ReviewListRow
                  label="Service account"
                  onEdit={() => setStep(1)}
                >
                  <span>
                    {values.serviceAccountId ? (
                      <AccountName id={values.serviceAccountId} />
                    ) : (
                      <span>No service account</span>
                    )}
                  </span>
                </ReviewListRow>
              )}
              {values.grantType === "authorization_code" && (
                <ReviewListRow label="Redirect URIs" onEdit={() => setStep(1)}>
                  <span className="whitespace-pre-line break-all">
                    {values.redirectUrisText}
                  </span>
                </ReviewListRow>
              )}
              {values.scopes.includes("llm:proxy") && (
                <ReviewListRow label="Budget" onEdit={() => setStep(1)}>
                  <span>
                    {values.grantType === "authorization_code" ? (
                      <span>Each user pays</span>
                    ) : values.billingTeamId ? (
                      <BillingTeamName id={values.billingTeamId} />
                    ) : (
                      <span>No billing team</span>
                    )}
                    {" · "}
                    {values.spendCap
                      ? formatSpendCap(values.spendCap)
                      : "No spend cap"}
                  </span>
                </ReviewListRow>
              )}
              {values.allowedGatewayIds?.length ? (
                <ReviewListRow
                  label="Gateways & agents"
                  onEdit={() => setStep(1)}
                >
                  <span>
                    {values.allowedGatewayIds
                      .map(
                        (id) =>
                          gateways.find((item) => item.id === id)?.name ?? id,
                      )
                      .join(", ")}
                  </span>
                </ReviewListRow>
              ) : null}
              {values.scopes.includes("llm:proxy") &&
                values.grantType === "client_credentials" && (
                  <ReviewListRow
                    label="Provider keys"
                    onEdit={() => setStep(1)}
                  >
                    <span>
                      {values.providerApiKeys
                        ?.map(
                          (mapping) =>
                            providerApiKeys.find(
                              (key) => key.id === mapping.providerApiKeyId,
                            )?.name ?? mapping.provider,
                        )
                        .join(", ")}
                    </span>
                  </ReviewListRow>
                )}
            </ReviewList>
          )}
        </DialogBody>
        <DialogStickyFooter>
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

function AccountName({ id }: { id: string }) {
  const { data: accounts = [] } = useServiceAccounts();
  return (
    accounts.find((account) => account.id === id)?.name ??
    "Selected service account"
  );
}
function BillingTeamName({ id }: { id: string }) {
  const { data: teams = [] } = useTeams();
  return teams.find((team) => team.id === id)?.name ?? "Selected billing team";
}
