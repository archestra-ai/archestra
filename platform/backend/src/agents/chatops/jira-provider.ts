import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import JiraChatOpsDeliveryModel from "@/models/jira-chatops-delivery";
import { getHiddenMessagingChannels } from "@/services/integration-overrides";
import {
  executeJiraChatOpsOutbound,
  JiraOutboundRejectedError,
} from "@/services/jira-chatops-outbound";
import type {
  AddApprovalRequestFormOptions,
  ChatOpsProvider,
  ChatReplyOptions,
  ChatThreadMessage,
  ChatThreadMessageFile,
  DiscoveredChannel,
  IncomingChatMessage,
  ThreadFileOutcome,
  ThreadHistoryParams,
  UpdateApprovalRequestOptions,
} from "@/types/chatops";
import {
  type JiraBotConfig,
  JiraCommentEventSchema,
  type JiraDbConfig,
  normalizeJiraSiteUrl,
} from "@/types/chatops-jira";
import {
  applyChannelGate,
  isChannelThreadMuted,
  muteChannelThread,
} from "./channel-activation";
import {
  jiraMentionsAccount,
  jiraMessageText,
  jiraReplyDocument,
  parseJiraApprovalCommand,
} from "./jira-message";

export default class JiraProvider implements ChatOpsProvider {
  readonly providerId = "jira" as const;
  readonly displayName = "Jira";
  readonly pinnedAgentId: string;
  readonly stateScope: string;
  private readonly siteUrl: string;

  constructor(
    readonly jiraConfig: JiraDbConfig,
    readonly bot: JiraBotConfig,
  ) {
    this.siteUrl = normalizeJiraSiteUrl(jiraConfig.siteUrl);
    this.pinnedAgentId = bot.agentId;
    this.stateScope = `agent:${bot.agentId}`;
  }

  isConfigured(): boolean {
    return (
      this.jiraConfig.enabled &&
      this.bot.enabled &&
      Boolean(this.bot.apiToken && this.bot.accountId)
    );
  }

  async initialize(): Promise<void> {
    const identity = await verifyJiraBotIdentity({
      siteUrl: this.siteUrl,
      email: this.bot.email,
      apiToken: this.bot.apiToken,
      tokenType: this.bot.cloudId ? "scoped" : "classic",
    });
    if (
      identity.accountId !== this.bot.accountId ||
      identity.cloudId !== this.bot.cloudId
    )
      throw new Error(
        "Jira bot credentials belong to a different account. Reconnect this bot.",
      );
  }

  async cleanup(): Promise<void> {}

  getOrganizationId(): string {
    return this.jiraConfig.organizationId;
  }

  getFallbackIdentity(): {
    serviceAccountId: string;
    reviewerUserId: string;
    organizationId: string;
  } | null {
    if (!this.bot.fallbackServiceAccountId || !this.bot.fallbackReviewerUserId)
      return null;
    return {
      serviceAccountId: this.bot.fallbackServiceAccountId,
      reviewerUserId: this.bot.fallbackReviewerUserId,
      organizationId: this.jiraConfig.organizationId,
    };
  }

