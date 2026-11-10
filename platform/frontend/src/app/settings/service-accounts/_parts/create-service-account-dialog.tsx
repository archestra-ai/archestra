"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { IdentityFields } from "@/components/identity-fields";
import { RoleAssignmentBlockedNotice } from "@/components/role-assignment-blocked-notice";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleSelect } from "@/components/ui/role-select";
import { useCreateServiceAccount } from "@/lib/service-account.query";
import { formatRoleName } from "@/lib/utils/role";
import { ServiceAccountTeamSelect } from "./service-account-team-select";

/**
 * Creating a service account takes only a name, its roles and a team, so it
 * is a dialog. It then opens the account's page, where its API keys and
 * federated credentials are added. Labels are set later on the edit page.
 */
export function CreateServiceAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const createMutation = useCreateServiceAccount();
  const form = useForm<CreateValues>({ defaultValues: DEFAULT_VALUES });
  const name = form.watch("name");
  const role = form.watch("role");

  const close = (next: boolean) => {
    if (!next) {
      form.reset(DEFAULT_VALUES);
      createMutation.reset();
    }
    onOpenChange(next);
  };

  const submit = form.handleSubmit(async (values) => {
    const account = await createMutation
      .mutateAsync({
        name: values.name.trim(),
        icon: values.icon,
        role: values.role,
        ...(values.teamId ? { teamId: values.teamId } : {}),
      })
      // A refused role is explained beside the roles; anything else toasts.
      .catch(() => null);
    if (!account) return;
    close(false);
    router.push(`/settings/service-accounts/${account.id}`);
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title="Create service account"
      description="You add its credentials next, on the account's page."
      size="medium"
      isDirty={form.formState.isDirty}
    >
      <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogBody className="space-y-4">
          <IdentityFields
            icon={form.watch("icon")}
            onIconChange={(icon) =>
              form.setValue("icon", icon, { shouldDirty: true })
            }
            showLogos
            label={<Label htmlFor="service-account-name">Display name</Label>}
          >
            <Input
              id="service-account-name"
              placeholder="Automation service account"
              {...form.register("name")}
            />
          </IdentityFields>
          <div className="space-y-2">
            <Label htmlFor="service-account-role">Roles</Label>
            <RoleSelect
              multiple
              id="service-account-role"
              value={role}
              onValueChange={(value) => {
                form.setValue("role", value, { shouldDirty: true });
                createMutation.reset();
              }}
              placeholder="Select a role"
              className="w-full"
            />
            <FieldDescription>
              Roles decide what the account can do.
            </FieldDescription>
          </div>
          <RoleAssignmentBlockedNotice
            error={createMutation.error}
            name={formatRoleName(role)}
          />
          <ServiceAccountTeamSelect
            id="service-account-team"
            value={form.watch("teamId")}
            onChange={(teamId) =>
              form.setValue("teamId", teamId, { shouldDirty: true })
            }
          />
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => close(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!name.trim() || !role || createMutation.isPending}
          >
            {createMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>Create</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

// === Internal helpers

type CreateValues = {
  name: string;
  icon: string | null;
  role: string;
  teamId: string | null;
};

const DEFAULT_VALUES: CreateValues = {
  name: "",
  icon: null,
  role: "member",
  teamId: null,
};
