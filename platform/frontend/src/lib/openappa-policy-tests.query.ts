import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type PolicyTestCollection =
  archestraApiTypes.GetOpenAppaPolicyTestsResponses[200];
export type PolicyTestRun =
  archestraApiTypes.RunOpenAppaPolicyTestsResponses[200];
export type PolicyTestInspection =
  archestraApiTypes.InspectOpenAppaPolicyTestsResponses[200];
export type PolicyTestPreview =
  archestraApiTypes.PreviewOpenAppaPolicyTestResponses[200];

export function usePreviewOpenAppaPolicyTest() {
  return useMutation({
    gcTime: 0,
    mutationFn: async (
      body: archestraApiTypes.PreviewOpenAppaPolicyTestData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.previewOpenAppaPolicyTest({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
  });
}

export function useInspectOpenAppaPolicyTests() {
  return useMutation({
    gcTime: 0,
    mutationFn: async (
      body: archestraApiTypes.InspectOpenAppaPolicyTestsData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.inspectOpenAppaPolicyTests({
        body,
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useOpenAppaPolicyTests(enabled: boolean) {
  return useQuery({
    queryKey: ["openappa-policy-tests", "active"],
    enabled,
    // A background refresh must not replace the text the user is editing.
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenAppaPolicyTests();
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
  });
}

export function useSaveOpenAppaPolicyTests(
  onSaved?: (
    collection: PolicyTestCollection | undefined,
    submitted: archestraApiTypes.UpdateOpenAppaPolicyTestsData["body"],
  ) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.UpdateOpenAppaPolicyTestsData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.updateOpenAppaPolicyTests({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (data, submitted) => {
      client.setQueryData(["openappa-policy-tests", "active"], data);
      onSaved?.(data, submitted);
      toast.success("Policy validation saved");
      return client.invalidateQueries({
        queryKey: ["openappa-policy-test-runs"],
      });
    },
  });
}

export function useRunOpenAppaPolicyTests() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.RunOpenAppaPolicyTestsData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.runOpenAppaPolicyTests({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["openappa-policy-test-runs"] }),
  });
}

export function useOpenAppaPolicyTestRuns(enabled: boolean) {
  return useQuery({
    queryKey: ["openappa-policy-test-runs"],
    enabled,
    refetchInterval: 10000,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getOpenAppaPolicyTestRuns();
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
}
