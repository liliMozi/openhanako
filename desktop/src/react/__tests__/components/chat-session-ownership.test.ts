import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('chat message session ownership', () => {
  it('消息组件不再从 currentSessionPath 倒推自己的 session', () => {
    const assistantSource = read('components/chat/AssistantMessage.tsx');
    const userSource = read('components/chat/UserMessage.tsx');

    expect(assistantSource).not.toMatch(/currentSessionPath/);
    expect(userSource).not.toMatch(/currentSessionPath/);
  });

  it('消息组件通过显式 sessionPath 渲染，不从全局焦点推导', () => {
    // 7687243 后 ChatArea 的消息渲染提取到了 ChatTranscript，sessionPath 由 ChatTranscript
    // 以 props 形式传给 UserMessage / AssistantMessage。这里校验这条链路仍然成立。
    const chatAreaSource = read('components/chat/ChatArea.tsx');
    expect(chatAreaSource).toMatch(/<ChatTranscript[\s\S]*sessionPath=\{path\}/);

    const transcriptSource = read('components/chat/ChatTranscript.tsx');
    expect(transcriptSource).toMatch(/<UserMessage[\s\S]*sessionPath=\{sessionPath\}/);
    expect(transcriptSource).toMatch(/<AssistantMessage[\s\S]*sessionPath=\{sessionPath\}/);
  });

  it('聊天消息 selector 不再为缺失 key 内联返回新空数组', () => {
    const assistantSource = read('components/chat/AssistantMessage.tsx');
    const userSource = read('components/chat/UserMessage.tsx');
    const actionsSource = read('components/chat/MessageActions.tsx');

    expect(assistantSource).not.toMatch(/selectedIdsBySession\[[^\]]+\]\s*\|\|\s*\[\]/);
    expect(userSource).not.toMatch(/selectedIdsBySession\[[^\]]+\]\s*\|\|\s*\[\]/);
    expect(actionsSource).not.toMatch(/selectedIdsBySession\[[^\]]+\]\s*\|\|\s*\[\]/);
  });
});
