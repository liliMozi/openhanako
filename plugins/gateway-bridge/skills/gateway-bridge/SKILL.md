# Gateway Bridge — 主动通信

## 能力

- 向滨面仕上（OpenClaw 执行助理）发送任务指令
- 等待流式回复并返回完整结果
- 内置重试和超时保护（60 秒）

## 使用方式

AI Agent 调 `gateway-bridge_gateway_send` 工具，传一个 `message` 参数即可。

## 底层

- 走 `wss://claw.13ehappy.com:18789` 连接滨面所在的 Gateway
- 用 YOGA 上的设备身份（`~/.openclaw/identity/device.json`）做 Ed25519 签名认证
- 发 `sessions.send` 到滨面主会话（`agent:main:d_laoshi`）
- 流式收 agent 事件拼成完整回复

## 注意事项

- 需要 device.json 存在且已配对
- 通信加密走 TLS，任意端口可通
- 超时 60 秒后自动断开
