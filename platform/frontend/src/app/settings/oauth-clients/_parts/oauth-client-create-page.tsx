"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import type { ProfileLabelsRef } from "@/components/agent-labels";
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
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { PageBackLink } from "@/components/page-back-link";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useCreateOauthClient } from "@/lib/oauth-clients.query";

type StepId = "details" | "access" | "review";
const steps = [
  { id: "details" as const, title: "Details" },
  { id: "access" as const, title: "Access" },
  { id: "review" as const, title: "Review" },
];

const LIST_HREF = "/settings/oauth-clients";

/**
 * Creating an OAuth client, as a page: what it is and how it signs in, what
 * it may reach, then a review. The secret is shown once, on creation; the
 * client's page then holds everything else, including the federated
 * credentials a client that signs in as itself can use instead of it.
 */
export function OAuthClientCreatePage() {
  const router = useRouter();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const create = useCreateOauthClient();
  const [step, setStep] = useState<StepId>("details");
  const [created, setCreated] = useState<{
    id: string;
    credentials: CreatedCredentials;
  } | null>(null);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const form = useForm<OAuthClientFormValues>({
    defaultValues: newOauthClientFormValues(),
  });
  const values = useWatch({
    control: form.control,
    compute: (current) => current,
  }) as OAuthClientFormValues;
  const selectedTargets = useAgentOptionsByIds({
    ids: (values.allowedGatewayIds ?? []).slice(0, 20),
  });
  const gateways = selectedTargets.data ?? [];
  const scopeChange = useOauthClientScopeChange(form);

  useEffect(() => {
    setPageHeader({
      title: "New OAuth client",
      documentTitle: "New OAuth client",
      description: "One credential set for the APIs your application needs.",
      backLink: (
        <PageBackLink href={LIST_HREF}>Back to OAuth clients</PageBackLink>
      ),
    });
    return () => setPageHeader(null);
  }, [setPageHeader]);

  const detailsReady = !!values.name.trim() && values.scopes.length > 0;
  const ready =
    oauthClientFormReady(values) && !scopeChange.isPending && !create.isPending;
  // A later step opens only once the steps before it are filled in.
  const canVisit = (id: StepId) =>
    id === "details" || (detailsReady && (id === "access" || ready));

  useEffect(() => {
    const visitable = (id: StepId) =>
      id === "details" || (detailsReady && (id === "access" || ready));
    setActionButton(
      <WizardStepper
        variant="progress"
        steps={steps}
        activeStep={step}
        onStepClick={(id) => {
          if (visitable(id)) setStep(id);
        }}
      />,
    );
    return () => setActionButton(null);
  }, [setActionButton, step, detailsReady, ready]);

  const index = steps.findIndex((entry) => entry.id === step);
  const prev = steps[index - 1];
  const next = steps[index + 1];

  const submit = form.handleSubmit(async () => {
    const labels = labelsRef.current?.saveUnsavedLabel() ?? values.labels;
    const client = await create
      .mutateAsync(await resolveOauthClientFormBody({ ...values, labels }))
      // Errors were toasted; stay on the review to fix them.
      .catch(() => null);
    if (!client) return;
    // The saved values are the baseline, so nothing asks before leaving.
    form.reset({ ...values, labels });
    setCreated({
      id: client.id,
      credentials: { ...client, oauthScope: client.scopes.join(" ") },
    });
  });

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        {step === "details" && (
          <SettingsSectionGroup>
            <SettingsSection
              title="Details"
              description="Name the application, pick the APIs it reaches, and say whether it acts as itself or for signed-in users. How it signs in cannot change later."
            >
              <OAuthClientBasicsFields form={form} scopeChange={scopeChange} />
            </SettingsSection>
          </SettingsSectionGroup>
        )}
        {step === "access" && (
          <SettingsSectionGroup>
            <SettingsSection
              title="Access"
              description="What the client's tokens can reach."
            >
              <OAuthClientAccessFields
                form={form}
                gateways={gateways}
                remoteGateways
                providerApiKeys={providerApiKeys}
                showServiceAccount={false}
                providerAccessSurface="create"
              />
            </SettingsSection>
            <SettingsSection
              title="Identity, budget and labels"
              description="Optional. The service account whose permissions the client uses, what its LLM spend is charged to, and labels for filtering."
            >
              <OAuthClientAdvancedFields form={form} labelsRef={labelsRef} />
            </SettingsSection>
          </SettingsSectionGroup>
        )}
        {step === "review" && (
          <SettingsSectionGroup>
            <SettingsSection
              title="Review"
              description="Check every choice before creating the client. Its secret is shown once, next."
            >
              <OAuthClientReview
                values={values}
                gateways={gateways}
                providerApiKeys={providerApiKeys}
                onEdit={(target) => setStep(target)}
              />
            </SettingsSection>
          </SettingsSectionGroup>
        )}
        <WizardFooter>
          <div className="flex min-w-0 items-center gap-3">
            {prev && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setStep(prev.id)}
              >
                <ArrowLeft className="size-4" />
                <span>{prev.title}</span>
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => router.push(LIST_HREF)}
            >
              Cancel
            </Button>
            {next ? (
              <Button
                size="sm"
                type="button"
                disabled={!canVisit(next.id)}
                onClick={() => setStep(next.id)}
              >
                <span>{next.title}</span>
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button size="sm" type="submit" disabled={!ready}>
                <span>
                  {create.isPending ? "Creating..." : "Create OAuth client"}
                </span>
              </Button>
            )}
          </div>
        </WizardFooter>
      </form>
      <OAuthClientCreatedDialog
        open={!!created}
        onOpenChange={(open) => {
          if (!open && created)
            router.push(`/settings/oauth-clients/${created.id}`);
        }}
        title="OAuth Client Created"
        credentials={created?.credentials ?? null}
      />
    </Form>
  );
}
