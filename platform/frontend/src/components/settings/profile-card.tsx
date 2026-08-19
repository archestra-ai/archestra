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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
    return (
      <Card>
        <CardContent className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";
  const image = session?.user?.image ?? null;

  return (
    <Card>
      <CardContent className="space-y-6">
        {/* The avatar has no self-service upload endpoint, so it sits in the
            header as identity rather than as a field. */}
        <div className="flex items-center gap-4">
          <Avatar className="size-16">
            {image && <AvatarImage src={image} alt="" />}
            <AvatarFallback className="text-base">
              {(name || email).slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <p className="min-w-0 truncate text-lg font-medium">{name || "—"}</p>
        </div>

        <Separator />

        <ProfileForm name={name} email={email} role={role ?? ""} />
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
      <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
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

        {/* Neither has a self-service endpoint, so both are read-only. They
            stay real fields so the section reads as one form and the values
            can still be selected and copied. */}
        <div className="space-y-2">
          <Label htmlFor="account-email">Email</Label>
          <Input
            id="account-email"
            value={email || "\u2014"}
            readOnly
            className="bg-muted text-muted-foreground"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="account-role">Role</Label>
          <Input
            id="account-role"
            value={role || "\u2014"}
            readOnly
            className="bg-muted capitalize text-muted-foreground"
          />
        </div>

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
