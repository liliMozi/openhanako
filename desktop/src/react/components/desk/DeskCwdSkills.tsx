/**
 * DeskCwdSkills — CWD 项目技能按钮 + 展开面板
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import type { CwdSkillInfo } from '../../stores/desk-slice';
import css from './Desk.module.css';

// ── 加载 CWD skills ──

async function loadCwdSkills() {
  const s = useStore.getState();
  if (!s.deskBasePath) return;
  try {
    const res = await hanaFetch(
      `/api/desk/skills?dir=${encodeURIComponent(s.deskBasePath)}`,
    );
    const data = await res.json();
    useStore.setState({ cwdSkills: data.skills || [] });
  } catch { /* ignore */ }
}

function useCwdSkillsOpen() {
  const cwdSkills = useStore(s => s.cwdSkills);
  const cwdSkillsOpen = useStore(s => s.cwdSkillsOpen);
  return {
    open: cwdSkillsOpen,
    skills: cwdSkills,
    toggle: () => useStore.getState().toggleCwdSkillsOpen(),
    setSkills: (skills: CwdSkillInfo[]) => useStore.setState({ cwdSkills: skills }),
  };
}

// ── CWD Skills 按钮 ──

export function DeskCwdSkillsButton() {
  const deskBasePath = useStore(s => s.deskBasePath);
  const { open, skills, toggle } = useCwdSkillsOpen();
  const loadedRef = useRef('');

  useEffect(() => {
    if (deskBasePath && deskBasePath !== loadedRef.current) {
      loadCwdSkills().then(() => { loadedRef.current = deskBasePath; });
    }
  }, [deskBasePath]);

  const handleClick = useCallback(() => {
    if (!open) loadCwdSkills();
    toggle();
  }, [open, toggle]);

  if (!deskBasePath) return null;

  const t = window.t ?? ((p: string) => p);
  const label = skills.length > 0
    ? `${t('desk.cwdSkills')} · ${skills.length}`
    : t('desk.cwdSkills');

  return (
    <button
      className={`${css.cwdBtn} ${css.headerCwdBtn}${open ? ` ${css.active}` : ''}`}
      onClick={handleClick}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

// ── CWD Skills 面板 ──

export function DeskCwdSkillsPanel() {
  const { open, skills } = useCwdSkillsOpen();
  const t = window.t ?? ((p: string) => p);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
    } else if (visible) {
      setClosing(true);
      const timer = setTimeout(() => { setVisible(false); setClosing(false); }, 80);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visible 不需要加入依赖：仅在 open 变化时驱动动画逻辑
  }, [open]);

  const [dragging, setDragging] = useState(false);
  const [cmPos, setCmPos] = useState<{ x: number; y: number } | null>(null);
  const [cmSkill, setCmSkill] = useState<CwdSkillInfo | null>(null);

  useEffect(() => {
    if (!cmPos) return;
    const close = () => { setCmPos(null); setCmSkill(null); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [cmPos]);

  const deleteSkill = useCallback(async (skill: CwdSkillInfo) => {
    if (!skill.baseDir) return;
    try {
      await hanaFetch('/api/desk/delete-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillDir: skill.baseDir }),
      });
      await loadCwdSkills();
    } catch (err) {
      console.error('[cwd-skills] delete failed:', err);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    const dir = useStore.getState().deskBasePath;
    console.log('[cwd-skills] drop: files=', files.length, 'dir=', dir);
    if (!dir) return;
    let installed = false;
    for (const file of files) {
      const filePath = window.platform?.getFilePath?.(file);
      console.log('[cwd-skills] filePath=', filePath, 'file.name=', file.name);
      if (!filePath) continue;
      try {
        const res = await hanaFetch('/api/desk/install-skill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath, dir }),
        });
        const data = await res.json();
        if (data.error) {
          console.warn('[cwd-skills] install failed:', data.error);
        } else {
          console.log('[cwd-skills] installed:', data.name);
          installed = true;
        }
      } catch (err) {
        console.error('[cwd-skills] install failed:', err);
      }
    }
    if (installed) await loadCwdSkills();
    window.__loadDeskSkills?.();
  }, []);

  if (!visible) return null;

  const grouped: Record<string, CwdSkillInfo[]> = {};
  for (const s of skills) {
    (grouped[s.source] ??= []).push(s);
  }

  return (
    <div className={`${css.cwdPanelWrap}${closing ? ` ${css.closing}` : ''}`}>
      <div
        className={`${css.cwdPanel}${dragging ? ` ${css.dragOver}` : ''}`}
        data-desk-cwd-panel=""
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCmPos({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { handleDrop(e); }}
      >
        <div className={css.cwdDescLine}>
          <span className={css.cwdDescDeco} />
          <span className={css.cwdDescText}>{t('desk.cwdSkillsDesc')}</span>
          <span className={css.cwdDescDeco} />
        </div>

        {skills.length === 0 ? (
          <>
            <p className={css.cwdEmpty}>{t('desk.cwdSkillsEmpty')}</p>
            <p className={css.cwdHint}>{t('desk.cwdSkillsDrop')}</p>
          </>
        ) : (
          <>
            {Object.entries(grouped).map(([source, items]) => (
              <div key={source}>
                <div className={css.cwdGroupLabel}>{source}</div>
                {items.map(s => {
                  let desc = s.description || '';
                  if (desc.length > 60) desc = desc.slice(0, 60) + '...';
                  return (
                    <div
                      className={css.cwdSkillItem}
                      key={s.name}
                      onDoubleClick={() => {
                        window.platform?.openSkillViewer?.({
                          name: s.name,
                          baseDir: s.baseDir,
                          filePath: s.filePath,
                          installed: false,
                        });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCmPos({ x: e.clientX, y: e.clientY });
                        setCmSkill(s);
                      }}
                    >
                      <span className={css.cwdSkillName}>{s.name}</span>
                      {desc && <span className={css.cwdSkillDesc}>{desc}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            <p className={css.cwdHint}>{t('desk.cwdSkillsDrop')}</p>
          </>
        )}
        {cmPos && (
          <div className={css.cwdCtxMenu} style={{ position: 'fixed', left: cmPos.x, top: cmPos.y, zIndex: 9999 }}>
            <button onClick={() => {
              const target = cmSkill?.baseDir || (useStore.getState().deskBasePath + '/.agents/skills');
              window.platform?.showInFinder?.(target);
              setCmPos(null);
            }}>
              {t('desk.openInFinder')}
            </button>
            {cmSkill && (
              <button className={css.cwdCtxDanger} onClick={() => {
                deleteSkill(cmSkill);
                setCmPos(null);
              }}>
                {t('desk.deleteSkill')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
