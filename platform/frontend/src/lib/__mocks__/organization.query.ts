/**
 * Jest-style mock for `@/lib/organization.query`, activated per test file by a bare
 * `vi.mock("@/lib/organization.query");`. Every hook is a bare `vi.fn()` — configure per
 * test via `vi.mocked(...)`. Query-key constants stay real (pure data).
 */
import { vi } from "vitest";

const actual = await vi.importActual<typeof import("@/lib/organization.query")>(
  "@/lib/organization.query",
);

export const appearanceKeys = actual.appearanceKeys;
export const organizationKeys = actual.organizationKeys;

export const useAppearanceSettings = vi.fn();
export const useInvitation = vi.fn();
export const useActiveOrganization = vi.fn();
export const useActiveMemberRole = vi.fn();
export const useAcceptInvitation = vi.fn();
export const useInvitationsList = vi.fn();
export const useCancelInvitation = vi.fn();
export const useCreateInvitation = vi.fn();
export const useOrganization = vi.fn();
export const useOrganizationOnboardingStatus = vi.fn();
export const useUpdateAppearanceSettings = vi.fn();
export const useUpdateSecuritySettings = vi.fn();
export const useUpdateLlmSettings = vi.fn();
export const useUpdateAgentSettings = vi.fn();
export const useUpdateConnectionSettings = vi.fn();
export const useUpdateDefaultEnvironment = vi.fn();
export const useDefaultEnvironment = vi.fn();
export const useUpdateAuthSettings = vi.fn();
export const useUpdateKnowledgeSettings = vi.fn();
export const useDropEmbeddingConfig = vi.fn();
export const useTestEmbeddingConnection = vi.fn();
export const useOrganizationMembers = vi.fn();
export const useMemberSignupStatus = vi.fn();
export const useDeletePendingSignupMember = vi.fn();
