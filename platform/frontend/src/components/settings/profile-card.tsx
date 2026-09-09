"use client";

import {
  getRoleDisplayName,
  PredefinedRoleNameSchema,
} from "@archestra/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { RoleOptionLabel } from "@/components/role-type-icon";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useUpdateAccountNameMutation } from "@/lib/auth/account.query";
import { useSession } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";

const NameFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
});

type NameFormValues = z.infer<typeof NameFormSchema>;

export function ProfileCard() {
  const { data: session, isPending: isSessionPending } = useSession();
  const hasActiveOrganization = !!session?.session?.activeOrganizationId;
  const { data: role, isPending: isRolePending } = useActiveMemberRole();

  // The role query stays pending forever for a user with no active
  // organization (it never enables), so its wait only counts when the session
  // says there is an organization to have a role in.
  if (isSessionPending || (hasActiveOrganization && isRolePending)) {
    return <ProfileSkeleton />;
  }

  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";
  const image = session?.user?.image ?? null;

  return (
    <SettingsBlock title="Profile">
      <div className="max-w-xl">
        <ProfileForm
          name={name}
          email={email}
          image={image}
          role={role ?? ""}
        />
      </div>
    </SettingsBlock>
  );
}

function ProfileForm({
  name,
  email,
  image,
  role,
}: {
  name: string;
  email: string;
  image: string | null;
  role: string;
}) {
  const updateName = useUpdateAccountNameMutation();
  const form = useForm<NameFormValues>({
    resolver: zodResolver(NameFormSchema),
    values: { name },
  });

  async function onSubmit(values: NameFormValues) {
    const updated = await updateName.mutateAsync(values.name.trim());
    if (updated) {
      // Re-baseline the form so the button goes back to disabled; the session
      // refetch behind `values` lands a moment later.
      form.reset({ name: values.name.trim() });
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)}>
        <div className="flex items-center gap-3">
          <Avatar className="size-12 shrink-0">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback>
              {(name || email).slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="min-w-0 flex-1 gap-2">
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    autoComplete="name"
                    disabled={updateName.isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <dl className="divide-y text-sm">
          <div className="grid gap-2 py-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="min-w-0 break-all select-text">{email || "—"}</dd>
          </div>
          <div className="grid gap-2 py-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Roles</dt>
            <dd className="space-y-2">
              <ul aria-label="Assigned roles" className="flex flex-wrap gap-2">
                {role
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean)
                  .map((value) => (
                    <li key={value} className="rounded-md border px-2.5 py-1.5">
                      <RoleOptionLabel
                        predefined={
                          PredefinedRoleNameSchema.safeParse(value).success
                        }
                        label={getRoleDisplayName(value)}
                      />
                    </li>
                  ))}
                {!role.trim() && <li>—</li>}
              </ul>
              <p className="text-xs text-muted-foreground">
                Managed by your organization admin.
              </p>
            </dd>
          </div>
        </dl>
      </form>

      <SettingsSaveBar
        hasChanges={form.formState.isDirty}
        isSaving={updateName.isPending}
        permissions={{}}
        onSave={form.handleSubmit(onSubmit)}
        onCancel={() => form.reset()}
      />
    </Form>
  );
}

function ProfileSkeleton() {
  return (
    <SettingsBlock title="Profile">
      <div className="max-w-xl space-y-5">
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="grid min-w-0 flex-1 gap-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </SettingsBlock>
  );
}
