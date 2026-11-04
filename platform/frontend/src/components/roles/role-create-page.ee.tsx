// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type archestraApiTypes,
  type PredefinedRoleName,
  roleDescriptions,
} from "@archestra/shared";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { PageBackLink } from "@/components/page-back-link";
import { RoleTypeIcon } from "@/components/role-type-icon";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
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
  const fromRole = roles?.find((role) => role.id === from);

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
              <p className="text-xs text-muted-foreground">
                {fromRole ? (
                  <span>
                    Starts with the {selected} permissions {fromRole.name} has
                    today. Changing this role later doesn't change{" "}
                    {fromRole.name}.
                  </span>
                ) : (
                  <span>
                    Starts with no permissions: people with this role can sign
                    in and nothing else until you add some.
                  </span>
                )}
              </p>
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
 * Every role as a card, built-in ones first, with a search above for an
 * organization that has grown a long list of custom roles.
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
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const options = [
    {
      id: BLANK,
      name: "Blank",
      description: "No permissions. Pick each one yourself.",
      predefined: null,
    },
    ...[...roles]
      .sort((a, b) => Number(b.predefined) - Number(a.predefined))
      .map((role) => ({
        id: role.id,
        name: role.name,
        description:
          role.description ||
          (role.predefined
            ? roleDescriptions[role.name as PredefinedRoleName]
            : ""),
        predefined: role.predefined,
      })),
  ].filter(
    (option) =>
      !needle ||
      `${option.name} ${option.description}`.toLowerCase().includes(needle),
  );
  return (
    <div className="space-y-2">
      <div className="relative sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search roles"
          placeholder="Search roles"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 pl-7.5 text-[13px]"
        />
      </div>
      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-label="Start from"
        className="grid max-h-80 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3"
      >
        {options.map((option) => (
          <Label
            key={option.id}
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/40",
              value === option.id && "border-primary/50 bg-primary/5",
            )}
          >
            <RadioGroupItem value={option.id} className="mt-0.5" />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {option.predefined !== null && (
                  <RoleTypeIcon
                    predefined={option.predefined}
                    className="size-3.5"
                  />
                )}
                <span className="truncate capitalize">{option.name}</span>
              </span>
              <span className="block text-xs text-muted-foreground">
                {option.description}
              </span>
            </span>
          </Label>
        ))}
        {options.length === 0 && (
          <p className="col-span-full p-6 text-center text-sm text-muted-foreground">
            No roles match.
          </p>
        )}
      </RadioGroup>
    </div>
  );
}
