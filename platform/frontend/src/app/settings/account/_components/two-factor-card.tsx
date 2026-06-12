"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { SettingsBlock } from "@/components/settings/settings-block";
import {
  StandardDialog,
  StandardFormDialog,
} from "@/components/standard-dialog";
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
import { useSession } from "@/lib/auth/auth.query";
import {
  useDisableTwoFactorMutation,
  useEnableTwoFactorMutation,
} from "@/lib/auth/two-factor.query";

const PasswordFormSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

type PasswordFormValues = z.infer<typeof PasswordFormSchema>;

/**
 * Enable/disable two-factor authentication. Enabling returns backup codes
 * (shown once in a dialog) and a TOTP URI; after saving the codes the user is
 * sent to /auth/two-factor to scan the QR code and confirm the authenticator.
 */
export function TwoFactorCard() {
  const router = useRouter();
  const { data: session } = useSession();
  const twoFactorEnabled = !!session?.user?.twoFactorEnabled;

  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [enableResult, setEnableResult] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);

  return (
    <>
      <SettingsBlock
        title="Two-Factor Authentication"
        description={
          twoFactorEnabled
            ? "Two-factor authentication is enabled for your account."
            : "Add an extra layer of security by requiring a one-time code at sign-in."
        }
        control={
          <Button
            variant={twoFactorEnabled ? "outline" : "default"}
            onClick={() => setIsPasswordDialogOpen(true)}
          >
            {twoFactorEnabled ? "Disable 2FA" : "Enable 2FA"}
          </Button>
        }
      />
      <TwoFactorPasswordDialog
        open={isPasswordDialogOpen}
        onOpenChange={setIsPasswordDialogOpen}
        twoFactorEnabled={twoFactorEnabled}
        onEnabled={(result) => {
          setIsPasswordDialogOpen(false);
          setEnableResult(result);
        }}
      />
      <BackupCodesDialog
        result={enableResult}
        onContinue={() => {
          if (!enableResult) return;
          router.push(
            `/auth/two-factor?totpURI=${encodeURIComponent(enableResult.totpURI)}&redirectTo=${encodeURIComponent("/settings/account")}`,
          );
        }}
      />
    </>
  );
}

function TwoFactorPasswordDialog({
  open,
  onOpenChange,
  twoFactorEnabled,
  onEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  twoFactorEnabled: boolean;
  onEnabled: (result: { totpURI: string; backupCodes: string[] }) => void;
}) {
  const enableTwoFactor = useEnableTwoFactorMutation();
  const disableTwoFactor = useDisableTwoFactorMutation();
  const isPending = enableTwoFactor.isPending || disableTwoFactor.isPending;

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
    if (twoFactorEnabled) {
      const disabled = await disableTwoFactor.mutateAsync({
        password: values.password,
      });
      if (disabled) {
        onOpenChange(false);
      }
      return;
    }

    const result = await enableTwoFactor.mutateAsync({
      password: values.password,
    });
    if (result) {
      onEnabled({ totpURI: result.totpURI, backupCodes: result.backupCodes });
    }
  }

  return (
    <Form {...form}>
      <StandardFormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={
          twoFactorEnabled
            ? "Disable Two-Factor Authentication"
            : "Enable Two-Factor Authentication"
        }
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
              Continue
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

function BackupCodesDialog({
  result,
  onContinue,
}: {
  result: { totpURI: string; backupCodes: string[] } | null;
  onContinue: () => void;
}) {
  async function copyBackupCodes() {
    if (!result) return;
    await navigator.clipboard.writeText(result.backupCodes.join("\n"));
    toast.success("Backup codes copied to clipboard");
  }

  return (
    <StandardDialog
      open={!!result}
      // Backup codes are shown exactly once and 2FA is already enabled at
      // this point, so dismissing the dialog also proceeds to the
      // authenticator setup step.
      onOpenChange={(open) => {
        if (!open) onContinue();
      }}
      title="Save Your Backup Codes"
      description="Store these codes somewhere safe. Each one can be used once to sign in if you lose access to your authenticator app."
      size="small"
      footer={
        <>
          <Button type="button" variant="outline" onClick={copyBackupCodes}>
            <Copy className="mr-2 h-4 w-4" />
            Copy
          </Button>
          <Button type="button" onClick={onContinue}>
            Continue
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 font-mono text-sm">
        {(result?.backupCodes ?? []).map((code) => (
          <div key={code} className="rounded-md bg-muted px-3 py-2 text-center">
            {code}
          </div>
        ))}
      </div>
    </StandardDialog>
  );
}
