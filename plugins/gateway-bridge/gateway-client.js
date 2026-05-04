// plugins/gateway-bridge/gateway-client.js
// WebSocket + device auth 客户端，发送消息给滨面 Gateway 并流式接收回复
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GATEWAY_URL = 'wss://claw.13ehappy.com:18789';
const PASSWORD = 'Ruijie@123';
const SESSION_KEY = 'agent:main:d_laoshi';
const IDENTITY_PATH = path.join(os.homedir(), '.openclaw/identity/device.json');

function loadIdentity() {
  return JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf-8'));
}

function buildConnectParams(ident, nonce, ts) {
  const { deviceId, privateKeyPem } = ident;
  const sigPayload = `v2|${deviceId}|cli|cli|operator|operator.read,operator.write|${ts}||${nonce}`;
  const signature = crypto.sign(null, Buffer.from(sigPayload), privateKeyPem).toString('base64');

  // 从 PEM 提取 raw public key（去掉 SPKI 头部 12 字节）
  const pubKeyObj = crypto.createPublicKey(ident.publicKeyPem);
  const rawPub = pubKeyObj.export({ type: 'spki', format: 'der' })
    .slice(12)
    .toString('base64');

  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: 'cli', version: '1.0', platform: 'windows', mode: 'cli' },
    role: 'operator',
    scopes: ['operator.read', 'operator.write'],
    auth: { password: PASSWORD },
    device: {
      id: deviceId,
      publicKey: rawPub,
      nonce,
      signature,
      signedAt: ts,
    },
    locale: 'zh-CN',
  };
}

/**
 * 发送消息给滨面，等待流式回复完成
 * @param {string} message - 要发送的消息
 * @param {number} [timeoutMs=60000] - 超时时间（毫秒）
 * @param {number} [maxRetries=3] - 最大重试次数
 * @returns {Promise<string>} 滨面的完整回复
 */
async function sendToBainian(message, timeoutMs = 60000, maxRetries = 3) {
  const ident = loadIdentity();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await _doSend(ident, message, timeoutMs);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function _doSend(ident, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL, { rejectUnauthorized: false });
    let fullText = '';
    let done = false;

    const timer = setTimeout(() => {
      done = true;
      ws.close();
      reject(new Error('timeout'));
    }, timeoutMs);

    // 闲置超时：最后一条有用事件后 8 秒无事件 → 主动收工
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        done = true;
        ws.close();
      }, 8000);
    };
    resetIdle();

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    let connected = false;
    let sent = false;

    ws.on('message', (raw) => {
      if (done) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // 1. 收到 challenge → 用设备身份签名响应
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const { nonce, ts } = msg.payload;
        const connectReq = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: buildConnectParams(ident, nonce, ts),
        };
        ws.send(JSON.stringify(connectReq));
        return;
      }

      // 2. connect 成功（hello-ok）→ 发送消息
      if (!connected && msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        connected = true;
        const sendReq = {
          type: 'req',
          id: crypto.randomUUID(),
          method: 'sessions.send',
          params: {
            key: SESSION_KEY,
            message,
            idempotencyKey: crypto.randomUUID(),
          },
        };
        ws.send(JSON.stringify(sendReq));
        return;
      }

      // 2b. sessions.send 确认
      if (!sent && msg.type === 'res' && msg.ok && msg.payload?.status === 'started') {
        sent = true;
        return;
      }

      // 3. 流式 agent 事件
      if (msg.type === 'event' && msg.event === 'agent') {
        const payload = msg.payload || {};
        const dataObj = payload.data || {};
        if (payload.stream === 'assistant' && dataObj.delta) {
          fullText += dataObj.delta;
          resetIdle();
        }
        return;
      }

      // 4. 最终 assistant 回复（session.message 事件）
      if (msg.type === 'event' && msg.event === 'session.message') {
        const m = msg.payload?.message;
        if (m && m.role === 'assistant') {
          const c = m.content || '';
          if (Array.isArray(c)) {
            fullText = c
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('\n');
          } else if (c) {
            fullText = c;
          }
          cleanup();
          resolve(fullText);
        }
        return;
      }

      // 5. session 完成 → 等一小会收工
      if (msg.type === 'event' && msg.event === 'sessions.changed') {
        if (msg.payload?.phase === 'done') {
          if (fullText) {
            // 有流式文本，延迟等可能最后一批 delta
            setTimeout(() => { cleanup(); resolve(fullText); }, 500);
          } else {
            // 无流式文本，拉历史捞回复
            setTimeout(async () => {
              try {
                const hist = await pollHistory(ws);
                cleanup();
                resolve(hist || '');
              } catch {
                cleanup();
                resolve('');
              }
            }, 3000);
          }
        }
        return;
      }

      // 6. 错误
      if (msg.type === 'res' && !msg.ok) {
        cleanup();
        reject(new Error(msg.error?.message || 'unknown error'));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      resolve(fullText || '');
    });
  });
}

/**
 * 通过 chat.history 拉取最新 assistant 回复
 */
function pollHistory(ws) {
  return new Promise((resolve, reject) => {
    const histId = crypto.randomUUID();
    const histReq = {
      type: 'req',
      id: histId,
      method: 'chat.history',
      params: { sessionKey: SESSION_KEY, limit: 5 },
    };
    
    // 注册一次性的历史响应处理
    const handler = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return false; }
      if (msg.type === 'res' && msg.id === histId) {
        ws.off('message', handler);
        if (msg.ok) {
          const msgs = msg.payload?.messages || [];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.role === 'assistant') {
              const c = m.content || '';
              if (Array.isArray(c)) {
                resolve(c.filter(b => b.type === 'text').map(b => b.text).join('\n'));
              } else {
                resolve(c);
              }
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
    
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      resolve('');
    }, 10000);
    
    ws.send(JSON.stringify(histReq));
  

  });
}

/**
 * 查询滨面指定 session 的消息历史
 * @param {string} [sessionKey='agent:main:d_laoshi'] - session key
 * @param {number} [limit=20] - 消息条数
 * @returns {Promise<Array>} 消息列表
 */
async function getHistory(sessionKey = SESSION_KEY, limit = 20) {
  const ident = loadIdentity();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL, { rejectUnauthorized: false });
    let done = false;

    const timer = setTimeout(() => {
      done = true; ws.close(); reject(new Error('timeout'));
    }, 15000);

    const cleanup = () => {
      done = true; clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };

    ws.on('message', (raw) => {
      if (done) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Challenge → sign and connect
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const { nonce, ts } = msg.payload;
        ws.send(JSON.stringify({
          type: 'req', id: crypto.randomUUID(), method: 'connect',
          params: buildConnectParams(ident, nonce, ts),
        }));
        return;
      }

      // hello-ok → send history query
      if (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok') {
        ws.send(JSON.stringify({
          type: 'req', id: crypto.randomUUID(), method: 'chat.history',
          params: { sessionKey, limit },
        }));
        return;
      }

      // history response
      if (msg.type === 'res' && msg.ok && msg.payload?.messages) {
        cleanup();
        resolve(msg.payload.messages);
        return;
      }

      // error
      if (msg.type === 'res' && !msg.ok) {
        cleanup();
        reject(new Error(msg.error?.message || 'unknown error'));
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => { clearTimeout(timer); resolve([]); });
  });
}

export { sendToBainian, getHistory };
