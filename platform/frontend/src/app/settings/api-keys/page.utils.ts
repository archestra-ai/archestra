export function shouldSkipCreateApiKeySubmit(params: {
  hasSubmittedForCurrentDialogOpen: boolean;
  isCreatePending: boolean;
  createdApiKeyValue: string | null;
}): boolean {
  return (
    params.hasSubmittedForCurrentDialogOpen ||
    params.isCreatePending ||
    !!params.createdApiKeyValue
  );
}
