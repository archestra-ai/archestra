import crypto from 'crypto'
import P from 'pino'

const logger = P({ level: 'silent' })

// === Exported types ===

export interface Sender {
  externalId: string
  email?: string
  name: string
}

export interface Channel {
  externalId: string
  name?: string | null
  kind: 'dm' | 'channel' | 'group'
}

export interface Workspace {
  externalId: string
  name?: string | null
}

export interface Thread {
  externalId: string
}

export interface A2AAttachment {
  contentType: string
  contentBase64: string
  name?: string
}

export interface HistoryFileRef {
  fileId: string
  mimeType: string
  name?: string
  size?: number
}

export interface HistoryMessage {
  messageId: string
  senderId: string
  senderName: string
  text: string
  timestamp: string
  isFromBot: boolean
  files?: HistoryFileRef[]
}

export interface AgentOption {
  id: string
  name: string
}

export interface SendMessageParams {
  messageId: string
  sender: Sender
  channel: Channel
  text: string
  rawText: string
  timestamp: string
  isThreadReply: boolean
  replyContext: unknown
  workspace?: Workspace | null
  thread?: Thread | null
  attachments?: A2AAttachment[]
  threadHistory?: HistoryMessage[]
  metadata?: Record<string, unknown>
}

export interface SendInteractiveParams {
  eventId: string
  agentId: string
  sender: Sender
  channel: Channel
  timestamp: string
  replyContext: unknown
  workspace?: Workspace | null
  thread?: Thread | null
  metadata?: Record<string, unknown>
}

export interface SendApprovalDecisionParams {
  messageId: string
  sender: Sender
  channel: Channel
  text: string
  rawText: string
  timestamp: string
  isThreadReply: boolean
  replyContext: unknown
  taskId: string
  approvalDecisions: Array<{ approvalId: string; approved: boolean }>
  workspace?: Workspace | null
  thread?: Thread | null
}

export interface SyncChannelsParams {
  workspace: Workspace
  channels: Array<{
    externalId: string
    name?: string | null
    kind: 'dm' | 'channel' | 'group'
    dmOwnerEmail?: string | null
  }>
}

export interface ChannelSyncResponse {
  ok: true
  upserted: number
  deleted: number
  deduplicated: number
}

// === Exported helpers ===

export function createReplyContext(jid: string): { jid: string } {
  return { jid }
}

export function normalizeBaileysMessage(params: {
  msg: {
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null }
    message?: unknown
    pushName?: string | null
  }
  senderEmail?: string
  senderExternalId?: string
  text: string
}): SendMessageParams {
  const { msg, senderEmail, senderExternalId, text } = params
  const jid = msg.key.remoteJid ?? ''
  const messageId = msg.key.id ?? ''
  const isDm = !jid.includes('@g.us')
  const channelKind: Channel['kind'] = isDm ? 'dm' : 'channel'
  const senderName = msg.pushName ?? senderEmail ?? ''

  return {
    messageId,
    sender: {
      externalId: senderExternalId ?? jid.split('@')[0],
      ...(senderEmail && { email: senderEmail }),
      name: senderName,
    },
    channel: {
      externalId: jid,
      kind: channelKind,
    },
    text,
    rawText: text,
    timestamp: new Date().toISOString(),
    isThreadReply: false,
    replyContext: createReplyContext(jid),
  }
}

// === Exported factory ===

export function createGenericClientFromEnv(
  adapterId: string,
  incomingSecret: string,
): GenericClient {
  const baseUrl = process.env.ARCHESTRA_BACKEND_URL ?? 'http://localhost:9000'
  return new GenericClient(baseUrl, adapterId, incomingSecret)
}

// === GenericClient class ===

export class GenericClient {
  private readonly baseUrl: string
  private readonly adapterId: string
  private readonly incomingSecret: string

  constructor(baseUrl: string, adapterId: string, incomingSecret: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.adapterId = adapterId
    this.incomingSecret = incomingSecret
  }

