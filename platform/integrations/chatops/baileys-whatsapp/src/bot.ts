import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import { deleteHSetKeys, useRedisAuthStateWithHSet } from 'baileys-redis-auth'
import http from 'http'
import { Redis, type RedisOptions } from 'ioredis'
import P from 'pino'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { renderConnectedHtml, renderQrPageHtml } from './connection-page-html.js'
import {
  createGenericClientFromEnv,
  createReplyContext,
  type AgentOption,
  normalizeBaileysMessage,
} from './generic-client.js'
import { BotState } from './state.js'

const REDIS_URL = process.env.REDIS_URL
const ADAPTER_ID = process.env.ARCHSTRA_CHATOPS_ADAPTER_ID ?? 'whatsapp'
const INCOMING_SECRET = process.env.ARCHSTRA_CHATOPS_INCOMING_SECRET ?? ''
const SESSION_ID = 'archestra-whatsapp'
const logger = P({ level: 'silent' })
const CONNECTION_SERVER_PORT = parseInt(process.env.CONNECTION_SERVER_PORT ?? '3100', 10)

if (!REDIS_URL) {
  throw new Error('REDIS_URL environment variable is required for WhatsApp auth state')
}
if (!INCOMING_SECRET) {
  throw new Error('ARCHSTRA_CHATOPS_INCOMING_SECRET environment variable is required')
}

const genericClient = createGenericClientFromEnv(ADAPTER_ID, INCOMING_SECRET)

function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname.length > 1 ? parseInt(parsed.pathname.slice(1), 10) : 0,
  }
}

const sentMessageIds = new Set<string>()
let activeSock: ReturnType<typeof makeWASocket> | null = null
let currentQr: string | null = null
let currentQrDataUrl: string | null = null
let isConnected = false
let authRedisInstance: Redis | null = null
let botState: BotState | null = null

const AGENT_CACHE_TTL_MS = 5 * 60 * 1000
const agentCache = new Map<string, { agents: AgentOption[]; fetchedAt: number }>()

const BOT_NAME = process.env.ARCHESTRA_BOT_NAME ?? 'Archestra'

async function resolvePhone(jid: string): Promise<string> {
  if (jid.endsWith('@lid') && activeSock?.signalRepository?.lidMapping) {
    try {
      const pn = await activeSock.signalRepository.lidMapping.getPNForLID(jid)
      if (pn) return pn.split('@')[0].split(':')[0]
    } catch {}
  }
  return jid.split('@')[0]
}

function sendText(jid: string, text: string) {
  const result = activeSock!.sendMessage(jid, { text })
  result.then(r => { if (r?.key?.id) sentMessageIds.add(r.key.id) }).catch(() => {})
  return result
}

function buildAgentListText(agents: AgentOption[], currentAgentId: string | null): string {
  const lines = agents.map((a, i) => {
    const isCurrent = a.id === currentAgentId
    return isCurrent
      ? `${i + 1}. 🟢 ${a.name} ← current`
      : `${i + 1}. ${a.name}`
  })
  const header = '🤖 Available agents:\n'
  const footer = '\n\nSend "AgentName > message" to switch agents.'
  return header + lines.join('\n') + (agents.length > 0 ? footer : '')
}

async function findAgentByName(name: string, jid: string): Promise<AgentOption | null> {
  const now = Date.now()
  const cached = agentCache.get(jid)
  const isDm = !jid.includes('@g.us')
  if (!cached || now - cached.fetchedAt > AGENT_CACHE_TTL_MS) {
    const agents = await genericClient.listAgents({ senderExternalId: await resolvePhone(jid), isDm })
    if (agents.length === 0) return null
    agentCache.set(jid, { agents, fetchedAt: now })
  }
  const normalized = name.toLowerCase().replace(/\s+/g, '')
  for (const agent of agentCache.get(jid)!.agents) {
    if (agent.name.toLowerCase().replace(/\s+/g, '') === normalized) {
      return agent
    }
  }
  return null
}

