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

    let connected = false;
    ws.on('error', (err) => { if (!connected) reject(err); });
    ws.on('close', () => { if (!connected) reject(new Error('connection closed before auth')); });

    // 标记已连接，close/error 不再 reject
    const origResolve = resolve;
    resolve = (val) => { connected = true; origResolve(val); };
  });
}

/**
 * 发送消息给滨面（仅发送，不等回复）。
 * 用 getHistory 捞结果。
 * @param {string} message - 消息文本
 * @param {object} [opts]
 * @param {string} [opts.password] - Gateway 密码
 * @param {string} [opts.sessionKey] - 目标会话
 * @param {string} [opts.gatewayUrl] - WebSocket URL
 * @param {number} [opts.timeoutMs=15000] - 超时毫秒
 * @param {number} [opts.maxRetries=3] - 重试次数
 * @returns {Promise<string>} 确认消息
 */
async function sendToBainian(message, opts = {}) {
  const {
    password = 'Ruijie@123',
    sessionKey = 'agent:main:d_laoshi',
    gatewayUrl = 'wss://claw.13ehappy.com:18789',
    timeoutMs = 15000,
    maxRetries = 3,
  } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { ws, cleanup } = await connect(password, gatewayUrl);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);

        ws.send(JSON.stringify({
          type: 'req', id: crypto.randomUUID(), method: 'sessions.send',
          params: { key: sessionKey, message, idempotencyKey: crypto.randomUUID() },
        }));

        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }

          // send 确认 → 收工
          if (msg.type === 'res' && msg.ok && msg.payload?.status === 'started') {
            clearTimeout(timer); cleanup();
            resolve(`sent to ${sessionKey}`);
            return;
          }

          // 错误
          if (msg.type === 'res' && !msg.ok) {
            clearTimeout(timer); cleanup();
            reject(new Error(msg.error?.message || 'send failed'));
          }
        });

        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
        ws.on('close', () => { clearTimeout(timer); reject(new Error('closed before ack')); });
      });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
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

    // 连接成功，立即发历史查询请求
    ws.send(JSON.stringify({
      type: 'req', id: crypto.randomUUID(), method: 'chat.history',
      params: { sessionKey, limit },
    }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'res' && msg.ok && msg.payload?.messages) {
        clearTimeout(timer);
        cleanup();
        resolve(msg.payload.messages);
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
