# Gateway Bridge — 主动通信

## 可用工具

### `gateway-bridge_gateway_send`
发送任务消息给滨面仕上，等待流式回复并返回完整结果。参数：`message`。

### `gateway-bridge_get_history`
查询滨面仕上的会话历史。可选参数：`sessionKey`（默认 `agent:main:d_laoshi`）、`limit`（默认 20）。返回格式化消息列表。

## 配置

插件通过 manifest.json 的 `contributes.configuration` 暴露三个配置项，可在 Hanako 设置中修改：

- `gatewayUrl` — WebSocket 地址，默认 `wss://claw.13ehappy.com:18789`
- `gatewayPassword` — Gateway 密码
- `sessionKey` — 目标会话 key

## 底层

- 走 WebSocket 连接滨面所在的 Gateway
- 用 YOGA 上的设备身份（`~/.openclaw/identity/device.json`）做 Ed25519 签名认证
- device auth 获得 `operator.write` scope
- 流式收 agent 事件拼成完整回复
- 闲置 8 秒无事件自动收工

## 注意事项

- 需要 device.json 存在且已配对
- 密码通过配置系统注入，不硬编码在源码
- 超时 60 秒后自动断开
