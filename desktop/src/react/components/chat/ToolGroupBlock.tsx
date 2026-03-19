/**
 * ToolGroupBlock — 工具调用组，含展开/折叠
 */

import { memo, useState, useCallback } from 'react';
import { extractToolDetail } from '../../utils/message-parser';
import { useStore } from '../../stores';
import type { ToolCall } from '../../stores/chat-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  tools: ToolCall[];
  collapsed: boolean;
  agentName?: string;
}

function getToolLabel(name: string, phase: string): string {
  const t = (window as any).t;
  const agentName = useStore.getState().agentName || 'Hanako';
  const vars = { name: agentName };
  const val = t?.(`tool.${name}.${phase}`, vars);
  if (val && val !== `tool.${name}.${phase}`) return val;
  return t?.(`tool._fallback.${phase}`, vars) || name;
}

export const ToolGroupBlock = memo(function ToolGroupBlock({ tools, collapsed: initialCollapsed }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = useCallback(() => setCollapsed(v => !v), []);

  const allDone = tools.every(t => t.done);
  const failCount = tools.filter(t => t.done && !t.success).length;
  const isSingle = tools.length === 1;

  // 摘要标题
  let summaryText = '';
  if (allDone) {
    if (failCount > 0) {
      summaryText = `${tools.length} 个工具（${failCount} 个失败）`;
    } else {
      summaryText = `${tools.length} 个工具`;
    }
  } else {
    const running = tools.filter(t => !t.done).length;
    summaryText = `${running} 个工具运行中`;
  }

  return (
    <div className={`tool-group${isSingle ? ' single' : ''}`}>
      {!isSingle && (
        <div
          className={`tool-group-summary${allDone ? ' clickable' : ''}`}
          onClick={allDone ? toggle : undefined}
        >
          <span className="tool-group-title">{summaryText}</span>
          {allDone && <span className="tool-group-arrow">{collapsed ? '›' : '‹'}</span>}
          {!allDone && (
            <span className="tool-dots"><span /><span /><span /></span>
          )}
        </div>
      )}
      <div className={`tool-group-content${collapsed && !isSingle ? ' collapsed' : ''}`}>
        {tools.map((tool, i) => (
          <ToolIndicator key={`${tool.name}-${i}`} tool={tool} />
        ))}
      </div>
    </div>
  );
});

// ── ToolIndicator ──

const ToolIndicator = memo(function ToolIndicator({ tool }: { tool: ToolCall }) {
  const detail = extractToolDetail(tool.name, tool.args);
  const label = getToolLabel(tool.name, tool.done ? 'done' : 'running');

  // 如果 args 里有 tag 类型信息（如 agent 名）
  const tag = tool.args?.agentId as string | undefined;

  return (
    <div className="tool-indicator" data-tool={tool.name} data-done={String(tool.done)}>
      <span className="tool-desc">{label}</span>
      {detail && <span className="tool-detail">{detail}</span>}
      {tag && <span className="tool-tag">{tag}</span>}
      {tool.done ? (
        <span className={`tool-status ${tool.success ? 'done' : 'failed'}`}>
          {tool.success ? '✓' : '✗'}
        </span>
      ) : (
        <span className="tool-dots"><span /><span /><span /></span>
      )}
    </div>
  );
});
