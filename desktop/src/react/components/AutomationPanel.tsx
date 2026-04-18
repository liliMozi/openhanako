import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useStore } from '../stores';
import { usePanel } from '../hooks/use-panel';
import { hanaFetch, hanaUrl } from '../hooks/use-hana-fetch';
import { cronToHuman } from '../utils/format';
import { yuanFallbackAvatar } from '../utils/agent-helpers';
import fp from './FloatingPanels.module.css';

interface CronJob {
  id: string;
  enabled: boolean;
  label?: string;
  prompt?: string;
  schedule: string | number;
  model?: string;
}

export function AutomationPanel() {
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const agentName = useStore(s => s.agentName);
  const agentYuan = useStore(s => s.agentYuan);
  const currentAgentId = useStore(s => s.currentAgentId);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [cronRes, modelsRes] = await Promise.all([
        hanaFetch('/api/desk/cron'),
        hanaFetch('/api/models'),
      ]);
      const cronData = await cronRes.json();
      let modelIds: string[] = [];
      try {
        const modelsData = await modelsRes.json();
        modelIds = (modelsData.models || []).map((m: { id: string }) => m.id);
      } catch {}
      setJobs(cronData.jobs || []);
      setAvailableModels(modelIds);
      updateBadge(cronData.jobs || []);
    } catch (err) {
      console.error('[automation] load failed:', err);
    }
  }, []);

  const { visible, close } = usePanel('automation', loadData, [currentAgentId]);

  const toggleJob = useCallback(async (jobId: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id: jobId }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] toggle failed:', err);
    }
  }, [loadData]);

  const removeJob = useCallback(async (jobId: string) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id: jobId }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] remove failed:', err);
    }
  }, [loadData]);

  const updateJob = useCallback(async (jobId: string, fields: Record<string, unknown>) => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: jobId, ...fields }),
      });
      await loadData();
    } catch (err) {
      console.error('[automation] update failed:', err);
    }
  }, [loadData]);

  if (!visible) return null;

  return (
    <div className={fp.floatingPanel} id="automationPanel">
      <div className={fp.floatingPanelInner}>
        <div className={fp.floatingPanelHeader}>
          <h2 className={fp.floatingPanelTitle}>{(window.t ?? ((p: string) => p))('automation.title')}</h2>
          <button className={fp.floatingPanelClose} onClick={close}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className={fp.floatingPanelBody}>
          <div className={fp.automationList} id="automationList">
            {jobs.length === 0 ? (
              <div className={fp.automationEmpty}>{(window.t ?? ((p: string) => p))('automation.empty')}</div>
            ) : (
              jobs.map(job => (
                <AutomationItem
                  key={job.id}
                  job={job}
                  availableModels={availableModels}
                  agentAvatarUrl={agentAvatarUrl}
                  agentName={agentName}
                  agentYuan={agentYuan}
                  currentAgentId={currentAgentId}
                  onToggle={toggleJob}
                  onRemove={removeJob}
                  onUpdate={updateJob}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

function AutomationItem({
  job,
  availableModels,
  agentAvatarUrl,
  agentName,
  agentYuan,
  currentAgentId,
  onToggle,
  onRemove,
  onUpdate,
}: {
  job: CronJob;
  availableModels: string[];
  agentAvatarUrl: string | null;
  agentName: string;
  agentYuan: string;
  currentAgentId: string | null;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, fields: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLSpanElement>(null);

  const labelText = job.label || job.prompt?.slice(0, 40) || job.id;

  const startEdit = useCallback(() => {
    setEditValue(labelText);
    setEditing(true);
  }, [labelText]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitEdit = useCallback(() => {
    const newText = editValue.trim();
    if (newText && newText !== labelText) {
      onUpdate(job.id, { label: newText });
    }
    setEditing(false);
  }, [editValue, labelText, job.id, onUpdate]);

  const avatarSrc = agentAvatarUrl || yuanFallbackAvatar(agentYuan);

  // 构建模型选项
  const jobModelId = typeof job.model === 'object' && job.model !== null
    ? (job.model as unknown as { id: string }).id
    : (job.model || '');
  const modelOptions = useMemo(() => {
    const opts: string[] = [];
    const modelSet = new Set(availableModels);
    if (jobModelId && !modelSet.has(jobModelId)) opts.push(jobModelId);
    opts.push(...availableModels);
    return opts;
  }, [availableModels, jobModelId]);

  // 模型下拉 click outside
  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);

  return (
    <div className={fp.autoItem}>
      <button
        className={'hana-toggle' + (job.enabled ? ' on' : '')}
        title={job.enabled ? 'Disable' : 'Enable'}
        onClick={() => onToggle(job.id)}
      />
      <div className={fp.autoItemInfo}>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            className={fp.autoItemLabelInput}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur(); }
              if (e.key === 'Escape') { setEditValue(labelText); inputRef.current?.blur(); }
            }}
          />
        ) : (
          <span className={fp.autoItemLabel} onDoubleClick={startEdit}>{labelText}</span>
        )}
        <div className={fp.autoItemMeta}>
          <div className={fp.autoItemExecutor}>
            <img
              className={fp.autoItemExecutorAvatar}
              src={avatarSrc}
              onError={e => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = yuanFallbackAvatar(agentYuan); }}
            />
            <span className={fp.autoItemExecutorName}>{agentName}</span>
          </div>
          <span className={fp.autoItemSchedule}>{cronToHuman(job.schedule)}</span>
          {availableModels.length > 0 && (
            <span className={`${fp.autoItemModelWrap}${modelOpen ? ` ${fp.autoModelOpen}` : ''}`} ref={modelRef}>
              <button
                className={fp.autoModelPill}
                onClick={() => setModelOpen(!modelOpen)}
              >
                <span>{jobModelId || (window.t ?? ((p: string) => p))('automation.defaultModel')}</span>
                <span className={fp.autoModelArrow}>▾</span>
              </button>
              {modelOpen && (
                <div className={fp.autoModelDropdown}>
                  <button
                    className={`${fp.autoModelOption}${!jobModelId ? ` ${fp.autoModelOptionActive}` : ''}`}
                    onClick={() => { onUpdate(job.id, { model: '' }); setModelOpen(false); }}
                  >
                    {(window.t ?? ((p: string) => p))('automation.defaultModel')}
                  </button>
                  {modelOptions.map(mid => (
                    <button
                      key={mid}
                      className={`${fp.autoModelOption}${mid === jobModelId ? ` ${fp.autoModelOptionActive}` : ''}`}
                      onClick={() => { onUpdate(job.id, { model: mid }); setModelOpen(false); }}
                    >
                      {mid}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
        </div>
      </div>
      <div className={fp.autoItemActions}>
        <button className={fp.autoItemBtn} title={(window.t ?? ((p: string) => p))('automation.edit')} onClick={startEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button className={`${fp.autoItemBtn} ${fp.autoItemBtnDanger}`} title={(window.t ?? ((p: string) => p))('automation.delete')} onClick={() => onRemove(job.id)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
