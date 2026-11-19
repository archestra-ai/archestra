// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { PageBackLink } from "@/components/page-back-link";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useCreateRole, useRoles } from "@/lib/role.query";
import { allPermissionRows, countGranted } from "./permission-list-model.ee";
import {
  type RoleFormValues,
  RoleIdentitySection,
  RolePermissionsSection,
} from "./role-form.ee";
import { BLANK_START, RoleStartFrom } from "./role-start-from.ee";

type StepId = "details" | "permissions";
const steps = [
  { id: "details" as const, title: "Details" },
  { id: "permissions" as const, title: "Permissions" },
];

/**
 * Two steps: the name, description and which role to start from, then the
 * permissions. `?from=<role id>` preselects the role to copy, which is how a
 * role's page offers "New role from this one".
 */
export function RoleCreatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const { data: grantable } = useAllPermissions();
  const { data: roles } = useRoles();
  const createMutation = useCreateRole();
  const [step, setStep] = useState<StepId>("details");
  const [from, setFrom] = useState(searchParams.get("from") ?? BLANK_START);
  const form = useForm<RoleFormValues>({
    defaultValues: { name: "", description: "", permission: {} },
  });
  const permission = form.watch("permission");
  const name = form.watch("name");
  const selected = countGranted(permission, allPermissionRows);

  // A deep-linked `?from=` lands before the roles have loaded; copy its
  // permissions once they have, unless the author already picked something.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !roles) return;
    setSeeded(true);
    const role = roles.find((entry) => entry.id === from);
    if (role) form.setValue("permission", role.permission);
    else setFrom(BLANK_START);
  }, [seeded, roles, from, form]);

  useEffect(() => {
    setPageHeader({
      title: "New role",
      documentTitle: "New role",
      backLink: (
        <PageBackLink href="/settings/roles">Back to roles</PageBackLink>
      ),
    });
    return () => setPageHeader(null);
  }, [setPageHeader]);

  useEffect(() => {
    setActionButton(
      <WizardStepper
        variant="progress"
        steps={steps}
        activeStep={step}
        onStepClick={setStep}
      />,
    );
    return () => setActionButton(null);
  }, [setActionButton, step]);

  const index = steps.findIndex((entry) => entry.id === step);
  const prev = steps[index - 1];
  const next = steps[index + 1];

  const submit = form.handleSubmit((values) => {
    createMutation.mutate(
      {
        name: values.name.trim(),
        description: values.description.trim() || undefined,
        permission: values.permission,
      } as Parameters<typeof createMutation.mutate>[0],
      {
        onSuccess: (created) => {
          router.push(
            created ? `/settings/roles/${created.id}` : "/settings/roles",
          );
        },
      },
    );
  });

  const onStartFromChange = (value: string) => {
    setFrom(value);
    form.setValue(
      "permission",
      roles?.find((role) => role.id === value)?.permission ?? {},
    );
  };

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        {step === "details" && (
          <SettingsSectionGroup>
            <RoleIdentitySection form={form} />
            <SettingsSection
              title="Start from"
              description="Copy another role's permissions as the starting point. You change them on the next step."
            >
              <RoleStartFrom
                roles={roles ?? []}
                value={from}
                onChange={onStartFromChange}
              />
            </SettingsSection>
          </SettingsSectionGroup>
        )}
        {step === "permissions" && (
          <SettingsSectionGroup>
            <RolePermissionsSection form={form} grantable={grantable ?? {}} />
          </SettingsSectionGroup>
        )}
        <WizardFooter>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            {prev && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => setStep(prev.id)}
              >
                <ArrowLeft className="h-4 w-4" />
                <span>{prev.title}</span>
              </Button>
            )}
            <span className="order-first text-center text-xs text-muted-foreground sm:order-none sm:text-left">
              {selected} permissions selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => router.push("/settings/roles")}
            >
              Cancel
            </Button>
            {next ? (
              <Button
                size="sm"
                type="button"
                onClick={async () => {
                  if (await form.trigger("name")) setStep(next.id);
                }}
              >
                <span>{next.title}</span>
                <ArrowRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="sm"
                type="submit"
                disabled={
                  !name.trim() || selected === 0 || createMutation.isPending
                }
              >
                <span>
                  {createMutation.isPending ? "Creating..." : "Create role"}
                </span>
              </Button>
            )}
          </div>
        </WizardFooter>
      </form>
    </Form>
  );
}
