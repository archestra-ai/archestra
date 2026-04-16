import { AuthErrorTool } from "./auth-error-tool";

interface AssignedCredentialUnavailableToolProps {
  catalogName: string;
}

export function AssignedCredentialUnavailableTool({
  catalogName,
}: AssignedCredentialUnavailableToolProps) {
  return (
    <AuthErrorTool
      title="Credential Assignment Error"
      description={
        <>
          This tool is pinned to a personal connection for &ldquo;{catalogName}
          &rdquo; that your account cannot access. Ask the agent owner or an
          admin to update the tool assignment.
        </>
      }
    />
  );
}
