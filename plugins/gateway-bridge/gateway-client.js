// plugins/gateway-bridge/gateway-client.js
// WebSocket + device auth 客户端，与滨面 Gateway 通信
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const IDENTITY_PATH = path.join(os.homedir(), '.openclaw/identity/device.json');

function loadIdentity() {
  return JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
}

function buildConnectParams(ident, nonce, ts, password) {
  const { deviceId, privateKeyPem } = ident;
  const sigPayload = `v2|${deviceId}|cli|cli|operator|operator.read,operator.write|${ts}||${nonce}`;
  const signature = crypto.sign(null, Buffer.from(sigPayload), privateKeyPem).toString('base64');

  const pubKeyObj = crypto.createPublicKey(ident.publicKeyPem);
  const rawPub = pubKeyObj.export({ type: 'spki', format: 'der' })
    .slice(12)
    .toString('base64');

  return {
    minProtocol: 3, maxProtocol: 3,
    client: { id: 'cli', version: '1.0', platform: 'windows', mode: 'cli' },
    role: 'operator',
    scopes: ['operator.read', 'operator.write'],
    auth: { password },
    device: { id: deviceId, publicKey: rawPub, nonce, signature, signedAt: ts },
    locale: 'zh-CN',
  };
}

/**
 * 建立 WebSocket 连接并完成 device auth
 * @param {string} password - Gateway 密码
 * @param {string} gatewayUrl - WebSocket URL
 * @returns {Promise<{ws: WebSocket, cleanup: Function}>}
 */
function connect(password, gatewayUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl, { rejectUnauthorized: false });
    const ident = loadIdentity();

    const cleanup = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const { nonce, ts } = msg.payload;
        ws.send(JSON.stringify({
          type: 'req', id: crypto.randomUUID(), method: 'connect',
          params: buildConnectParams(ident, nonce, ts, password),
        }));
        return;
      }

      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        resolve({ ws, cleanup });
      }

      if (msg.type === 'res' && !msg.ok) {
        cleanup();
        reject(new Error(msg.error?.message || 'connect failed'));
      }
    });

    ws.on('error', (err) => reject(err));
    ws.on('close', () => reject(new Error('connection closed before auth')));
  });
}

/**
 * 发送消息给滨面，等待流式回复完成
 * @param {string} message - 消息文本
 * @param {object} [opts]
 * @param {string} [opts.password] - Gateway 密码
 * @param {string} [opts.sessionKey] - 目标会话
 * @param {string} [opts.gatewayUrl] - WebSocket URL
 * @param {number} [opts.timeoutMs=60000] - 超时毫秒
 * @param {number} [opts.maxRetries=3] - 重试次数
 * @returns {Promise<string>}
 */