  async sendMessage(params: SendMessageParams): Promise<void> {
    await this.post('/messages', {
      schemaVersion: 'v1',
      messageId: params.messageId,
      sender: params.sender,
      channel: params.channel,
      text: params.text,
      rawText: params.rawText,
      timestamp: params.timestamp,
      isThreadReply: params.isThreadReply,
      replyContext: params.replyContext,
      ...(params.workspace != null && { workspace: params.workspace }),
      ...(params.thread != null && { thread: params.thread }),
      ...(params.attachments?.length && { attachments: params.attachments }),
      ...(params.threadHistory?.length && { threadHistory: params.threadHistory }),
      ...(params.metadata && { metadata: params.metadata }),
    })
  }

  async sendInteractive(params: SendInteractiveParams): Promise<void> {
    await this.post('/interactive', {
      schemaVersion: 'v1',
      eventId: params.eventId,
      action: 'select-agent',
      agentId: params.agentId,
      sender: params.sender,
      channel: params.channel,
      timestamp: params.timestamp,
      replyContext: params.replyContext,
      ...(params.workspace != null && { workspace: params.workspace }),
      ...(params.thread != null && { thread: params.thread }),
      ...(params.metadata && { metadata: params.metadata }),
    })
  }

  async sendApprovalDecision(params: SendApprovalDecisionParams): Promise<void> {
    await this.post('/messages', {
      schemaVersion: 'v1',
      messageId: params.messageId,
      sender: params.sender,
      channel: params.channel,
      text: params.text,
      rawText: params.rawText,
      timestamp: params.timestamp,
      isThreadReply: params.isThreadReply,
      replyContext: params.replyContext,
      ...(params.workspace != null && { workspace: params.workspace }),
      ...(params.thread != null && { thread: params.thread }),
      metadata: { taskId: params.taskId, approvalDecisions: params.approvalDecisions },
    })
  }

  async syncChannels(params: SyncChannelsParams): Promise<ChannelSyncResponse | null> {
    return this.post<ChannelSyncResponse>('/channels/sync', {
      schemaVersion: 'v1',
      syncMode: 'full',
      workspace: params.workspace,
      channels: params.channels,
    })
  }

  async listAgents(params?: {
    senderEmail?: string
    senderExternalId?: string
    isDm?: boolean
  }): Promise<AgentOption[]> {
    const url = new URL(
      `/api/webhooks/chatops/generic/${this.adapterId}/agents`,
      this.baseUrl,
    )
    if (params?.senderEmail) {
      url.searchParams.set('senderEmail', params.senderEmail)
    }
    if (params?.senderExternalId) {
      url.searchParams.set('senderExternalId', params.senderExternalId)
    }
    if (params?.isDm !== undefined) {
      url.searchParams.set('isDm', String(params.isDm))
    }

    try {
      const res = await fetch(url, { method: 'GET' })
      if (!res.ok) {
        logger.error(
          { status: res.status, url: url.toString() },
          'listAgents request failed',
        )
        return []
      }
      const data = (await res.json()) as { agents?: AgentOption[] }
      return data.agents ?? []
    } catch (err) {
      logger.error({ err }, 'listAgents request error')
      return []
    }
  }

  // === Private methods ===

  private async post<T = void>(path: string, body: unknown): Promise<T | null> {
    const url = `${this.baseUrl}/api/webhooks/chatops/generic/${this.adapterId}${path}`
    const rawBody = JSON.stringify(body)
    const { timestamp, signature } = this.signPayload(rawBody)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archestra-timestamp': timestamp,
          'x-archestra-signature': signature,
        },
        body: rawBody,
      })

      if (!res.ok) {
        logger.error(
          { status: res.status, adapterId: this.adapterId, path },
          'GenericClient POST failed',
        )
        return null
      }

      const contentLength = res.headers.get('content-length')
      if (res.status === 204 || contentLength === '0') {
        return null
      }

      return (await res.json()) as T
    } catch (err) {
      logger.error(
        { err, adapterId: this.adapterId, path },
        'GenericClient POST error',
      )
      return null
    }
  }

  private signPayload(rawBody: string): {
    timestamp: string
    signature: string
  } {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signaturePayload = `${timestamp}.${rawBody}`
    const hmac = crypto.createHmac('sha256', this.incomingSecret)
    hmac.update(signaturePayload)
    const signature = `v1=${hmac.digest('hex')}`
    return { timestamp, signature }
  }
}