async function unlinkDevice() {
  isConnected = false
  currentQr = null
  currentQrDataUrl = null
  if (authRedisInstance) {
    try {
      await deleteHSetKeys({ redis: authRedisInstance, sessionId: SESSION_ID })
    } catch {
      // redis keys may not exist
    }
  }
  void startSock()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${CONNECTION_SERVER_PORT}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
    return
  }

  if (url.pathname === '/qr') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ qr: currentQr, qrDataUrl: currentQrDataUrl, connected: isConnected }))
    return
  }

  if (url.pathname === '/unlink' && req.method === 'POST') {
    void unlinkDevice()
    res.writeHead(302, { Location: '/' })
    res.end()
    return
  }

  if (url.pathname === '/hitl' && req.method === 'POST') {
    try {
      if (!activeSock) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'WhatsApp not connected' }))
        return
      }
      const body = JSON.parse(await readBody(req))
      const result = await sendText(body.jid, body.messageText)
      if (!result?.key?.id) throw new Error('Failed to send message')
      await botState?.setPendingHitl(result.key.id, {
        taskId: body.actionId,
        approvalId: body.actionId,
        replyContext: createReplyContext(body.jid),
        adapterId: ADAPTER_ID,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, messageId: result.key.id }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
    return
  }

  if (url.pathname === '/reply' && req.method === 'POST') {
    try {
      if (!activeSock || !isConnected) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'WhatsApp not connected' }))
        return
      }
      const body = JSON.parse(await readBody(req))
      console.log(`[Callback /reply] deliveryId=${body.deliveryId}`)
      const { jid } = body.replyContext ?? {}
      if (!jid) throw new Error('replyContext.jid is required')
      const approvalRequest = body.metadata?.approvalRequest
      let text = body.footer ? `${body.text}\n\n${body.footer}` : body.text
      if (approvalRequest) {
        text = `🔧 Tool: ${approvalRequest.toolName ?? 'unknown'}\n👍 = Approve, 👎 = Reject`
      }
      const sent = await sendText(jid, text)
      if (sent?.key?.id && approvalRequest) {
        await botState?.setPendingHitl(sent.key.id, {
          taskId: approvalRequest.taskId,
          approvalId: approvalRequest.approvalId,
          replyContext: body.replyContext,
          adapterId: ADAPTER_ID,
        })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[Callback /reply] error: ${message}`)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
    return
  }

  if (url.pathname === '/agent-selection' && req.method === 'POST') {
    try {
      if (!activeSock || !isConnected) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'WhatsApp not connected' }))
        return
      }
      const body = JSON.parse(await readBody(req))
      console.log(`[Callback /agent-selection] deliveryId=${body.deliveryId} agents=${body.agents?.length}`)
      const { jid } = body.replyContext ?? {}
      if (!jid) throw new Error('replyContext.jid is required')
      const header = body.isWelcome ? 'Welcome! Please select an agent:' : 'Select an agent:'
      const agentList = (body.agents as { id: string; name: string }[])
        .map((a, i) => `${i + 1}. ${a.name}`)
        .join('\n')
      const text = body.text ? `${body.text}\n\n${agentList}` : `${header}\n\n${agentList}`
      await sendText(jid, text)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[Callback /agent-selection] error: ${message}`)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
    return
  }

  if (url.pathname === '/typing' && req.method === 'POST') {
    console.log('[Callback /typing] no-op (WhatsApp bots cannot show typing indicator)')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(isConnected ? renderConnectedHtml() : renderQrPageHtml(currentQrDataUrl))
})

server.listen(CONNECTION_SERVER_PORT, () => {
  console.log(`Connection page server listening on port ${CONNECTION_SERVER_PORT}`)
})

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

async function updateQrDataUrl(qr: string) {
  currentQr = qr
  try {
    currentQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
  } catch {
    currentQrDataUrl = null
  }
}

