"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2, QrCode, Shield, ShieldOff } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/clients/auth/auth-client";

const verifyTotpSchema = z.object({
  code: z.string().length(6, "Code must be 6 digits"),
});

type VerifyTotpFormData = z.infer<typeof verifyTotpSchema>;

interface TwoFactorCardProps {
  className?: string;
}

export function TwoFactorCard({ className }: TwoFactorCardProps) {
  const [isSetupDialogOpen, setIsSetupDialogOpen] = useState(false);
  const [setupData, setSetupData] = useState<{
    qrCode: string;
    secret: string;
  } | null>(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const { data: twoFactorData, refetch } = authClient.twoFactor.useGetTwoFactor();

  const form = useForm<VerifyTotpFormData>({
    resolver: zodResolver(verifyTotpSchema),
    defaultValues: {
      code: "",
    },
  });

  const handleEnableTwoFactor = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.enable({
        password: "", // User should provide their password for security
      });

      if (result.error) {
        console.error("Failed to enable 2FA:", result.error);
        setIsLoading(false);
        return;
      }

      if (result.data) {
        setSetupData({
          qrCode: result.data.qrCode,
          secret: result.data.secret,
        });
        setIsSetupDialogOpen(true);
      }
    } catch (err) {
      console.error("Error enabling 2FA:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyAndEnable = async (data: VerifyTotpFormData) => {
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: data.code,
      });

      if (result.error) {
        console.error("Failed to verify code:", result.error);
        return;
      }

      setIsEnabled(true);
      setIsSetupDialogOpen(false);
      setSetupData(null);
      form.reset();
      refetch();
    } catch (err) {
      console.error("Error verifying TOTP:", err);
    }
  };

  const handleDisableTwoFactor = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.disable({
        password: "", // User should provide their password for security
      });

      if (result.error) {
        console.error("Failed to disable 2FA:", result.error);
      } else {
        setIsEnabled(false);
        refetch();
      }
    } catch (err) {
      console.error("Error disabling 2FA:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const is2FAEnabled = twoFactorData?.enabled || isEnabled;

  return (
    <>
      <Card className={className}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                {is2FAEnabled ? (
                  <Shield className="h-5 w-5 text-green-600" />
                ) : (
                  <ShieldOff className="h-5 w-5 text-muted-foreground" />
                )}
                Two-Factor Authentication
              </CardTitle>
              <CardDescription>
                Add an extra layer of security to your account
              </CardDescription>
            </div>
            {is2FAEnabled ? (
              <Button
                onClick={handleDisableTwoFactor}
                variant="outline"
                size="sm"
                disabled={isLoading}
              >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Disable
              </Button>
            ) : (
              <Button
                onClick={handleEnableTwoFactor}
                size="sm"
                disabled={isLoading}
              >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Enable
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {is2FAEnabled ? (
            <div className="flex items-start gap-3 rounded-lg bg-green-50 dark:bg-green-950 p-4">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-green-900 dark:text-green-100">
                  Two-factor authentication is enabled
                </p>
                <p className="text-sm text-green-700 dark:text-green-300">
                  Your account is protected with an additional security layer
                  using TOTP.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Two-factor authentication adds an extra layer of security to
                your account. You'll need to enter a code from your
                authenticator app when signing in.
              </p>
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950 p-4 border border-amber-200 dark:border-amber-800">
                <p className="text-sm text-amber-900 dark:text-amber-100">
                  We recommend enabling 2FA to protect your account from
                  unauthorized access.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Setup 2FA Dialog */}
      <Dialog
        open={isSetupDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsSetupDialogOpen(false);
            setSetupData(null);
            form.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Up Two-Factor Authentication</DialogTitle>
            <DialogDescription>
              Scan the QR code with your authenticator app
            </DialogDescription>
          </DialogHeader>

          {setupData && (
            <div className="space-y-4">
              <div className="flex justify-center">
                <div className="rounded-lg border p-4 bg-white">
                  <Image
                    src={setupData.qrCode}
                    alt="QR Code for 2FA setup"
                    width={200}
                    height={200}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Manual Entry</p>
                <code className="block rounded-lg bg-muted p-3 text-sm break-all">
                  {setupData.secret}
                </code>
                <p className="text-xs text-muted-foreground">
                  If you can't scan the QR code, enter this secret manually in
                  your authenticator app
                </p>
              </div>

              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(handleVerifyAndEnable)}
                  className="space-y-4"
                >
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Verification Code</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="000000"
                            maxLength={6}
                            autoComplete="off"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={form.formState.isSubmitting}
                  >
                    {form.formState.isSubmitting && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    Verify and Enable
                  </Button>
                </form>
              </Form>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
