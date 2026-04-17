import { AuthErrorTool } from "./auth-error-tool";

interface AssignedCredentialUnavailableToolProps {
  catalogName: string;
}

export function AssignedCredentialUnavailableTool({
  catalogName,
}: AssignedCredentialUnavailableToolProps) {
  return (
    <AuthErrorTool
      title="Expired / Invalid Authentication"
      description={
        <>
          credentials for &ldquo;{catalogName}&rdquo; have expired or are
          invalid. Re-authenticate to continue using this tool. Ask the agent
          owner or an admin to re-authenticate.
        </>
      }
    />
  );
}
