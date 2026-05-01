import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import http from 'http'
import { rmSync } from 'node:fs'
import path from 'path'
import P from 'pino'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { fileURLToPath } from 'url'
import { renderConnectedHtml, renderQrPageHtml } from './connection-page-html.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_FOLDER = path.join(__dirname, '..', 'baileys_auth_info')
const logger = P({ level: 'silent' })
const CONNECTION_SERVER_PORT = parseInt(process.env.CONNECTION_SERVER_PORT ?? '3100', 10)

let currentQr: string | null = null
let currentQrDataUrl: string | null = null
let isConnected = false

function unlinkDevice() {
  isConnected = false
  currentQr = null
  currentQrDataUrl = null
  try {
    rmSync(AUTH_FOLDER, { recursive: true, force: true })
  } catch {
    // auth folder may not exist
  }
  void startSock()
}

const server = http.createServer((req, res) => {
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
    unlinkDevice()
    res.writeHead(302, { Location: '/' })
    res.end()
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(isConnected ? renderConnectedHtml() : renderQrPageHtml(currentQrDataUrl))
})

server.listen(CONNECTION_SERVER_PORT, () => {
  console.log(`Connection page server listening on port ${CONNECTION_SERVER_PORT}`)
})

async function updateQrDataUrl(qr: string) {
  currentQr = qr
  try {
    currentQrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
  } catch {
    currentQrDataUrl = null
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
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
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode

      if (statusCode !== DisconnectReason.loggedOut) {
        void startSock()
      } else {
        console.log('Logged out. Delete auth folder and re-pair the device.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message) continue

      const jid = msg.key.remoteJid
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

      console.log({ jid, text })
    }
  })

  return sock
}

void startSock()