  async validateWebhookRequest(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    if (
      this.jiraConfig.ingressMode === "poll" ||
      !this.jiraConfig.webhookSecret ||
      typeof payload !== "string"
    )
      return false;
    if (this.jiraConfig.ingressMode === "automation") {
      return constantTimeEqual(
        header(headers, "x-archestra-jira-secret") ?? "",
        this.jiraConfig.webhookSecret,
      );
    }
    const signature = header(headers, "x-hub-signature");
    if (!signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = `sha256=${createHmac("sha256", this.jiraConfig.webhookSecret).update(payload).digest("hex")}`;
    return constantTimeEqual(signature.toLowerCase(), expected);
  }

  handleValidationChallenge(): null {
    return null;
  }

  async parseWebhookNotification(
    payload: unknown,
    headers: Record<string, string | string[] | undefined> = {},
  ): Promise<IncomingChatMessage | null> {
    if (!this.isConfigured()) return null;
    const event = JiraCommentEventSchema.safeParse(payload);
    if (!event.success) return null;
    const issueId = event.data.issue.id;
    const commentId = event.data.comment.id;
    // Fetch canonical data under the configured bot's project permissions. Event
    // fields are identifiers, never authority for authors, text or project routing.
    const canonical = await Promise.all([
      this.getIssue(issueId),
      this.request(
        `/rest/api/3/issue/${issueId}/comment/${commentId}`,
        jiraCommentSchema,
      ),
    ]).catch((error: unknown) => {
      if (
        error instanceof JiraApiRequestError &&
        [403, 404].includes(error.status)
      )
        return null;
      throw error;
    });
    if (!canonical) return null;
    const [issue, comment] = canonical;
    if (
      issue.id !== issueId ||
      comment.id !== commentId ||
      Date.parse(comment.updated) !== Date.parse(event.data.comment.updated)
    )
      return null;
    const sender =
      event.data.webhookEvent === "comment_updated"
        ? comment.updateAuthor
        : comment.author;
    if (
      !sender ||
      (event.data.webhookEvent === "comment_created" &&
        Date.parse(comment.created) !== Date.parse(comment.updated))
    )
      return null;
    if (
      comment.author.accountType === "app" ||
      sender.accountType === "app" ||
      this.jiraConfig.bots.some(
        (bot) =>
          bot.accountId === comment.author.accountId ||
          bot.accountId === sender.accountId,
      )
    )
      return null;
    // Restricted issue/comment visibility needs per-user Jira authorization; a
    // broad bot credential alone must not turn it into shared agent context.
    if (issue.fields.security || comment.visibility) return null;
    const channelId = jiraChannelId(this.bot.id, issue.fields.project.id);
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: "jira",
      channelId,
      workspaceId: this.jiraConfig.id,
    });
    if (
      !binding ||
      binding.agentId !== this.bot.agentId ||
      binding.organizationId !== this.jiraConfig.organizationId
    )
      return null;
    const thread = {
      provider: this.providerId,
      channelId,
      threadId: issue.id,
      scope: this.stateScope,
    };
    if (issue.fields.labels.includes("archestra-mute")) {
      await muteChannelThread(thread);
      return null;
    }
    const mentioned = jiraMentionsAccount(comment.body, this.bot.accountId);
    if (
      !mentioned &&
      this.jiraConfig.bots.some(
        (bot) =>
          bot.id !== this.bot.id &&
          jiraMentionsAccount(comment.body, bot.accountId),
      )
    )
      return null;
    const text = jiraMessageText(comment.body, this.bot.accountId);
    // Approval replies are authorized against persisted reviewer/task state by
    // the manager; they must survive the sticky conversation activation TTL.
    // A muted thread still rejects them until explicitly reactivated.
    const approvalReply = parseJiraApprovalCommand({ text });
    const gate =
      approvalReply && !(await isChannelThreadMuted(thread))
        ? { proceed: true }
        : await applyChannelGate({
            ...thread,
            botMentioned: mentioned,
            text,
            botDisplayName: this.bot.displayName,
            pinnedAgentId: this.bot.agentId,
            postMutedNotice: async () => {},
            resolveAnswerAllWorkspaceId: async () => this.jiraConfig.id,
          });
    if (!gate.proceed) return null;
    const eventId = `jira:${this.jiraConfig.id}:${this.bot.id}:${comment.id}:${comment.updated}`;
    return {
      messageId: eventId,
      channelId,
      workspaceId: this.jiraConfig.id,
      threadId: issue.id,
      senderId: sender.accountId,
      senderEmail: sender.emailAddress,
      senderName: sender.displayName,
      text:
        text ||
        "(The sender mentioned you without a message. Reply briefly about this issue.)",
      rawText: jiraMessageText(comment.body),
      timestamp: new Date(comment.updated),
      isThreadReply: true,
      metadata: {
        jiraIssueId: issue.id,
        jiraIssueKey: issue.key,
        jiraProjectId: issue.fields.project.id,
        jiraCommentId: comment.id,
        jiraCommentUpdated: comment.updated,
        jiraEventId: eventId,
        jiraWebhookEventId: header(headers, "x-atlassian-webhook-identifier"),
        jiraBotId: this.bot.id,
        jiraIntegrationId: this.jiraConfig.id,
        jiraExternalAccountId: sender.accountId,
        jiraRequesterAccountId: sender.accountId,
        botMentioned: mentioned,
        botName: this.bot.displayName,
        conversationType: "channel",
      },
    };
  }

  async sendReply(options: ChatReplyOptions): Promise<string> {
    const issueId = numericId(options.originalMessage.threadId);
    await this.assertIssueBinding(
      issueId,
      options.originalMessage.channelId,
      typeof options.originalMessage.metadata?.jiraCommentId === "string"
        ? options.originalMessage.metadata.jiraCommentId
        : undefined,
    );
    const text = [
      options.text,
      options.conversationUrl,
      options.hint,
      options.footer,
    ]
      .filter(Boolean)
      .join("\n\n");
    const placeholderId =
      options.originalMessage.metadata?.jiraPlaceholderCommentId;
    if (typeof placeholderId === "string") {
      const body = { body: jiraReplyDocument(text) };
      const commentId = await this.replaceComment({
        issueId,
        commentId: placeholderId,
        operationKey: operationKey(options.originalMessage, "reply"),
        body,
        reconcileText: text.trim(),
      });
      if (options.originalMessage.metadata)
        options.originalMessage.metadata.jiraPlaceholderReplaced = true;
      return commentId;
    }
    return this.postComment(
      issueId,
      text,
      operationKey(options.originalMessage, "reply"),
    );
  }

  async setTypingStatus(
    _channelId: string,
    threadId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!metadata || typeof metadata.jiraPlaceholderCommentId === "string")
      return;
    const key =
      typeof metadata.jiraOperationKey === "string"
        ? metadata.jiraOperationKey
        : metadata.jiraEventId;
    if (typeof key !== "string") return;
    metadata.jiraPlaceholderCommentId = await this.postComment(
      numericId(threadId),
      "Thinking…",
      `${key}:placeholder`,
    );
  }

  async clearTypingStatus(
    channelId: string,
    threadId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (metadata?.jiraPlaceholderReplaced === true) return;
    const id = metadata?.jiraPlaceholderCommentId;
    if (typeof id !== "string") return;
    await this.assertIssueBinding(
      numericId(threadId),
      channelId,
      typeof metadata?.jiraCommentId === "string"
        ? metadata.jiraCommentId
        : undefined,
    );
    // Retain the known comment target: deleting it would leave a completed
    // outbox create pointing at a missing comment when this event is retried.
    await this.request(
      `/rest/api/3/issue/${numericId(threadId)}/comment/${numericId(id)}`,
      jiraCommentSchema,
      {
        method: "PUT",
        body: { body: jiraReplyDocument("Processing ended without a reply.") },
      },
    );
    delete metadata?.jiraPlaceholderCommentId;
  }

  async getThreadHistory(
    params: ThreadHistoryParams,
  ): Promise<ChatThreadMessage[]> {
    const issue = await this.getIssue(numericId(params.threadId));
    if (
      issue.fields.security ||
      jiraChannelId(this.bot.id, issue.fields.project.id) !== params.channelId
    )
      return [];
    const limit = Math.max(1, Math.min(params.limit ?? 50, 50));
    const comments = await this.readComments(issue.id, limit);
    const history: ChatThreadMessage[] = [
      {
        messageId: `jira:issue:${issue.id}`,
        senderId: "jira-issue",
        senderName: "Issue context",
        text: `${issue.key}: ${issue.fields.summary}\n\n${jiraMessageText(issue.fields.description)}`,
        timestamp: new Date(0),
        isFromBot: false,
      },
    ];
    for (const comment of comments.reverse()) {
      const excludedCommentId =
        /^jira:[^:]+:[^:]+:(\d+):/.exec(params.excludeMessageId ?? "")?.[1] ??
        params.excludeMessageId;
      if (comment.id === excludedCommentId || comment.visibility) continue;
      history.push({
        messageId: comment.id,
        senderId: comment.author.accountId,
        senderName: comment.author.displayName,
        text: jiraMessageText(comment.body),
        timestamp: new Date(comment.created),
        isFromBot: comment.author.accountId === this.bot.accountId,
      });
    }
    return history;
  }

  async getUserEmail(accountId: string): Promise<string | null> {
    const user = await this.request(
      `/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`,
      jiraUserSchema,
    ).catch((error: unknown) => {
      if (
        error instanceof JiraApiRequestError &&
        [403, 404].includes(error.status)
      )
        return null;
      throw error;
    });
    return user?.emailAddress ?? null;
  }

  async getUserName(accountId: string): Promise<string | null> {
    const user = await this.request(
      `/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`,
      jiraUserSchema,
    );
    return user.displayName;
  }

  identityVerificationFailureText(): string {
    return "Your Jira email is hidden. Ask an administrator to link your identity or configure a restricted service fallback.";
  }

  async getChannelName(channelId: string): Promise<string | null> {
    const projectId = this.projectId(channelId);
    const project = await getJiraProject({
      config: this.jiraConfig,
      bot: this.bot,
      projectId,
    });
    return `${project.key} · ${project.name}`;
  }

  async addApprovalRequestForm(
    options: AddApprovalRequestFormOptions,
  ): Promise<void> {
    const issueId = numericId(options.threadId);
    const text = [
      options.reviewText || `Approval required for ${options.toolName}.`,
      `Review the model session: ${config.frontendBaseUrl}/llm/logs/${encodeURIComponent(`chatops:jira:${issueId}`)}`,
      `Reply “approve ${options.approvalId}” or “decline ${options.approvalId}”. Only the designated reviewer may decide.`,
    ].join("\n\n");
    await this.postComment(
      issueId,
      text,
      `approval:${options.taskId}:${options.approvalId}`,
    );
  }

  async updateApprovalRequest(
    options: UpdateApprovalRequestOptions,
  ): Promise<void> {
    // The manager authorizes against persisted reviewer/task/thread state first.
    // Look up the comment we posted; never treat incoming text as a comment id.
    const prompt = await JiraChatOpsDeliveryModel.findApprovalPrompt({
      integrationId: this.jiraConfig.id,
      botId: this.bot.id,
      approvalId: options.messageKey,
    });
    if (!prompt?.commentId) return;
    await this.assertIssueBinding(prompt.issueId, options.channelId);
    const body = {
      body: jiraReplyDocument(
        `${options.toolName}: ${options.approved ? "Approved" : "Declined"}.${options.decidedByName ? ` Reviewed by ${options.decidedByName}.` : ""}`,
      ),
    };
    await this.replaceComment({
      issueId: prompt.issueId,
      commentId: prompt.commentId,
      operationKey: `${prompt.operationKey}:resolution`,
      body,
      reconcileText: jiraMessageText(body.body),
    });
  }

  parseInteractivePayload(): null {
    return null;
  }

  async sendAgentSelectionCard(): Promise<void> {
    throw new Error(
      "Assign a Jira bot to its agent and project in ChatOps settings.",
    );
  }

  getWorkspaceId(): string {
    return this.jiraConfig.id;
  }
  getWorkspaceName(): string {
    return new URL(this.siteUrl).hostname;
  }
  hasMissingScopes(): boolean {
    return false;
  }
  async notifyMissingScopes(): Promise<void> {}

  async downloadFiles(
    files: ChatThreadMessageFile[],
  ): Promise<ThreadFileOutcome[]> {
    return files.map((file) => ({
      status: "skipped",
      skipped: {
        name: file.name,
        sizeBytes: file.size,
        reason: "download_failed",
      },
    }));
  }

  async discoverChannels(): Promise<DiscoveredChannel[]> {
    // Discovery must not auto-bind every project visible to a broad bot token.
    return [];
  }

  async postRuntimeAttentionNotice(params: {
    channelId: string;
    threadId: string;
    noticeId: string;
    runUrl: string;
  }): Promise<string> {
    await this.assertIssueBinding(numericId(params.threadId), params.channelId);
    return this.postComment(
      params.threadId,
      `Action needed: open ${archestraMcpBranding.appName} UI: ${params.runUrl}`,
      `runtime-attention:${params.noticeId}`,
    );
  }

  async resolveRuntimeAttentionNotice(params: {
    channelId: string;
    threadId: string;
    noticeId: string;
    commentId: string;
    runUrl: string;
  }): Promise<void> {
    const issueId = numericId(params.threadId);
    await this.assertIssueBinding(issueId, params.channelId);
    const body = {
      body: jiraReplyDocument(
        `Resolved. Open ${archestraMcpBranding.appName} UI: ${params.runUrl}`,
      ),
    };
    await this.replaceComment({
      issueId,
      commentId: params.commentId,
      operationKey: `runtime-attention:${params.noticeId}:resolved`,
      body,
      reconcileText: jiraMessageText(body.body),
    });
  }

  private projectId(channelId: string): string {
    const prefix = `${this.bot.id}:`;
    if (!channelId.startsWith(prefix))
      throw new Error("Jira channel belongs to another bot.");
    return numericId(channelId.slice(prefix.length));
  }

  /** Bounded private-install ingress. Events use the same durable inbox and
   * canonical author/mention checks as webhook deliveries. Never infer comment
   * edits from creation ordering: an old comment may have just been edited. */
  async *pollCommentEvents(params: {
    projectIds: string[];
    since: Date;
    until: Date;
  }) {
    if (params.projectIds.length === 0) return;
    const ids = params.projectIds.map(numericId);
    const minutes = Math.max(
      1,
      Math.ceil((Date.now() - params.since.getTime()) / 60_000) + 2,
    );
    let nextPageToken: string | undefined;
    let scannedComments = 0;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        jql: `project in (${ids.join(",")}) AND updated >= -${minutes}m ORDER BY updated ASC, id ASC`,
        fields: "project,labels,security",
        maxResults: "50",
        ...(nextPageToken && { nextPageToken }),
      });
      const issues = await this.request(
        `/rest/api/3/search/jql?${query}`,
        z.object({
          issues: z.array(
            z.object({
              id: z.string().regex(/^\d+$/),
              fields: z.object({
                project: jiraProjectSchema,
                labels: z.array(z.string()).default([]),
                security: z.unknown().optional(),
              }),
            }),
          ),
          nextPageToken: z.string().optional(),
          isLast: z.boolean().optional(),
        }),
      );
      for (const issue of issues.issues) {
        if (!ids.includes(issue.fields.project.id) || issue.fields.security)
          continue;
        if (issue.fields.labels.includes("archestra-mute")) {
          await muteChannelThread({
            provider: "jira",
            channelId: jiraChannelId(this.bot.id, issue.fields.project.id),
            threadId: issue.id,
            scope: this.stateScope,
          });
          continue;
        }
        let startAt = 0;
        for (;;) {
          if (scannedComments >= 5000)
            throw new Error(
              "Jira poll comment limit reached; checkpoint retained",
            );
          const result = await this.request(
            `/rest/api/3/issue/${issue.id}/comment?startAt=${startAt}&maxResults=100&orderBy=created`,
            jiraCommentPageSchema,
          );
          scannedComments += result.comments.length;
          if (scannedComments > 5000)
            throw new Error(
              "Jira poll comment limit reached; checkpoint retained",
            );
          for (const comment of result.comments) {
            const updated = Date.parse(comment.updated);
            if (
              comment.visibility ||
              updated < params.since.getTime() ||
              updated > params.until.getTime()
            )
              continue;
            yield {
              webhookEvent:
                Date.parse(comment.created) === updated
                  ? ("comment_created" as const)
                  : ("comment_updated" as const),
              issue: { id: issue.id },
              comment: { id: comment.id, updated: comment.updated },
            };
          }
          const next = result.startAt + result.comments.length;
          if (next >= result.total) break;
          if (next <= startAt || result.comments.length === 0)
            throw new Error(
              "Incomplete Jira poll comment page; checkpoint retained",
            );
          startAt = next;
        }
      }
      if (!issues.nextPageToken) {
        if (issues.isLast === false)
          throw new Error(
            "Incomplete Jira poll search page; checkpoint retained",
          );
        return;
      }
      if (issues.nextPageToken === nextPageToken)
        throw new Error("Repeated Jira poll cursor; checkpoint retained");
      nextPageToken = issues.nextPageToken;
    }
    throw new Error("Jira poll issue limit reached; checkpoint retained");
  }

  private async getIssue(issueId: string) {
    return this.request(
      `/rest/api/3/issue/${numericId(issueId)}?fields=summary,description,project,labels,security`,
      jiraIssueSchema,
    );
  }

  private async assertIssueBinding(
    issueId: string,
    expectedChannelId?: string,
    originatingCommentId?: string,
  ): Promise<void> {
    const current = await ChatOpsConfigModel.getJiraConfig();
    const currentBot = current?.bots.find((bot) => bot.id === this.bot.id);
    const hidden = await getHiddenMessagingChannels(
      this.jiraConfig.organizationId,
    );
    if (
      !current?.enabled ||
      current.id !== this.jiraConfig.id ||
      current.organizationId !== this.jiraConfig.organizationId ||
      current.siteUrl !== this.siteUrl ||
      !currentBot?.enabled ||
      currentBot.agentId !== this.bot.agentId ||
      currentBot.accountId !== this.bot.accountId ||
      currentBot.cloudId !== this.bot.cloudId ||
      currentBot.apiToken !== this.bot.apiToken ||
      currentBot.email !== this.bot.email ||
      hidden.has("jira")
    )
      throw new Error(
        "The Jira bot is no longer enabled for this integration.",
      );
    const issue = await this.getIssue(issueId);
    if (originatingCommentId) {
      const comment = await this.request(
        `/rest/api/3/issue/${numericId(issueId)}/comment/${numericId(originatingCommentId)}`,
        jiraCommentSchema,
      );
      if (comment.visibility)
        throw new Error(
          "Restricted Jira comments are not supported by this bot.",
        );
    }
    const channelId = jiraChannelId(this.bot.id, issue.fields.project.id);
    const binding = await ChatOpsChannelBindingModel.findByChannel({
      provider: "jira",
      channelId,
      workspaceId: this.jiraConfig.id,
    });
    if (
      !this.isConfigured() ||
      issue.fields.security ||
      issue.fields.labels.includes("archestra-mute") ||
      (expectedChannelId && expectedChannelId !== channelId) ||
      !binding ||
      binding.agentId !== this.bot.agentId ||
      binding.organizationId !== this.jiraConfig.organizationId
    )
      throw new Error(
        "The Jira issue is no longer available through this bot's project binding.",
      );
  }

  private async readComments(issueId: string, limit: number) {
    const comments: z.infer<typeof jiraCommentSchema>[] = [];
    let startAt = 0;
    for (let page = 0; page < 4 && comments.length < limit; page++) {
      const result = await this.request(
        `/rest/api/3/issue/${numericId(issueId)}/comment?startAt=${startAt}&maxResults=${Math.min(limit - comments.length, 50)}&orderBy=-created&expand=properties`,
        jiraCommentPageSchema,
      );
      comments.push(...result.comments);
      if (
        result.comments.length === 0 ||
        result.startAt + result.comments.length >= result.total
      )
        break;
      startAt = result.startAt + result.comments.length;
    }
    return comments.slice(0, limit);
  }

  private async replaceComment(params: {
    issueId: string;
    commentId: string;
    operationKey: string;
    body: { body: ReturnType<typeof jiraReplyDocument> };
    reconcileText: string;
  }): Promise<string> {
    const path = `/rest/api/3/issue/${numericId(params.issueId)}/comment/${numericId(params.commentId)}`;
    return executeJiraChatOpsOutbound({
      integrationId: this.jiraConfig.id,
      botId: this.bot.id,
      issueId: params.issueId,
      operationKey: params.operationKey,
      method: "replace",
      body: params.body,
      send: async () =>
        (
          await this.request(path, jiraCommentSchema, {
            method: "PUT",
            body: params.body,
          })
        ).id,
      reconcile: async () => {
        const existing = await this.request(path, jiraCommentSchema);
        return jiraMessageText(existing.body) === params.reconcileText
          ? existing.id
          : null;
      },
    });
  }

  private async postComment(
    issueId: string,
    text: string,
    key: string,
  ): Promise<string> {
    await this.assertIssueBinding(issueId);
    const body = { body: jiraReplyDocument(text) };
    return executeJiraChatOpsOutbound({
      integrationId: this.jiraConfig.id,
      botId: this.bot.id,
      issueId,
      operationKey: key,
      body,
      send: async (operationId) =>
        (
          await this.request(
            `/rest/api/3/issue/${numericId(issueId)}/comment`,
            jiraCommentSchema,
            {
              method: "POST",
              body: {
                ...body,
                properties: [
                  {
                    key: "archestra.operation",
                    value: { operationId },
                  },
                ],
              },
            },
          )
        ).id,
      reconcile: async (operationId) => {
        const comments = await this.readComments(issueId, 100);
        return (
          comments.find(
            (comment) =>
              comment.author.accountId === this.bot.accountId &&
              comment.properties?.some(
                (property) =>
                  property.key === "archestra.operation" &&
                  typeof property.value === "object" &&
                  property.value !== null &&
                  "operationId" in property.value &&
                  property.value.operationId === operationId,
              ),
          )?.id ?? null
        );
      },
    });
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options?: { method: "POST" | "PUT" | "DELETE"; body?: unknown },
  ): Promise<T> {
    return jiraRequest({
      siteUrl: this.siteUrl,
      email: this.bot.email,
      apiToken: this.bot.apiToken,
      cloudId: this.bot.cloudId,
      path,
      schema,
      ...options,
    });
  }
}

