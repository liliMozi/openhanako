/**
 * DeskSkillsSection — 技能快捷区（可折叠列表 + toggle 开关）
 */

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import s from './Desk.module.css';

const DESK_SKILLS_KEY = 'hana-desk-skills-collapsed';

export function DeskSkillsSection() {
  const skills = useStore(s => s.deskSkills);
  const currentAgentId = useStore(s => s.currentAgentId);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(DESK_SKILLS_KEY) === '1',
  );

  const loadDeskSkillsFn = useCallback(async () => {
    try {
      const snapshot = useStore.getState();
      const agentId = snapshot.currentAgentId;
      if (!agentId) return; // currentAgentId 未就绪时跳过，避免错位
      // 记录发起时的 session 指纹，fetch 回来后校验是否还是同一个 session，
      // 否则会把旧 session 的 fetch 结果写到 patchCurrentOwner 当前 owner 槽，
      // 污染用户已经切到的新 session。
      const requestAgentId = agentId;
      const requestSessionPath = snapshot.currentSessionPath || null;

      const res = await hanaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`);
      const data = await res.json();
      if (data.error) return;

      const now = useStore.getState();
      if (now.currentAgentId !== requestAgentId) return;
      if ((now.currentSessionPath || null) !== requestSessionPath) return;

      const all = (data.skills || []) as Array<{
        name: string; enabled: boolean; hidden?: boolean;
        source?: string; externalLabel?: string | null; managedBy?: string | null;
      }>;
      now.setDeskSkills(
        all.filter(s => !s.hidden).map(s => ({
          name: s.name,
          enabled: s.enabled,
          source: s.source,
          externalLabel: s.externalLabel,
          managedBy: s.managedBy,
        })),
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadDeskSkillsFn();
    window.__loadDeskSkills = loadDeskSkillsFn;
    return () => { delete window.__loadDeskSkills; };
  }, [loadDeskSkillsFn, currentAgentId, currentSessionPath]);

  const toggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(DESK_SKILLS_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleSkill = useCallback(async (name: string, enable: boolean) => {
    const snapshot = useStore.getState();
    const prev = snapshot.deskSkills;
    const agentId = snapshot.currentAgentId || '';
    if (!agentId) return;
    const target = prev.find(s => s.name === name);
    if (target?.managedBy === 'workspace') return;

    const requestAgentId = agentId;
    const requestSessionPath = snapshot.currentSessionPath || null;
    const sessionUnchanged = () => {
      const now = useStore.getState();
      return now.currentAgentId === requestAgentId
        && (now.currentSessionPath || null) === requestSessionPath;
    };

    // 乐观更新
    snapshot.setDeskSkills(
      prev.map(s => s.name === name ? { ...s, enabled: enable } : s),
    );

    try {
      // 关键：重新拉取当前 agent 的最新 skill 列表，再在 fresh list 上派生 enabledList
      // 避免本地 store 是错位 agent 的状态导致把别人的列表写到当前 agent (#397)
      const freshRes = await hanaFetch(`/api/skills?agentId=${encodeURIComponent(agentId)}&runtime=1`);
      const freshData = await freshRes.json();
      if (freshData.error) throw new Error(freshData.error);
      if (!sessionUnchanged()) return;
      const freshSkills = (freshData.skills || []) as Array<{ name: string; enabled: boolean; managedBy?: string | null }>;
      const enabledList = freshSkills
        .map(s => s.name === name ? { ...s, enabled: enable } : s)
        .filter(s => s.enabled && s.managedBy !== 'workspace')
        .map(s => s.name);

      await hanaFetch(`/api/agents/${agentId}/skills`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabledList }),
      });
    } catch {
      if (sessionUnchanged()) {
        useStore.getState().setDeskSkills(prev);
      }
    }
  }, []);

  const enabledCount = skills.filter(s => s.enabled).length;
  const t = window.t ?? ((p: string) => p);

  if (skills.length === 0) return null;

  return (
    <div className={s.skillsSection}>
      <button className={s.skillsHeader} onClick={toggleCollapse}>
        <span>{t('desk.skills')}</span>
        <span className={s.skillsCount}>{enabledCount}</span>
        <svg
          className={`${s.skillsChevron}${collapsed ? '' : ` ${s.skillsChevronOpen}`}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {!collapsed && (
        <div className={s.skillsList}>
          {skills.map(sk => (
            <div className={s.skillItem} key={sk.name}>
              <span className={s.skillName}>{sk.name}</span>
              {sk.externalLabel && (
                <span className={s.skillSource}>{sk.externalLabel}</span>
              )}
              <button
                className={`hana-toggle mini${sk.enabled ? ' on' : ''}`}
                disabled={sk.managedBy === 'workspace'}
                onClick={() => toggleSkill(sk.name, !sk.enabled)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
