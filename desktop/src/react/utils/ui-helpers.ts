/**
 * ui-helpers.ts — 连接状态 / 错误提示 / 模型加载
 *
 * 纯 store 操作，无 DOM 依赖。
 */

import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
// @ts-expect-error — shared JS module
import { errorBus } from '../../../../shared/error-bus.js';
// @ts-expect-error — shared JS module
import { AppError } from '../../../../shared/errors.js';

// ── 连接状态 ──

export function setStatus(key: string, connected: boolean, vars: Record<string, string | number> = {}): void {
  useStore.setState({ connected, statusKey: key, statusVars: vars });
}

// ── 错误显示 ──

export function showError(message: string): void {
  errorBus.report(new AppError('UNKNOWN', { message }));
}

// ── 模型加载 ──

export async function loadModels(): Promise<void> {
  try {
    const res = await hanaFetch('/api/models');
    const data = await res.json();
    const { pendingNewSession } = useStore.getState();
    const activeModel = data.activeModel;
    let models = data.models || [];

    // 非 pending 状态：用 session 实际绑定的 model 重写 isCurrent 标记
    // pending 状态：保持 API 返回的 isCurrent（跟 agent Chat model 走）
    if (!pendingNewSession && activeModel) {
      models = models.map((m: any) => ({
        ...m,
        isCurrent: m.id === activeModel.id && m.provider === activeModel.provider,
      }));
    }

    const currentModelObj = models.find((m: any) => m.isCurrent);
    useStore.setState({
      models,
      currentModel: currentModelObj ? { id: currentModelObj.id, provider: currentModelObj.provider } : null,
    });
  } catch { /* silent */ }
}

