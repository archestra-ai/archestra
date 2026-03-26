export async function verifyAgentAccess({
  userId,
  agentId,
  organizationId,
}: {
  userId: string;
  agentId: string;
  organizationId?: string;
}): Promise<boolean> {
  return true;
}
