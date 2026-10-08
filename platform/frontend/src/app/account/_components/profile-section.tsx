"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AccountRows } from "@/app/account/_components/account-rows";
import { SettingsSection } from "@/components/settings-section";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { typeRole } from "@/lib/design/type-scale";

/**
 * Who you are, as one identity row. The name is the only thing here you can
 * change, and it changes rarely, so it is edited in a dialog rather than kept
 * as an always-open input — an input on a page you mostly read makes the whole
 * page look like a form waiting to be filled in.
 */
export function ProfileSection() {
  const { data: session, isPending } = useSession();
  const [isEditing, setIsEditing] = useState(false);
  const name = session?.user?.name ?? "";
  const email = session?.user?.email ?? "";
  const image = session?.user?.image ?? null;

  return (
    <SettingsSection title="Profile">
      <AccountRows label="Profile">
        <li className="flex items-center gap-4 px-4 py-4">
          {isPending ? (
            <>
              <Skeleton className="size-11 shrink-0 rounded-full" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </>
          ) : (
            <>
              <Avatar className="size-11 shrink-0">
                {image && <AvatarImage src={image} alt="" />}
                <AvatarFallback>
                  {(name || email).slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className={typeRole({ role: "section-title" })}>
                  {name || "—"}
                </p>
                <p className="truncate text-sm text-muted-foreground select-text">
                  {email}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsEditing(true)}
              >
                Edit name
              </Button>
            </>
          )}
        </li>
      </AccountRows>
      {isEditing && (
        <EditNameDialog name={name} onClose={() => setIsEditing(false)} />
      )}
    </SettingsSection>
  );
}

const NameFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
});

type NameFormValues = z.infer<typeof NameFormSchema>;

function EditNameDialog({
  name,
  onClose,
}: {
  name: string;
  onClose: () => void;
}) {
  const updateName = useUpdateAccountNameMutation();
  const form = useForm<NameFormValues>({
    resolver: zodResolver(NameFormSchema),
    defaultValues: { name },
  });

  // Select the current name so typing replaces it, the usual rename gesture.
  useEffect(() => {
    form.setFocus("name", { shouldSelect: true });
  }, [form]);

  async function onSubmit(values: NameFormValues) {
    const updated = await updateName.mutateAsync(values.name.trim());
    if (updated) onClose();
  }

  return (
    <Form {...form}>
      <StandardFormDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title="Edit name"
        description="How you appear to others in your organization."
        size="small"
        onSubmit={form.handleSubmit(onSubmit)}
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={updateName.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={updateName.isPending || !form.formState.isDirty}
            >
              {updateName.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <span>Save</span>
            </Button>
          </>
        }
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="name" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </StandardFormDialog>
    </Form>
  );
}
