"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <Card>
      <CardContent>
        {/* The avatar sits in the gutter beside the fields, so the form starts
            at one left edge instead of stepping in after a full-width header.
            Display-only: there is no self-service upload endpoint, and the
            name is not repeated here — the Name field holds it. */}
        <div className="flex gap-4">
          <Avatar className="size-16 shrink-0">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback className="text-base">
              {(name || email).slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {/* A settings form is read at a fixed measure: fields stretched to a
              1400px card are hard to scan and imply far more input than a
              name. */}
          <div className="w-full min-w-0 max-w-xl">
            <ProfileForm name={name} email={email} role={role ?? ""} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileForm({
  name,
  email,
  role,
}: {
  name: string;
  email: string;
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
      <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="gap-2">
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  autoComplete="name"
                  disabled={updateName.isPending}
                />
              </FormControl>
              <FormDescription className="text-pretty">
                Shown next to you across the app.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <ReadOnlyField
          id="account-email"
          label="Email"
          value={email}
          note="The address you sign in with. It can't be changed."
        />

        <ReadOnlyField
          id="account-role"
          label="Role"
          value={role}
          valueClassName="capitalize"
          note="Set by an organization admin. You can't change your own role."
        />

        <Button
          type="submit"
          disabled={updateName.isPending || !form.formState.isDirty}
        >
          {updateName.isPending && <Loader2 className="size-4 animate-spin" />}
          <span>Update profile</span>
        </Button>
      </form>
    </Form>
  );
}

/**
 * A value with no self-service endpoint behind it. It stays a real input so
 * the block matches the editable fields around it and the value can still be
 * selected and copied, but it keeps full-contrast text — muted text on a
 * muted fill drops under the contrast floor (WCAG AA 4.5:1) — and says why it
 * is locked.
 */
function ReadOnlyField({
  id,
  label,
  value,
  note,
  valueClassName,
}: {
  id: string;
  label: string;
  value: string;
  note: string;
  valueClassName?: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value || "—"}
        readOnly
        aria-readonly
        className={`cursor-default bg-muted ${valueClassName ?? ""}`}
      />
      <p className="text-pretty text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <Card>
      <CardContent>
        {/* Shaped like the form it replaces, so the section does not jump
            when the session lands. */}
        <div className="flex gap-4">
          <Skeleton className="size-16 shrink-0 rounded-full" />
          <div className="w-full min-w-0 max-w-xl space-y-6">
            {["name", "email", "role"].map((field) => (
              <div key={field} className="grid gap-2">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ))}
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