async function startSock() {
  const redisOptions = parseRedisUrl(REDIS_URL!)
  const { state, saveCreds, redis } = await useRedisAuthStateWithHSet(
    redisOptions,
    SESSION_ID,
    (msg: string) => logger.debug(msg),
  )
  authRedisInstance = redis
  botState = new BotState(redis)
  const { version } = await fetchLatestBaileysVersion()

  activeSock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  })

  activeSock.ev.on('creds.update', saveCreds)

  activeSock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcodeTerminal.generate(qr, { small: true })
      void updateQrDataUrl(qr)
    }

    if (connection === 'open') {
      isConnected = true
      currentQr = null
      currentQrDataUrl = null
      console.log('WhatsApp connected')
    }

    if (connection === 'close') {
      isConnected = false
      activeSock = null
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode

      if (statusCode !== DisconnectReason.loggedOut) {
        void startSock()
      } else {
        console.log('Logged out. Clearing Redis auth state and re-pairing the device.')
        if (authRedisInstance) {
          deleteHSetKeys({ redis: authRedisInstance, sessionId: SESSION_ID }).then(() => {
            void startSock()
          })
        } else {
          void startSock()
        }
      }
    }
  })

  activeSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message) continue

      if (msg.message.reactionMessage) {
        const reactionKeyId = msg.message.reactionMessage.key?.id
        const emoji = msg.message.reactionMessage.text
        if (reactionKeyId && botState) {
          const entry = await botState.getAndDeletePendingHitl(reactionKeyId)
          if (entry && (emoji === '👍' || emoji === '👎')) {
            const approved = emoji === '👍'
            const jid = msg.key.remoteJid
            if (jid) {
              console.log(
                `[HITL ${approved ? 'Approved' : 'Rejected'}] taskId=${entry.taskId} approvalId=${entry.approvalId}`,
              )
              try {
                await genericClient.sendApprovalDecision({
                  messageId: `hitl-${Date.now()}`,
                  sender: {
                    externalId: await resolvePhone(jid),
                    name: msg.pushName ?? '',
                  },
                  channel: {
                    externalId: jid,
                    kind: jid.includes('@g.us') ? 'channel' : 'dm',
                  },
                  text: approved ? 'Approved' : 'Rejected',
                  rawText: approved ? 'Approved' : 'Rejected',
                  timestamp: new Date().toISOString(),
                  isThreadReply: false,
                  replyContext: entry.replyContext,
                  taskId: entry.taskId,
                  approvalDecisions: [
                    { approvalId: entry.approvalId, approved },
                  ],
                })
              } catch (err) {
                console.error(
                  `[HITL] sendApprovalDecision failed: ${err instanceof Error ? err.message : err}`,
                )
              }
            }
          }
        }
        continue
      }

      if (sentMessageIds.has(msg.key.id ?? '')) {
        sentMessageIds.delete(msg.key.id ?? '')
        continue
      }

      const jid = msg.key.remoteJid
      if (!jid) continue
      const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
      if (!rawText) continue

      const mentionTrigger = `@${BOT_NAME.toLowerCase()}`
      const trimmedRaw = rawText.trim().toLowerCase()

      if (trimmedRaw === mentionTrigger) {
        try {
          console.log(`[@${BOT_NAME}] mention detected from=${jid}`)
    const agents = await genericClient.listAgents({ senderExternalId: await resolvePhone(jid), isDm: !jid.includes('@g.us') })
          console.log(`[@${BOT_NAME}] listAgents returned ${agents.length} agents`)
          if (agents.length === 0) {
            await sendText(jid, 'Ваш номер не привязан к аккаунту. Обратитесь к администратору для привязки.')
            continue
          }
          const currentAgentId = await botState?.getAgentForJid(jid) ?? null
          const text = buildAgentListText(agents, currentAgentId)
          await sendText(jid, text)
          console.log(`[@${BOT_NAME}] sent agent list to ${jid}`)
        } catch (err) {
          console.error(`[@${BOT_NAME}] error: ${err instanceof Error ? err.message : err}`)
        }
        continue
      }

      let processedText = rawText
      if (trimmedRaw.startsWith(`${mentionTrigger} `)) {
        processedText = rawText.trim().slice(mentionTrigger.length + 1).trim()
      }

      let selectedAgentId: string | null = await botState?.getAgentForJid(jid) ?? null
      let messageText = processedText

      const delimiterIndex = rawText.indexOf('>')
      if (delimiterIndex !== -1) {
        const potentialAgentName = rawText.slice(0, delimiterIndex).trim()
        const afterDelimiter = rawText.slice(delimiterIndex + 1).trim()

        if (potentialAgentName) {
          const agent = await findAgentByName(potentialAgentName, jid)
          if (agent) {
            await botState?.setAgentForJid(jid, agent.id)
            if (!afterDelimiter) {
              await sendText(jid, `✅ Agent switched to ${agent.name}`)
              continue
            }
            messageText = afterDelimiter
            selectedAgentId = agent.id
          }
        }
      }

      const params = normalizeBaileysMessage({
        msg,
        text: messageText,
        senderExternalId: await resolvePhone(jid),
      })
      if (selectedAgentId) {
        params.metadata = { agentId: selectedAgentId }
      }

      try {
        await genericClient.sendMessage(params)
        console.log(`[Agent Message] from=${jid} text="${messageText}"`)
      } catch (err) {
        console.error(`[Agent Message] failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  })

  return activeSock
}

void startSock()
