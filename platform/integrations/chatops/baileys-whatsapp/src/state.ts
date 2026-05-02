import { type Redis } from 'ioredis'

type HitlPending = {
  taskId: string
  approvalId: string
  replyContext: unknown
  adapterId: string
}

type ThinkingKey = {
  id: string
  remoteJid: string
  fromMe?: boolean
  participant?: string
}

const AGENT_KEY_PREFIX = 'wa:agent:'
const HITL_KEY_PREFIX = 'wa:hitl:'
const THINKING_KEY_PREFIX = 'wa:thinking:'
const AGENT_TTL_SECONDS = 30 * 24 * 60 * 60
const HITL_TTL_SECONDS = 24 * 60 * 60
const THINKING_TTL_SECONDS = 24 * 60 * 60

class BotState {
  private redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
  }

  async setAgentForJid(jid: string, agentId: string): Promise<void> {
    await this.redis.set(AGENT_KEY_PREFIX + jid, agentId, 'EX', AGENT_TTL_SECONDS)
  }

  async getAgentForJid(jid: string): Promise<string | null> {
    return this.redis.get(AGENT_KEY_PREFIX + jid)
  }

  async setPendingHitl(sentMsgId: string, data: HitlPending): Promise<void> {
    await this.redis.set(HITL_KEY_PREFIX + sentMsgId, JSON.stringify(data), 'EX', HITL_TTL_SECONDS)
  }

  async getAndDeletePendingHitl(reactionKeyId: string): Promise<HitlPending | null> {
    const key = HITL_KEY_PREFIX + reactionKeyId
    const results = await this.redis.multi().get(key).del(key).exec()
    if (!results) return null
    const [getError, raw] = results[0]
    if (getError || !raw) return null
    return JSON.parse(raw as string) as HitlPending
  }

  async pushThinking(jid: string, msgKey: ThinkingKey): Promise<void> {
    const key = THINKING_KEY_PREFIX + jid
    await this.redis.rpush(key, JSON.stringify(msgKey))
    await this.redis.expire(key, THINKING_TTL_SECONDS)
  }

  async popThinking(jid: string): Promise<ThinkingKey | null> {
    const raw = await this.redis.lpop(THINKING_KEY_PREFIX + jid)
    if (!raw) return null
    return JSON.parse(raw) as ThinkingKey
  }

  async cleanup(): Promise<void> {
    await this.redis.quit()
  }
}

export { BotState }
export type { HitlPending, ThinkingKey }
