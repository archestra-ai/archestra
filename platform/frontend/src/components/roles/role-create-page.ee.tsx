// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type archestraApiTypes,
  type PredefinedRoleName,
  roleDescriptions,
} from "@archestra/shared";
import { ArrowLeft, ArrowRight, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { PageBackLink } from "@/components/page-back-link";
import { RoleTypeIcon } from "@/components/roles/role-type-icon";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/components/settings/settings-layout.context";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { WizardFooter } from "@/components/wizard/wizard-footer";
import { WizardStepper } from "@/components/wizard/wizard-stepper";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useCreateRole, useRoles } from "@/lib/role.query";
import { cn } from "@/lib/utils/tailwind";
import { allPermissionRows, countGranted } from "./permission-list-model.ee";
import {
  type RoleFormValues,
  RoleIdentitySection,
  RolePermissionsSection,
} from "./role-form.ee";

type Role = archestraApiTypes.GetRolesResponses["200"]["data"][number];

type StepId = "details" | "permissions";
const steps = [
  { id: "details" as const, title: "Details" },
  { id: "permissions" as const, title: "Permissions" },
];

/** No role to copy: the new role starts with nothing granted. */
const BLANK = "blank";

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
  const [from, setFrom] = useState(searchParams.get("from") ?? BLANK);
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
    else setFrom(BLANK);
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
              <StartFrom
                roles={roles ?? []}
                value={from}
                onChange={(value) => {
                  setFrom(value);
                  form.setValue(
                    "permission",
                    roles?.find((role) => role.id === value)?.permission ?? {},
                  );
                }}
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

/**
 * Blank and the first roles as cards, built-in ones first. Past five roles
 * the rest wait behind a "+N more" card, so an organization with dozens of
 * custom roles still sees its built-in ones at a glance.
 */
function StartFrom({
  roles,
  value,
  onChange,
}: {
  roles: Role[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const options = [...roles]
    .sort((a, b) => Number(b.predefined) - Number(a.predefined))
    .map((role) => ({
      id: role.id,
      name: role.name,
      description:
        role.description ||
        (role.predefined
          ? roleDescriptions[role.name as PredefinedRoleName]
          : ""),
      predefined: role.predefined as boolean | null,
      count: countGranted(role.permission, allPermissionRows),
    }));
  // The chosen role always shows, so a deep link to the twentieth custom role
  // does not land on a grid that hides its own selection.
  const chosen = options.findIndex((option) => option.id === value);
  const shown =
    showAll || options.length <= VISIBLE_ROLES
      ? options
      : options.filter(
          (_, index) => index < VISIBLE_ROLES - 1 || index === chosen,
        );
  const hidden = options.length - shown.length;
  return (
    <RadioGroup
      value={value}
      onValueChange={onChange}
      aria-label="Start from"
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
    >
      <StartCard
        option={{
          id: BLANK,
          name: "Blank",
          description: "No permissions. Pick each one yourself.",
          predefined: null,
          count: null,
        }}
        selected={value === BLANK}
      />
      {shown.map((option) => (
        <StartCard
          key={option.id}
          option={option}
          selected={value === option.id}
        />
      ))}
      {hidden > 0 && (
        <UnstyledButton
          type="button"
          onClick={() => setShowAll(true)}
          className="flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg border bg-muted/30 p-3 text-sm transition-colors hover:border-primary/40 hover:bg-muted/60"
        >
          <span className="flex size-7 items-center justify-center rounded-full border bg-background">
            <Plus className="size-3.5" />
          </span>
          <span className="font-medium">
            {hidden} more {hidden === 1 ? "role" : "roles"}
          </span>
          <span className="text-[11px] text-muted-foreground">Show all</span>
        </UnstyledButton>
      )}
    </RadioGroup>
  );
}

/** Blank, four roles and the "+N more" card fill two rows of three. */
const VISIBLE_ROLES = 5;

function StartCard({
  option,
  selected,
}: {
  option: {
    id: string;
    name: string;
    description: string;
    predefined: boolean | null;
    count: number | null;
  };
  selected: boolean;
}) {
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/40",
        selected && "border-primary/50 bg-primary/5",
      )}
    >
      <RadioGroupItem value={option.id} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col self-stretch">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {option.predefined !== null && (
            <RoleTypeIcon
              predefined={option.predefined}
              className="size-3.5"
              withTooltip
            />
          )}
          <span className="min-w-0 truncate capitalize">{option.name}</span>
        </span>
        {option.description && (
          <span className="block text-xs text-muted-foreground">
            {option.description}
          </span>
        )}
        {option.count !== null && (
          <span className="mt-auto block pt-2 text-[11px] text-muted-foreground/80 tabular-nums">
            {option.count} {option.count === 1 ? "permission" : "permissions"}
          </span>
        )}
      </span>
    </Label>
  );
}
