"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  useEnableTwoFactorMutation,
  useVerifyTotpMutation,
} from "@/lib/auth/two-factor.query";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { downloadBackupCodes } from "@/lib/utils/backup-codes";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

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

/**
 * Full-page 2FA enrollment wizard, in the order every major provider uses:
 * confirm password → scan the QR and prove the authenticator works → save the
 * recovery codes. Codes come last because codes for an enrollment that was
 * never verified are worthless, and downloading them is required to finish.
 *
 * Reached two ways: routed here by the API's `two_factor_setup_required`
 * refusal when the organization mandates 2FA (the user keeps landing here
 * until enrolled), or from the account page's Enable button.
 */
export function TwoFactorSetupView() {
  const searchParams = useSearchParams();
  const redirectTo = getValidatedRedirectPath(searchParams.get("redirectTo"));
  const appName = useAppName();
  const { data: session } = useSession();
  const { data: organization } = useOrganization();
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

  // Already enrolled and not mid-wizard: nothing to set up here.
  if (session?.user.twoFactorEnabled && !secrets) {
    window.location.assign(redirectTo);
    return null;
  }

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
    const verified = await verifyTotp.mutateAsync({ code: values.code });
    if (verified) {
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

  function finish() {
    // Full navigation so the app re-reads the now-enrolled session.
    window.location.assign(redirectTo);
  }

  if (secrets && isVerified) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">Save Your Backup Codes</CardTitle>
          <CardDescription>
            Store these somewhere safe. Each code can be used once to sign in if
            you lose access to your authenticator app — they are shown only
            once, so download them to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
            onClick={finish}
          >
            Done
          </Button>
          {!hasDownloadedCodes && (
            <p className="text-center text-xs text-muted-foreground">
              Download your backup codes to finish setup.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  if (secrets) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">Scan the QR Code</CardTitle>
          <CardDescription>
            Scan this with your authenticator app (1Password, Google
            Authenticator, …), then enter the 6-digit code it shows to confirm
            setup.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">
          Set Up Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          {organization?.requireTwoFactor
            ? "Your organization requires two-factor authentication. Confirm your password to start setup — you'll scan a QR code with an authenticator app on the next step."
            : "Confirm your password to start setup — you'll scan a QR code with an authenticator app on the next step."}
        </CardDescription>
      </CardHeader>
      <CardContent>
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
            <div className="text-center text-sm">
              <Link
                href="/auth/sign-out"
                className="text-muted-foreground underline-offset-4 hover:underline"
              >
                Sign in as a different user
              </Link>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
