import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

export type DevFeedbackComment =
  archestraApiTypes.GetDevFeedbackCommentsResponses["200"][number];
export type DevFeedbackReply =
  archestraApiTypes.GetDevFeedbackRepliesResponses["200"][number];
export type CreateDevFeedbackCommentBody =
  archestraApiTypes.CreateDevFeedbackCommentData["body"];

export function useDevFeedbackSetup() {
  return useQuery({
    queryKey: devFeedbackKeys.setup,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDevFeedbackSetup();
      throwOnApiError(error, { toastOnError: false });
      return (
        data ?? {
          configured: false,
          channelName: null,
          agentId: null,
          agentName: null,
        }
      );
    },
  });
}

export function useDevFeedbackBots(enabled: boolean) {
  return useQuery({
    queryKey: devFeedbackKeys.bots,
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listDevFeedbackBots();
      throwOnApiError(error);
      return data ?? [];
    },
    enabled,
  });
}

export function useDevFeedbackChannels(botId: string | null) {
  return useQuery({
    queryKey: devFeedbackKeys.channels(botId ?? ""),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.listDevFeedbackChannels({
        path: { botId: botId ?? "" },
      });
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: botId !== null,
  });
}

export function useSaveDevFeedbackSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      body: archestraApiTypes.SaveDevFeedbackSetupData["body"],
    ) => {
      const { data, error } = await archestraApiSdk.saveDevFeedbackSetup({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (status) => {
      queryClient.invalidateQueries({ queryKey: devFeedbackKeys.all });
      toast.success(`Feedback goes to #${status.channelName}`);
    },
  });
}

export function useDevFeedbackComments(params: {
  route: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: devFeedbackKeys.comments(params.route),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDevFeedbackComments({
        query: { route: params.route },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: params.enabled,
    staleTime: 20 * 1000,
  });
}

export function useDevFeedbackReplies(commentId: string | null) {
  return useQuery({
    queryKey: devFeedbackKeys.replies(commentId ?? ""),
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getDevFeedbackReplies({
        path: { commentId: commentId ?? "" },
      });
      throwOnApiError(error);
      return data ?? [];
    },
    enabled: commentId !== null,
  });
}

export function useCreateDevFeedbackComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateDevFeedbackCommentBody) => {
      const { data, error } = await archestraApiSdk.createDevFeedbackComment({
        body,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (comment) => {
      queryClient.invalidateQueries({ queryKey: devFeedbackKeys.all });
      toast.success("Posted to Slack", {
        description: comment.dispatch
          ? comment.dispatch.status === "started"
            ? "Agent review started. Its response will appear in the Slack thread."
            : `${comment.dispatch.message ?? "Agent review could not start."} Open the Slack thread and ask the configured agent manually. Do not repost the feedback.`
          : undefined,
        action: comment.permalink
          ? {
              label: "Open",
              onClick: () => window.open(comment.permalink ?? "", "_blank"),
            }
          : undefined,
      });
    },
  });
}

export function useCreateDevFeedbackReply(commentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const { data, error } = await archestraApiSdk.createDevFeedbackReply({
        path: { commentId },
        body: { text },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: devFeedbackKeys.all });
    },
  });
}

export function useResolveDevFeedbackComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (commentId: string) => {
      const { error } = await archestraApiSdk.resolveDevFeedbackComment({
        path: { commentId },
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: devFeedbackKeys.all });
      toast.success("Resolved");
    },
  });
}

// ===

const devFeedbackKeys = {
  all: ["dev-feedback"] as const,
  setup: ["dev-feedback", "setup"] as const,
  bots: ["dev-feedback", "setup", "bots"] as const,
  channels: (botId: string) =>
    [...devFeedbackKeys.all, "setup", "channels", botId] as const,
  comments: (route: string) =>
    [...devFeedbackKeys.all, "comments", route] as const,
  replies: (commentId: string) =>
    [...devFeedbackKeys.all, "replies", commentId] as const,
};