export function jiraChannelId(botId: string, projectId: string): string {
  return `${botId}:${numericId(projectId)}`;
}

export async function verifyJiraBotIdentity(params: {
  siteUrl: string;
  email: string;
  apiToken: string;
  tokenType?: "classic" | "scoped";
}): Promise<{
  accountId: string;
  displayName: string;
  email?: string;
  cloudId?: string;
}> {
  const cloudId =
    params.tokenType === "scoped"
      ? await discoverJiraCloudId(params.siteUrl)
      : undefined;
  const user = await jiraRequest({
    ...params,
    cloudId,
    path: "/rest/api/3/myself",
    schema: jiraUserSchema,
  });
  if (user.active === false)
    throw new Error("The Jira bot account is inactive.");
  // Organization-managed service accounts can be returned as accountType
  // "app". The authenticated /myself principal and active state identify the
  // bot; rejecting this presentation field rejects legitimate service tokens.
  // Inbound app comments are still excluded to prevent bot-to-bot loops.
  return {
    accountId: user.accountId,
    displayName: user.displayName,
    ...(user.emailAddress && { email: user.emailAddress }),
    ...(cloudId && { cloudId }),
  };
}

export async function listJiraProjects(params: {
  config: JiraDbConfig;
  bot: JiraBotConfig;
}): Promise<z.infer<typeof jiraProjectSchema>[]> {
  const projects: z.infer<typeof jiraProjectSchema>[] = [];
  for (let startAt = 0; startAt < 500; startAt += 50) {
    const result = await jiraRequest({
      siteUrl: params.config.siteUrl,
      email: params.bot.email,
      apiToken: params.bot.apiToken,
      cloudId: params.bot.cloudId,
      path: `/rest/api/3/project/search?startAt=${startAt}&maxResults=50`,
      schema: z.object({
        values: z.array(jiraProjectSchema),
        isLast: z.boolean(),
      }),
    });
    projects.push(...result.values);
    if (result.isLast || result.values.length === 0) break;
  }
  return projects;
}

