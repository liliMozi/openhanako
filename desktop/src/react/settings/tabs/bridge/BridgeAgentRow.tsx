/**
 * BridgeTab 顶部的 agent 选择器——水平平铺的头像+名字列表。
 * 代替下拉框，视觉参考 AgentCardStack 但去掉弧形堆叠 / 右键菜单 / 拖拽等，
 * 只保留"选中"交互。selected 高亮与 AgentCardStack 一致。
 */
import React, { useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { hanaUrl, yuanFallbackAvatar } from '../../api';

interface BridgeAgentRowProps {
  value: string | null;
  onChange: (agentId: string) => void;
}

export function BridgeAgentRow({ value, onChange }: BridgeAgentRowProps) {
  const agents = useSettingsStore((s) => s.agents);
  const tsRef = useRef(Date.now());
  const ts = tsRef.current;

  // 选中项滚动进视野（仅在超宽、可滚动时）
  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!value) return;
    const el = scrollerRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const item = el.querySelector(`[data-agent-id="${value}"]`) as HTMLElement | null;
    if (!item) return;
    const containerRect = el.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const visLeft = itemRect.left - containerRect.left + el.scrollLeft;
    const visRight = visLeft + itemRect.width;
    if (visLeft < el.scrollLeft || visRight > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = visLeft - (el.clientWidth - itemRect.width) / 2;
    }
  }, [value]);

  return (
    <div className="bridge-agent-row-scroller" ref={scrollerRef}>
      <div className="bridge-agent-row-list">
        {agents.map((agent) => {
          const isSelected = agent.id === value;
          return (
            <button
              key={agent.id}
              type="button"
              data-agent-id={agent.id}
              className={`bridge-agent-row-item${isSelected ? ' selected' : ''}`}
              onClick={() => onChange(agent.id)}
            >
              <div className="bridge-agent-row-avatar-wrap">
                <img
                  className="bridge-agent-row-avatar"
                  draggable={false}
                  src={agent.hasAvatar
                    ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${ts}`)
                    : yuanFallbackAvatar(agent.yuan || 'hanako')}
                  onError={(e) => {
                    const img = e.target as HTMLImageElement;
                    img.onerror = null;
                    img.src = yuanFallbackAvatar(agent.yuan || 'hanako');
                  }}
                />
              </div>
              <span className="bridge-agent-row-name">{agent.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
