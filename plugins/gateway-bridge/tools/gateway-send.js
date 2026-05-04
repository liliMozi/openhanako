// plugins/gateway-bridge/tools/gateway-send.js
// 工具：发送消息给滨面仕上并等待回复
import { sendToBainian } from '../gateway-client.js';

export const name = 'gateway_send';

export const description = '发送消息给滨面仕上（执行助理）。仅发送不等回复，用 get_history 捞结果。';

export const parameters = {
  type: 'object',
  required: ['message'],
  properties: {
    message: {
      type: 'string',
      description: '要发送给滨面的任务描述或消息文本',
    },
  },
};

export async function execute(input, ctx) {
  const result = await sendToBainian(input.message, {
    password: ctx.config.get('gatewayPassword'),
    sessionKey: ctx.config.get('sessionKey'),
    gatewayUrl: ctx.config.get('gatewayUrl'),
  });
  return { content: [{ type: 'text', text: result }] };
}