export async function getJiraProject(params: {
  config: JiraDbConfig;
  bot: JiraBotConfig;
  projectId: string;
}): Promise<z.infer<typeof jiraProjectSchema>> {
  return jiraRequest({
    siteUrl: params.config.siteUrl,
    email: params.bot.email,
    apiToken: params.bot.apiToken,
    cloudId: params.bot.cloudId,
    path: `/rest/api/3/project/${numericId(params.projectId)}`,
    schema: jiraProjectSchema,
  });
}

// === Internal helpers ===

const jiraUserSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string(),
  emailAddress: z.string().email().optional(),
  accountType: z.string().optional(),
  active: z.boolean().optional(),
});
const jiraProjectSchema = z.object({
  id: z.string().regex(/^\d+$/),
  key: z.string(),
  name: z.string(),
});
const jiraDateSchema = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Invalid Jira timestamp",
  );
const jiraCommentSchema = z.object({
  id: z.string().regex(/^\d+$/),
  body: z.unknown(),
  author: jiraUserSchema,
  updateAuthor: jiraUserSchema.optional(),
  created: jiraDateSchema,
  updated: jiraDateSchema,
  visibility: z.unknown().optional(),
  properties: z
    .array(z.object({ key: z.string(), value: z.unknown() }))
    .optional(),
});
const jiraCommentPageSchema = z.object({
  comments: z.array(jiraCommentSchema),
  startAt: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const jiraIssueSchema = z.object({
  id: z.string().regex(/^\d+$/),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.unknown().optional(),
    project: jiraProjectSchema,
    labels: z.array(z.string()).default([]),
    security: z.unknown().optional(),
  }),
});
async function jiraRequest<T>(params: {
  siteUrl: string;
  email: string;
  apiToken: string;
  cloudId?: string;
  path: string;
  schema: z.ZodType<T>;
  method?: "POST" | "PUT" | "DELETE";
  body?: unknown;
}): Promise<T> {
  const siteOrigin = normalizeJiraSiteUrl(params.siteUrl);
  if (
    !params.path.startsWith("/rest/api/3/") ||
    params.path.includes("\\") ||
    params.path.includes("#")
  )
    throw new Error("Invalid Jira API path.");
  const cloudId =
    params.cloudId !== undefined
      ? z.string().uuid().parse(params.cloudId).toLowerCase()
      : undefined;
  const origin = cloudId ? "https://api.atlassian.com" : siteOrigin;
  const url = new URL(
    cloudId ? `/ex/jira/${cloudId}${params.path}` : params.path,
    origin,
  );
  if (url.origin !== origin) throw new Error("Invalid Jira API origin.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: params.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${params.email}:${params.apiToken}`).toString("base64")}`,
        Accept: "application/json",
        ...(params.body !== undefined && {
          "Content-Type": "application/json",
        }),
      },
      ...(params.body !== undefined && { body: JSON.stringify(params.body) }),
    });
    if (response.status === 429 && !params.method && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 2)
        throw new Error("Jira rate limit reached; retry this operation later.");
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 && params.method)
        throw new JiraOutboundRejectedError(429);
      throw new JiraApiRequestError(response.status);
    }
    if (response.status === 204) return params.schema.parse(undefined);
    return params.schema.parse(await response.json());
  }
  throw new Error("Jira rate limit reached; retry this operation later.");
}

async function discoverJiraCloudId(siteUrl: string): Promise<string> {
  const origin = normalizeJiraSiteUrl(siteUrl);
  const response = await fetch(`${origin}/_edge/tenant_info`, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Could not resolve this Jira Cloud site's identifier.");
  }
  const tenant = z
    .object({ cloudId: z.string().uuid() })
    .parse(await response.json());
  return tenant.cloudId.toLowerCase();
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return typeof value === "string" ? value : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function numericId(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value))
    throw new Error("Invalid Jira identifier.");
  return value;
}

function operationKey(message: IncomingChatMessage, kind: string): string {
  return `${typeof message.metadata?.jiraOperationKey === "string" ? message.metadata.jiraOperationKey : message.metadata?.jiraEventId || message.messageId}:${kind}`;
}

export class JiraApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`Jira API request failed (${status}).`);
  }
}
