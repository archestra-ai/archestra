/**
 * Retrieves and verifies QR code from podman container logs of a local WhatsApp MCP connector
 */
import log from '@backend/utils/logger';
import WebSocketService from '@backend/websocket';

import { type GetLogs, type LogMonitor } from './mcp-setup-registry';

type MatcherFunction = (logs: string) => { match: string; date?: Date } | false;

/**
 * Monitors WhatsApp container logs for QR code and other statuses of the device pairing process
 * by polling them for specific strings or patterns.
 * Starts from specified date to avoid matching the outdated patterns.
 * Smart enough to stop polling if mutually exclusive patterns encountered.
 */
export const whatsappQrCodeMonitor: LogMonitor = function (
  serverId: string,
  getLogs: GetLogs,
  { startAt: startAtDefault }: { startAt?: Date } = {}
) {
  // It may be a few seconds before the container is started and the log monitor is attached.
  // We are subtracting a few seconds just to be sure we don't miss any logs.
  const startAt = startAtDefault || new Date(Date.now() - 30000);
  log.info('WhatsApp MCP log monitor: get logs starting at date', startAt);
  const waitFor = (
    lookup: string | MatcherFunction,
    timeout = 20000,
    cutoffAt: Date | undefined = undefined
  ): { promise: Promise<{ match: string; date: Date }>; cancel: () => void } => {
    const timers = { poll: 0 as NodeJS.Timeout | 0, timeout: 0 as NodeJS.Timeout | 0 };
    const promise = new Promise<{ match: string; date: Date }>((resolve, reject) => {
      function pollLogs() {
        const lookupString =
          lookup === qrCodeMatcher ? 'qrCodeMatcher' : typeof lookup === 'string' ? lookup : 'function';
        log.info(`WhatsApp MCP log monitor: polling for "${lookupString}"`);
        getLogs(100)
          .then((log) => {
            const matcher = typeof lookup === 'function' ? lookup : defaultMatcher.bind(null, lookup);
            const chunk = cutoffAt ? getLogsFromDate(log, cutoffAt) : log;
            const match = matcher(chunk);
            if (match) {
              resolve(match);
            } else {
              timers.poll = setTimeout(pollLogs, 1000);
            }
          })
          .catch(() => {
            timers.poll = setTimeout(pollLogs, 1000);
          });
      }
      pollLogs();
      timers.timeout = setTimeout(() => {
        clearTimeout(timers.poll);
        const lookupString =
          lookup === qrCodeMatcher ? 'qrCodeMatcher' : typeof lookup === 'string' ? lookup : 'function';

        reject(`WhatsApp MCP log monitor: timeout out waiting for "${lookupString}"`);
      }, timeout);
    });
    const cancel = () => {
      Object.values(timers).forEach((timer) => clearTimeout(timer));
    };
    return { promise, cancel };
  };

  const cleanupCallbacks = {
    qrcode: () => {},
    pair: () => {},
    timeout: () => {},
    update: () => {},
    connection: () => {},
  };
  const stopAllPolling = () => Object.values(cleanupCallbacks).forEach((callback) => callback());

  const { promise: whenQRCodeFound, cancel: cancelQRCodeWait } = waitFor(qrCodeMatcher, 60000, startAt);
  cleanupCallbacks.qrcode = cancelQRCodeWait;
  whenQRCodeFound
    .then(async ({ match: qrCodeASCII, date }) => {
      let paired = false;
      let timedOut = false;
      cancelConnectionWait();
      log.info('WhatsApp MCP log monitor: QR code detected', { code: qrCodeASCII, date });
      WebSocketService.broadcast({
        type: 'mcp-setup',
        payload: { serverId, provider: 'whatsapp', status: 'pending', content: qrCodeASCII },
      });

      // Waits for the indication of device pair success
      const { promise: whenPaired, cancel: cancelPairWait } = waitFor('Successfully paired', 300000, date);
      cleanupCallbacks.pair = cancelPairWait;
      whenPaired
        .then(({ date }) => {
          log.info('WhatsApp MCP log monitor: device paired', { date });
          paired = true;
          stopAllPolling();
          WebSocketService.broadcast({
            type: 'mcp-setup',
            payload: { serverId, provider: 'whatsapp', status: 'success' },
          });
        })
        .catch(log.error);

      // Waits for the indication of device pair timeout
      const { promise: whenTimedOut, cancel: cancelTimeoutWait } = waitFor(
        'Timeout waiting for QR code scan',
        1000000,
        date
      );
      cleanupCallbacks.timeout = cancelTimeoutWait;
      whenTimedOut
        .then(({ date }) => {
          log.info('WhatsApp MCP log monitor: QR code timeout', { date });
          timedOut = false;
          stopAllPolling();
          WebSocketService.broadcast({
            type: 'mcp-setup',
            payload: { serverId, provider: 'whatsapp', status: 'error' },
          });
        })
        .catch(log.error);

      let updatesExhausted = false;
      // Waits for QR code updates. Make sure to start looking from entries which are at least some second newer
      // to avoid matching the same QR code over and over.
      let startQRCodeAt = new Date(date.getTime() + 3000);
      while (!updatesExhausted && !paired && !timedOut) {
        try {
          const { promise: whenQRCodeUpdated, cancel } = waitFor(qrCodeMatcher, 300000, startQRCodeAt);
          cleanupCallbacks.update = cancel;
          const { match: qrCodeASCII, date } = await whenQRCodeUpdated;
          log.info('WhatsApp MCP log monitor: QR code update', { code: qrCodeASCII, date: startQRCodeAt });
          startQRCodeAt = new Date(date.getTime() + 3000);
          WebSocketService.broadcast({
            type: 'mcp-setup',
            payload: { serverId, provider: 'whatsapp', status: 'pending', content: qrCodeASCII },
          });
        } catch (exception) {
          updatesExhausted = true;
          log.error(exception);
        }
      }
    })
    .catch(log.error);

  // Waits for "Connected to WhatsApp" message.
  // This message indicates that the device is already paired and no QR code is needed.
  const { promise: whenConnected, cancel: cancelConnectionWait } = waitFor('Connected to WhatsApp', 60000, startAt);
  whenConnected
    .then(() => {
      log.info('WhatsApp MCP log monitor: WhatsApp connected', { date: startAt });
      stopAllPolling();
      WebSocketService.broadcast({
        type: 'mcp-setup',
        payload: { serverId, provider: 'whatsapp', status: 'success' },
      });
    })
    .catch(log.error);
  cleanupCallbacks.connection = cancelConnectionWait;

  return stopAllPolling;
};

