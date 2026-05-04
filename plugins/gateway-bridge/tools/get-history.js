// plugins/gateway-bridge/tools/get-history.js
// 工具：查询滨面仕上的会话历史
import { getHistory } from '../gateway-client.js';

export const name = 'get_history';

export const description = '查询滨面仕上（执行助理）的消息历史。返回消息列表，每条包含 role 和 content。可选参数 sessionKey 和 limit。';

export const parameters = {
  type: 'object',
  properties: {
    sessionKey: {
      type: 'string',
      description: 'session key，默认 agent:main:d_laoshi（D老师专用）',
    },
    limit: {
      type: 'number',
      description: '返回消息条数，默认 20',
    },
  },
};

export async function execute(input) {
  const sessionKey = input.sessionKey || 'agent:main:d_laoshi';
  const limit = input.limit || 20;
  const messages = await getHistory(sessionKey, limit);

  // 格式化为可读文本
  const lines = messages.map((m, i) => {
    const role = m.role === 'user' ? '刘欢' : m.role === 'assistant' ? '滨面' : m.role === 'toolResult' ? '[工具]' : m.role || '?';
    let content = m.content || '';
    if (Array.isArray(content)) {
      content = content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    // 截断过长消息
    if (content.length > 500) content = content.slice(0, 500) + '...';
    return `[${i}][${role}]: ${content}`;
  });

  return { content: [{ type: 'text', text: lines.join('\n') || '(无消息)' }] };
}