async function sendToBainian(message, opts = {}) {
  const {
    password = 'Ruijie@123',
    sessionKey = 'agent:main:d_laoshi',
    gatewayUrl = 'wss://claw.13ehappy.com:18789',
    timeoutMs = 60000,
    maxRetries = 3,
  } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _doSend(message, password, sessionKey, gatewayUrl, timeoutMs);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function _doSend(message, password, sessionKey, gatewayUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws, cleanupConn, fullText = '', done = false;

    const timer = setTimeout(() => {
      done = true; cleanupConn?.(); reject(new Error('timeout'));
    }, timeoutMs);

    const cleanup = () => {
      done = true; clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      cleanupConn?.();
    };

    // Idle timeout: 8s after last useful event
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { done = true; cleanupConn?.(); }, 8000);
    };

    connect(password, gatewayUrl)
      .then(({ ws: w, cleanup: c }) => {
        ws = w; cleanupConn = c;
        resetIdle();

        const sendReq = {
          type: 'req', id: crypto.randomUUID(), method: 'sessions.send',
          params: { key: sessionKey, message, idempotencyKey: crypto.randomUUID() },
        };
        ws.send(JSON.stringify(sendReq));

        let sent = false;

        ws.on('message', (raw) => {
          if (done) return;
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }

          if (!sent && msg.type === 'res' && msg.ok && msg.payload?.status === 'started') {
            sent = true; return;
          }

          if (msg.type === 'event' && msg.event === 'agent') {
            const payload = msg.payload || {};
            const dataObj = payload.data || {};
            if (payload.stream === 'assistant' && dataObj.delta) {
              fullText += dataObj.delta;
              resetIdle();
            }
            return;
          }

          if (msg.type === 'event' && msg.event === 'session.message') {
            const m = msg.payload?.message;
            if (m && m.role === 'assistant') {
              const c = m.content || '';
              fullText = Array.isArray(c)
                ? c.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : c;
              cleanup(); resolve(fullText);
            }
            return;
          }

          if (msg.type === 'event' && msg.event === 'sessions.changed') {
            if (msg.payload?.phase === 'done') {
              if (fullText) {
                setTimeout(() => { cleanup(); resolve(fullText); }, 500);
              } else {
                setTimeout(async () => {
                  const hist = await pollHistory(ws, sessionKey);
                  cleanup(); resolve(hist || '');
                }, 3000);
              }
            }
            return;
          }

          if (msg.type === 'res' && !msg.ok) {
            cleanup();
            reject(new Error(msg.error?.message || 'request failed'));
          }
        });

        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
        ws.on('close', () => { clearTimeout(timer); resolve(fullText || ''); });
      })
      .catch(reject);
  });
}

/**
 * 从 chat.history 拉取最新一条 assistant 回复
 */
function pollHistory(ws, sessionKey) {
  return new Promise((resolve) => {
    const histId = crypto.randomUUID();
    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return false; }
      if (msg.type === 'res' && msg.id === histId) {
        ws.off('message', handler);
        clearTimeout(timeout);
        if (msg.ok) {
          const msgs = msg.payload?.messages || [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'assistant') {
              const c = m.content || '';
              resolve(Array.isArray(c)
                ? c.filter(b => b.type === 'text').map(b => b.text).join('\n')
                : c);
              return true;
            }
          }
        }
        resolve('');
        return true;
      }
      return false;
    };

    ws.on('message', handler);
    const timeout = setTimeout(() => { ws.off('message', handler); resolve(''); }, 10000);
    ws.send(JSON.stringify({
      type: 'req', id: histId, method: 'chat.history',
      params: { sessionKey, limit: 5 },
    }));
  });
}

/**
 * 查询会话消息历史
 * @param {object} [opts]
 * @param {string} [opts.password] - Gateway 密码
 * @param {string} [opts.sessionKey] - 目标会话
 * @param {string} [opts.gatewayUrl] - WebSocket URL
 * @param {number} [opts.limit=20] - 返回条数
 * @returns {Promise<Array>} 消息列表
 */
async function getHistory(opts = {}) {
  const {
    password = 'Ruijie@123',
    sessionKey = 'agent:main:d_laoshi',
    gatewayUrl = 'wss://claw.13ehappy.com:18789',
    limit = 20,
  } = opts;

  const { ws, cleanup } = await connect(password, gatewayUrl);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 15000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'res' && msg.ok && msg.payload?.messages) {
        clearTimeout(timer);
        cleanup();
        resolve(msg.payload.messages);
        return;
      }

      // Send query on first non-auth message
      if (msg.type === 'res' && msg.ok) {
        ws.send(JSON.stringify({
          type: 'req', id: crypto.randomUUID(), method: 'chat.history',
          params: { sessionKey, limit },
        }));
        return;
      }

      if (msg.type === 'res' && !msg.ok) {
        clearTimeout(timer);
        cleanup();
        reject(new Error(msg.error?.message || 'history query failed'));
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => { clearTimeout(timer); resolve([]); });
  });
}

export { sendToBainian, getHistory };
