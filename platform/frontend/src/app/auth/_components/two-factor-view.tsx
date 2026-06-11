"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import QRCode from "react-qr-code";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useVerifyTotpMutation } from "@/lib/auth/two-factor.query";
import { getValidatedRedirectPath } from "@/lib/utils/redirect-validation";

const TwoFactorFormSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
  trustDevice: z.boolean(),
});

type TwoFactorFormValues = z.infer<typeof TwoFactorFormSchema>;

/**
 * Two-factor TOTP view, serving both flows that share the /auth/two-factor
 * route:
 * - Setup: reached with a `totpURI` query param right after enabling 2FA in
 *   account settings. Shows a QR code and confirms the authenticator with a
 *   first code.
 * - Verification: reached during sign-in when the account has 2FA enabled.
 *   Verifies the code (optionally trusting the device) and completes the
 *   session.
 */
export function TwoFactorView() {
  const searchParams = useSearchParams();
  const totpURI = searchParams.get("totpURI");
  const redirectTo = searchParams.get("redirectTo");
  const isSetup = !!totpURI;

  const verifyTotp = useVerifyTotpMutation();
  const form = useForm<TwoFactorFormValues>({
    resolver: zodResolver(TwoFactorFormSchema),
    defaultValues: { code: "", trustDevice: false },
  });

  async function onSubmit(values: TwoFactorFormValues) {
    const verified = await verifyTotp.mutateAsync({
      code: values.code,
      trustDevice: isSetup ? undefined : values.trustDevice,
    });

    if (!verified) return;

    // Full navigation (rather than router.push) so the app shell re-evaluates
    // the now-authenticated session from scratch.
    window.location.href = getValidatedRedirectPath(redirectTo);
  }

  const recoverAccountHref = redirectTo
    ? `/auth/recover-account?redirectTo=${encodeURIComponent(redirectTo)}`
    : "/auth/recover-account";

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Two-Factor Authentication</CardTitle>
        <CardDescription>
          {isSetup
            ? "Scan the QR code with your authenticator app, then enter the 6-digit code to finish setup"
            : "Enter the 6-digit code from your authenticator app"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            {isSetup && (
              <div className="flex justify-center rounded-md bg-white p-4">
                <QRCode value={totpURI} size={160} />
              </div>
            )}
            <FormField
              control={form.control}
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
            {!isSetup && (
              <FormField
                control={form.control}
                name="trustDevice"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={verifyTotp.isPending}
                      />
                    </FormControl>
                    <FormLabel className="font-normal">
                      Trust this device
                    </FormLabel>
                  </FormItem>
                )}
              />
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={verifyTotp.isPending}
            >
              {verifyTotp.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Verify
            </Button>
            {!isSetup && (
              <div className="text-center text-sm">
                <Link
                  href={recoverAccountHref}
                  className="text-muted-foreground underline-offset-4 hover:underline"
                >
                  Lost access to your authenticator? Use a backup code
                </Link>
              </div>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
