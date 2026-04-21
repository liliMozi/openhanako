// desktop/src/react/utils/screenshot.ts
import { useStore } from '../stores';
import { selectSelectedIdsBySession } from '../stores/session-selectors';
import { extractScreenshotPayload, buildThemeName } from './screenshot-extract';
import type { ChatMessage } from '../stores/chat-types';

/**
 * 截图指定消息并保存到文件（离屏渲染管线）。
 */
export async function takeScreenshot(targetMessageId: string, sessionPath: string): Promise<void> {
  const state = useStore.getState();
  const ids = selectSelectedIdsBySession(state, sessionPath);
  const messageIds = ids.length > 0 ? ids : [targetMessageId];

  // 1. 从 store 提取消息数据
  const session = state.chatSessions[sessionPath];
  if (!session) return;

  const messages: ChatMessage[] = [];
  for (const item of session.items) {
    if (item.type !== 'message') continue;
    if (messageIds.includes(item.data.id)) {
      messages.push(item.data);
    }
  }
  if (messages.length === 0) return;

  // 2. 读取截图设置
  const color = localStorage.getItem('hana-screenshot-color') || 'light';
  const width = localStorage.getItem('hana-screenshot-width') || 'mobile';
  const theme = buildThemeName(color, width);

  // 3. 提取 payload
  const payload = extractScreenshotPayload(messages, theme) as any;
  payload.saveDir = state.homeFolder || null;

  // 4. 填充角色名和头像（conversation 模式）
  if (payload.messages) {
    const globalAgentName = state.agentName || 'Hanako';
    const userName = state.userName || '';
    const agentId = state.currentAgentId;

    for (const msg of payload.messages) {
      if (msg.role === 'assistant') {
        msg.name = globalAgentName;
        try {
          msg.avatarDataUrl = await fetchAvatarAsDataUrl('assistant', agentId);
        } catch { /* fallback null */ }
      } else {
        msg.name = userName || '我';
        try {
          msg.avatarDataUrl = await fetchAvatarAsDataUrl('user', null);
        } catch { /* fallback null */ }
      }

      // 图片 filePath → base64 data URL
      for (const block of msg.blocks) {
        if (block.type === 'image' && block.content && !block.content.startsWith('data:')) {
          try {
            block.content = await fetchImageAsDataUrl(block.content);
          } catch { /* 图片加载失败跳过 */ }
        }
      }
    }
  }

  // 5. IPC 调用
  const t = window.t ?? ((p: string) => p);
  const hana = (window as any).hana;
  if (!hana?.screenshotRender) {
    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: { text: t('common.screenshotFailed'), type: 'error' },
    }));
    return;
  }

  const result = await hana.screenshotRender(payload);
  if (result.success) {
    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: { text: t('common.screenshotSaved'), type: 'success', deskDir: result.dir },
    }));
  } else {
    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: { text: `${t('common.screenshotFailed')}: ${result.error}`, type: 'error' },
    }));
  }
}

/**
 * Markdown 编辑器截图（纯文章模式）。
 */
export async function takeArticleScreenshot(markdown: string): Promise<void> {
  const color = localStorage.getItem('hana-screenshot-color') || 'light';
  const width = localStorage.getItem('hana-screenshot-width') || 'mobile';
  const theme = buildThemeName(color, width);

  const t = window.t ?? ((p: string) => p);
  const hana = (window as any).hana;
  if (!hana?.screenshotRender) {
    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: { text: t('common.screenshotFailed'), type: 'error' },
    }));
    return;
  }

  const homeFolder = useStore.getState().homeFolder || null;
  const result = await hana.screenshotRender({
    mode: 'article',
    theme,
    markdown,
    saveDir: homeFolder,
  });

  if (result.success) {
    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: { text: t('common.screenshotSaved'), type: 'success', deskDir: result.dir },
    }));
  } else {
    window.dispatchEvent(new CustomEvent('hana-inline-notice', {
      detail: { text: `${t('common.screenshotFailed')}: ${result.error}`, type: 'error' },
    }));
  }
}

// ── 辅助：fetch 图片转 data URL ──

async function fetchImageAsDataUrl(filePath: string): Promise<string> {
  const url = window.platform?.getFileUrl?.(filePath) ?? '';
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchAvatarAsDataUrl(role: string, agentId: string | null): Promise<string | null> {
  const port = await (window as any).hana?.getServerPort?.();
  const token = await (window as any).hana?.getServerToken?.();
  if (!port || !token) return null;

  const url = role === 'user'
    ? `http://127.0.0.1:${port}/api/avatar/user`
    : `http://127.0.0.1:${port}/api/agents/${agentId}/avatar`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const blob = await resp.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
