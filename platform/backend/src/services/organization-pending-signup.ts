import { withDbTransaction } from "@/database";
import {
  AccountModel,
  InvitationModel,
  MemberModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { ApiError } from "@/types";

type PendingSignupMember = {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  provider: string | null;
  invitationId: string | null;
};

export async function listPendingSignupMembers(params: {
  organizationId: string;
}): Promise<PendingSignupMember[]> {
  const pendingUsers = await MemberModel.listMembersWithoutAccounts(
    params.organizationId,
  );

  const invitations = await InvitationModel.findAutoProvisionedByEmailsInOrg({
    emails: pendingUsers.map((user) => user.email),
    organizationId: params.organizationId,
  });

  const emailToInvitation = new Map<
    string,
    { provider: string | null; invitationId: string }
  >();
  for (const invitation of invitations) {
    const parts = invitation.status.split(":");
    emailToInvitation.set(invitation.email, {
      provider: parts.length === 2 ? parts[1] : null,
      invitationId: invitation.id,
    });
  }

  return pendingUsers.map((user) => {
    const invitation = emailToInvitation.get(user.email);
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      provider: invitation?.provider ?? null,
      invitationId: invitation?.invitationId ?? null,
    };
  });
}

export async function deletePendingSignupMember(params: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  let deletedUserTokenSecretId: string | null = null;

  await withDbTransaction(async (tx) => {
    const accounts = await AccountModel.getAllByUserId(params.userId, tx);

    if (accounts.length > 0) {
      throw new ApiError(
        400,
        "Cannot delete a member who has already completed signup",
      );
    }

    const member = await MemberModel.getByUserId(
      params.userId,
      params.organizationId,
      tx,
    );
    if (!member) {
      throw new ApiError(404, "Member not found");
    }

    const user = await UserModel.getById(params.userId, tx);
    if (!user) {
      throw new ApiError(404, "User not found");
    }

    await InvitationModel.deleteAutoProvisionedForEmailInOrg({
      email: user.email,
      organizationId: params.organizationId,
      tx,
    });

    const deletedUserToken = await UserTokenModel.deleteRecordByUserAndOrg(
      params.userId,
      params.organizationId,
      tx,
    );
    deletedUserTokenSecretId = deletedUserToken?.secretId ?? null;

    await MemberModel.deleteByMemberOrUserId(
      params.userId,
      params.organizationId,
      tx,
    );

    const hasMembership = await MemberModel.hasAnyMembership(params.userId, tx);
    if (!hasMembership) {
      await UserModel.delete(params.userId, tx);
    }
  });

  if (deletedUserTokenSecretId) {
    await UserTokenModel.deleteSecret(deletedUserTokenSecretId);
  }
}
