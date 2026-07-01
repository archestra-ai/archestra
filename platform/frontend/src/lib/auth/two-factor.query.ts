import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";

type AuthClientError = {
  message?: string;
  statusText?: string;
};

/**
 * Enable two-factor authentication. Returns the TOTP URI (for the QR setup
 * step) and the generated backup codes, or null when the request fails.
 */
export function useEnableTwoFactorMutation() {
  return useMutation({
    mutationFn: async (params: { password: string }) => {
      const { data, error } = await authClient.twoFactor.enable({
        password: params.password,
      });

      if (error) {
        toast.error(getAuthErrorMessage(error, "Failed to enable two-factor"));
        return null;
      }

      return data;
    },
  });
}

export function useDisableTwoFactorMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { password: string }) => {
      const { error } = await authClient.twoFactor.disable({
        password: params.password,
      });

      if (error) {
        toast.error(getAuthErrorMessage(error, "Failed to disable two-factor"));
        return false;
      }

      return true;
    },
    onSuccess: async (disabled) => {
      if (!disabled) return;
      toast.success("Two-factor authentication disabled");
      await queryClient.invalidateQueries({ queryKey: authQueryKeys.all });
    },
  });
}

/**
 * Verify a TOTP code. Used both to confirm authenticator setup and to
 * complete a two-factor sign-in.
 */
export function useVerifyTotpMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { code: string; trustDevice?: boolean }) => {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: params.code,
        trustDevice: params.trustDevice,
      });

      if (error) {
        toast.error(getAuthErrorMessage(error, "Invalid verification code"));
        return false;
      }

      await queryClient.invalidateQueries({ queryKey: authQueryKeys.all });
      return true;
    },
  });
}

/**
 * Sign in with a two-factor backup code (account recovery when the
 * authenticator is unavailable).
 */
export function useVerifyBackupCodeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { code: string }) => {
      const { error } = await authClient.twoFactor.verifyBackupCode({
        code: params.code,
      });

      if (error) {
        toast.error(getAuthErrorMessage(error, "Invalid backup code"));
        return false;
      }

      await queryClient.invalidateQueries({ queryKey: authQueryKeys.all });
      return true;
    },
  });
}

function getAuthErrorMessage(error: AuthClientError, fallback: string) {
  return error.message ?? error.statusText ?? fallback;
}
