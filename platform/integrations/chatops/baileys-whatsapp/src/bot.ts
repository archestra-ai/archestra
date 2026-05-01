import { Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import path from 'path'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_FOLDER = path.join(__dirname, '..', 'baileys_auth_info')
const logger = P({ level: 'silent' })

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
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      console.log('WhatsApp connected')
    }

    if (connection === 'close') {
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