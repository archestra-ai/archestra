"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { z } from "zod";
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
import {
  useEnableTwoFactorMutation,
  useVerifyTotpMutation,
} from "@/lib/auth/two-factor.query";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppName } from "@/lib/hooks/use-app-name";
import { downloadBackupCodes } from "@/lib/utils/backup-codes";

const PasswordFormSchema = z.object({
  password: z.string().min(1, "Password is required"),
});
type PasswordFormValues = z.infer<typeof PasswordFormSchema>;

const CodeFormSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
});
type CodeFormValues = z.infer<typeof CodeFormSchema>;

type EnrollmentSecrets = { totpURI: string; backupCodes: string[] };

/** Which step the flow is on; callers gate their own redirects on it. */
export type EnrollmentStep = "password" | "authenticator" | "backup-codes";

/**
 * The 2FA enrollment flow, in the order every major provider uses: confirm
 * password → scan the QR and prove the authenticator works → save the
 * recovery codes (download required to finish). Codes come last because
 * codes for an enrollment that was never verified are worthless.
 *
 * Returns the step's heading and body separately so the two entry points can
 * present it natively: a full page for mandatory enrollment after sign-in,
 * a dialog for the account page. Abandoning part-way is safe — an
 * unverified enrollment leaves the account unchanged and re-enrolling
 * replaces it.
 */
export function useTwoFactorEnrollment({
  requiredByOrganization = false,
  showSwitchUserLink = false,
  onFinished,
}: {
  requiredByOrganization?: boolean;
  showSwitchUserLink?: boolean;
  onFinished: () => void;
}): {
  step: EnrollmentStep;
  title: string;
  description: string;
  body: React.ReactNode;
} {
  const appName = useAppName();
  const [secrets, setSecrets] = useState<EnrollmentSecrets | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [hasDownloadedCodes, setHasDownloadedCodes] = useState(false);

  const enableTwoFactor = useEnableTwoFactorMutation();
  const verifyTotp = useVerifyTotpMutation();
  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(PasswordFormSchema),
    defaultValues: { password: "" },
  });
  const codeForm = useForm<CodeFormValues>({
    resolver: zodResolver(CodeFormSchema),
    defaultValues: { code: "" },
  });

  async function handlePasswordSubmit(values: PasswordFormValues) {
    const result = await enableTwoFactor.mutateAsync({
      password: values.password,
      // Shown beside the code in the user's authenticator app.
      issuer: appName,
    });
    if (result) {
      setSecrets({
        totpURI: result.totpURI,
        backupCodes: result.backupCodes,
      });
    }
  }

  async function handleCodeSubmit(values: CodeFormValues) {
    if (await verifyTotp.mutateAsync({ code: values.code })) {
      setIsVerified(true);
    }
  }

  async function copyCodes() {
    if (!secrets) return;
    await copyToClipboard(secrets.backupCodes.join("\n"));
    toast.success("Backup codes copied to clipboard");
  }

  function saveCodes() {
    if (!secrets) return;
    downloadBackupCodes(secrets.backupCodes, appName);
    setHasDownloadedCodes(true);
  }

  if (secrets && isVerified) {
    return {
      step: "backup-codes",
      title: "Save Your Backup Codes",
      description:
        "Store these somewhere safe. Each code can be used once to sign in if you lose access to your authenticator app — they are shown only once, so download them to continue.",
      body: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {secrets.backupCodes.map((code) => (
              <div
                key={code}
                className="rounded-md bg-muted px-3 py-2 text-center"
              >
                {code}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={copyCodes}
            >
              <Copy className="mr-2 h-4 w-4" />
              <span>Copy</span>
            </Button>
            <Button
              type="button"
              variant={hasDownloadedCodes ? "outline" : "default"}
              className="flex-1"
              onClick={saveCodes}
            >
              {hasDownloadedCodes ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              <span>{hasDownloadedCodes ? "Downloaded" : "Download"}</span>
            </Button>
          </div>
          <Button
            type="button"
            className="w-full"
            disabled={!hasDownloadedCodes}
            onClick={onFinished}
          >
            Done
          </Button>
          {!hasDownloadedCodes && (
            <p className="text-center text-xs text-muted-foreground">
              Download your backup codes to finish setup.
            </p>
          )}
        </div>
      ),
    };
  }

  if (secrets) {
    return {
      step: "authenticator",
      title: "Scan the QR Code",
      description:
        "Scan this with your authenticator app (1Password, Google Authenticator, …), then enter the 6-digit code it shows to confirm setup.",
      body: (
        <Form {...codeForm}>
          <form
            className="space-y-4"
            onSubmit={codeForm.handleSubmit(handleCodeSubmit)}
          >
            <div className="flex justify-center rounded-md bg-white p-4">
              <QRCode value={secrets.totpURI} size={160} />
            </div>
            <FormField
              control={codeForm.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>One-time code</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      disabled={verifyTotp.isPending}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={verifyTotp.isPending}
            >
              {verifyTotp.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <span>Verify</span>
            </Button>
          </form>
        </Form>
      ),
    };
  }

  return {
    step: "password",
    title: "Set Up Two-Factor Authentication",
    description: requiredByOrganization
      ? "Your organization requires two-factor authentication. Confirm your password to start setup — you'll scan a QR code with an authenticator app on the next step."
      : "Confirm your password to start setup — you'll scan a QR code with an authenticator app on the next step.",
    body: (
      <Form {...passwordForm}>
        <form
          className="space-y-4"
          onSubmit={passwordForm.handleSubmit(handlePasswordSubmit)}
        >
          <FormField
            control={passwordForm.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    disabled={enableTwoFactor.isPending}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            className="w-full"
            disabled={enableTwoFactor.isPending}
          >
            {enableTwoFactor.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            <span>Continue</span>
          </Button>
          {showSwitchUserLink && (
            <div className="text-center text-sm">
              <Link
                href="/auth/sign-out"
                className="text-muted-foreground underline-offset-4 hover:underline"
              >
                Sign in as a different user
              </Link>
            </div>
          )}
        </form>
      </Form>
    ),
  };
}
