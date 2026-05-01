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

const REDIS_URL = process.env.REDIS_URL
const SESSION_ID = 'archestra-whatsapp'
const logger = P({ level: 'silent' })
const CONNECTION_SERVER_PORT = parseInt(process.env.CONNECTION_SERVER_PORT ?? '3100', 10)

if (!REDIS_URL) {
  throw new Error('REDIS_URL environment variable is required for WhatsApp auth state')
}

function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname.length > 1 ? parseInt(parsed.pathname.slice(1), 10) : 0,
  }
}

let activeSock: ReturnType<typeof makeWASocket> | null = null
let currentQr: string | null = null
let currentQrDataUrl: string | null = null
let isConnected = false
let authRedisInstance: Redis | null = null
const pendingHitl = new Map<string, { actionId: string; actionDescription: string }>()

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
      const result = await activeSock.sendMessage(body.jid, { text: body.messageText })
      if (!result?.key?.id) throw new Error('Failed to send message')
      pendingHitl.set(result.key.id, { actionId: body.actionId, actionDescription: body.actionDescription })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, messageId: result.key.id }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
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
        if (reactionKeyId) {
          const entry = pendingHitl.get(reactionKeyId)
          if (entry && pendingHitl.delete(reactionKeyId)) {
            if (emoji === '👍') {
              console.log(`[HITL Approved] actionId=${entry.actionId} action="${entry.actionDescription}"`)
            } else if (emoji === '👎') {
              console.log(`[HITL Rejected] actionId=${entry.actionId} action="${entry.actionDescription}"`)
            }
          }
        }
        continue
      }

      if (msg.key.fromMe) continue

      const jid = msg.key.remoteJid
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

      console.log(`[Agent Message] from=${jid} text="${text}"`)
    }
  })

  return activeSock
}

void startSock()
