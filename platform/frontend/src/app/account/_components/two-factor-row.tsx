"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  AccountRow,
  AccountRowMuted,
} from "@/app/account/_components/account-rows";
import {
  StandardDialog,
  StandardFormDialog,
} from "@/components/standard-dialog";
import { useTwoFactorEnrollment } from "@/components/two-factor/two-factor-enrollment";
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
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/lib/auth/auth.query";
import { useDisableTwoFactorMutation } from "@/lib/auth/two-factor.query";
import { useEnterpriseFeature } from "@/lib/config/config.query";

const PasswordFormSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

type PasswordFormValues = z.infer<typeof PasswordFormSchema>;

/**
 * The two-factor row of the security list: on/off, toggled in place.
 *
 * Enable/disable two-factor authentication. Enabling returns backup codes
 * (shown once in a dialog) and a TOTP URI; after saving the codes the user is
 * sent to /auth/two-factor to scan the QR code and confirm the authenticator.
 */
export function TwoFactorRow({ required = false }: { required?: boolean }) {
  const enterpriseCoreActive = useEnterpriseFeature("core");
  const { data: session, isPending: isSessionPending } = useSession();
  const twoFactorEnabled = !!session?.user?.twoFactorEnabled;
  const mustEnroll = required && !twoFactorEnabled;

  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [isEnrollmentOpen, setIsEnrollmentOpen] = useState(false);

  // 2FA is an enterprise feature. Without a license there is nothing a
  // non-enrolled user can do here (the server refuses enrollment), so hide
  // the card; already-enrolled users keep it so disabling stays possible if
  // a license lapses.
  if (!enterpriseCoreActive && !twoFactorEnabled) {
    return null;
  }

  return (
    <>
      <AccountRow
        label="Two-factor"
        action={
          <Switch
            aria-label="Two-factor authentication"
            checked={twoFactorEnabled}
            disabled={
              isSessionPending || isPasswordDialogOpen || isEnrollmentOpen
            }
            onCheckedChange={(enabled) => {
              if (!enabled) {
                // Disabling is still possible when required — the middleware
                // will simply lock the account out again; better-auth offers
                // no disable-block hook, so the row warns via copy.
                setIsPasswordDialogOpen(true);
                return;
              }
              // Same flow as mandatory enrollment (password, QR + code, then
              // the download-gated recovery codes) — but in place, since
              // there is no reason to leave the account page for it.
              setIsEnrollmentOpen(true);
            }}
          />
        }
      >
        {twoFactorEnabled ? (
          <span>On</span>
        ) : mustEnroll ? (
          <span className="text-destructive">
            Required by your organization. Turn it on to keep using the
            platform.
          </span>
        ) : (
          <AccountRowMuted>Off</AccountRowMuted>
        )}
      </AccountRow>
      <TwoFactorPasswordDialog
        open={isPasswordDialogOpen}
        onOpenChange={setIsPasswordDialogOpen}
      />
      {/* Mounted only while open so closing discards the flow's state —
          including anything typed into the password field. */}
      {isEnrollmentOpen && (
        <TwoFactorEnrollmentDialog open onOpenChange={setIsEnrollmentOpen} />
      )}
    </>
  );
}

/** Password confirmation for turning 2FA OFF (enrollment has its own page). */
function TwoFactorPasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const disableTwoFactor = useDisableTwoFactorMutation();
  const isPending = disableTwoFactor.isPending;

  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(PasswordFormSchema),
    defaultValues: { password: "" },
  });

  useEffect(() => {
    if (!open) {
      form.reset();
    }
  }, [form, open]);

  async function onSubmit(values: PasswordFormValues) {
    const disabled = await disableTwoFactor.mutateAsync({
      password: values.password,
    });
    if (disabled) {
      onOpenChange(false);
    }
  }

  return (
    <Form {...form}>
      <StandardFormDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Disable Two-Factor Authentication"
        description="Confirm your password to continue."
        size="small"
        onSubmit={form.handleSubmit(onSubmit)}
        bodyClassName="space-y-4"
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <span>Continue</span>
            </Button>
          </>
        }
      >
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </StandardFormDialog>
    </Form>
  );
}

/**
 * Runs the shared enrollment flow in place. Abandoning it is safe: an
 * unverified enrollment leaves the account unchanged and starting again
 * replaces it.
 */
function TwoFactorEnrollmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { title, description, body } = useTwoFactorEnrollment({
    onFinished: () => onOpenChange(false),
  });

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="small"
      bodyClassName="space-y-4"
    >
      {body}
    </StandardDialog>
  );
}