const qrCodeMatcher: MatcherFunction = (logs: string): { match: string; date?: Date } | false => {
  const [chunk] =
    logs
      .split('\n')
      .reverse()
      .join('\n')
      .match(/((?:^[0-9\-T:+]+\s+[█▄▀ ]+.*\n?)+)/gm) || [];
  if (chunk) {
    const code = chunk
      .split('\n')
      .reverse()
      .map((line) => line.replace(/[^█▄▀ \n]/g, '').trim())
      .filter(Boolean)
      .join('\n');
    const date = new Date(chunk.split('\n')[0]?.split(/\s/)?.[0]);
    return code ? { match: code, date: date && !isNaN(date.getTime()) ? date : undefined } : false;
  } else {
    return false;
  }
};

const defaultMatcher = (string: string, logs: string): { match: string; date?: Date } | false => {
  const line = logs.split('\n').find((line) => line.includes(string));
  if (line) {
    const date = new Date(line.split(/\s/)[0]);
    return { match: string, date: date && !isNaN(date.getTime()) ? date : undefined };
  } else {
    return false;
  }
};

const getLogsFromDate = (logs: string, cutoffAt: Date): string => {
  const lines = logs.split('\n');
  const oldestDate = new Date(lines[0].split(/\s/)[0]);
  const newestDate = new Date(lines[lines.length - 1].split(/\s/)[0]);
  if (cutoffAt < oldestDate) {
    return logs;
  } else if (cutoffAt > newestDate) {
    return '';
  } else {
    const { index } = lines.reduce(
      ({ date: closestDate, index: closestIndex }: { date?: Date; index: number }, line, index) => {
        const date: Date = new Date(line.split(/\s/)[0]);
        const diff = date.getTime() - cutoffAt.getTime();
        const closestTime = closestDate ? closestDate.getTime() : Infinity;
        return diff >= 0 && diff < closestTime - cutoffAt.getTime()
          ? { date, index }
          : { date: closestDate, index: closestIndex };
      },
      { date: undefined, index: -1 }
    );
    return index === -1 ? '' : lines.slice(index).join('\n');
  }
};
