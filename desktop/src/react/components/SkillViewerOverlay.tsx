/**
 * SkillViewerOverlay.tsx — 技能预览全屏 overlay
 *
 * 从独立 BrowserWindow 迁移为主窗口 overlay。
 * 文件树 + Markdown 预览 + 安装按钮。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';

declare function t(key: string, vars?: Record<string, string | number>): string;
declare const markdownit: any;

interface SkillInfo {
  name: string;
  baseDir: string;
  filePath?: string;
  installed?: boolean;
}

interface TreeItem {
  name: string;
  path?: string;
  isDir?: boolean;
  children?: TreeItem[];
}

const md = typeof markdownit === 'function' ? markdownit({ html: true, linkify: true, breaks: true }) : null;

export function SkillViewerOverlay() {
  const data = useStore(s => s.skillViewerData) as SkillInfo | null;
  const [files, setFiles] = useState<TreeItem[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileName, setFileName] = useState('SKILL.md');
  const [content, setContent] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const close = useCallback(() => {
    useStore.setState({ skillViewerData: null });
  }, []);

  // 加载文件树
  useEffect(() => {
    if (!data) return;
    (async () => {
      const hana = (window as any).hana;
      const items = await hana?.listSkillFiles?.(data.baseDir);
      setFiles(items || []);
      const mdPath = data.filePath || (data.baseDir + '/SKILL.md');
      loadFile(mdPath, 'SKILL.md');
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.baseDir]);

  async function loadFile(filePath: string, name: string) {
    setActiveFile(filePath);
    setFileName(name);
    const text = await (window as any).hana?.readSkillFile?.(filePath);
    setContent(text);
  }

  async function onCopy() {
    if (!data?.baseDir) return;
    try {
      const res = await hanaFetch('/api/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: data.baseDir }),
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      showToast(t('skillViewer.copied'));
    } catch (e: any) {
      showToast(`${t('skillViewer.installFailed')}${e.message}`);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }

  if (!data) return null;

  // 渲染 markdown 或代码
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  let rendered = '';
  let description = '';
  if (content != null) {
    if (ext === 'md' || ext === 'markdown') {
      let body = content;
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
      if (fmMatch) {
        body = content.slice(fmMatch[0].length);
        description = parseFmDescription(fmMatch[1]);
      }
      rendered = md?.render(body) || escapeHtml(body);
    }
  }

  return (
    <div className="sv-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="sv-container">
        {/* 顶栏 */}
        <div className="sv-topbar">
          <button className="sv-close" onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <div className="sv-topbar-title">
            <span className="sv-skill-name">{data.name || 'Skill'}</span>
            <span> / {fileName}</span>
          </div>
          <div className="sv-topbar-actions">
            {!data.installed && (
              <button className="sv-btn sv-btn-outline" onClick={onCopy}>
                {t('settings.skills.copyToSkills')}
              </button>
            )}
          </div>
        </div>

        {/* 主体 */}
        <div className="sv-body">
          {/* 文件树 */}
          <div className="sv-sidebar">
            {files.map((item, i) => (
              <TreeNode key={i} item={item} activeFile={activeFile} onSelect={loadFile} />
            ))}
          </div>

          {/* 内容 */}
          <div className="sv-content">
            {content == null ? (
              <div className="sv-empty">{t('skillViewer.cantRead')}</div>
            ) : ext === 'md' || ext === 'markdown' ? (
              <>
                {description && (
                  <div className="sv-description">
                    <div className="sv-description-label">Description</div>
                    <div className="sv-description-text">{description}</div>
                  </div>
                )}
                <div className="md-content" dangerouslySetInnerHTML={{ __html: rendered }} />
              </>
            ) : (
              <pre><code>{content}</code></pre>
            )}
          </div>
        </div>

        {/* Toast */}
        {toast && <div className="sv-toast show">{toast}</div>}
      </div>
    </div>
  );
}

// ── 文件树节点 ──

function TreeNode({ item, activeFile, onSelect }: {
  item: TreeItem;
  activeFile: string | null;
  onSelect: (path: string, name: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);

  if (item.isDir) {
    return (
      <div className="sv-tree-folder">
        <div className="sv-tree-item" onClick={() => setCollapsed(c => !c)}>
          <span className="sv-icon sv-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {collapsed
                ? <polyline points="9 18 15 12 9 6" />
                : <polyline points="6 9 12 15 18 9" />}
            </svg>
          </span>
          <span className="sv-label">{item.name}</span>
        </div>
        {!collapsed && (
          <div className="sv-tree-children">
            {item.children?.map((child, i) => (
              <TreeNode key={i} item={child} activeFile={activeFile} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const ext = item.name.split('.').pop()?.toLowerCase() || '';
  const isMd = ext === 'md' || ext === 'markdown';
  const isCode = ['js', 'py', 'sh', 'bash', 'ts'].includes(ext);

  return (
    <div
      className={`sv-tree-item${item.path === activeFile ? ' active' : ''}`}
      onClick={() => item.path && onSelect(item.path, item.name)}
    >
      <span className="sv-icon">
        {isMd ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        ) : isCode ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
      </span>
      <span className="sv-label">{item.name}</span>
    </div>
  );
}

// ── 工具函数 ──

function parseFmDescription(fm: string): string {
  const idx = fm.search(/^description:/m);
  if (idx === -1) return '';
  const fromDesc = fm.slice(idx);
  const lines = fromDesc.split('\n');
  let value = lines[0].replace(/^description:\s*/, '');

  const q = value[0];
  if (q === '"' || q === "'") {
    let full = value.slice(1);
    let i = 1;
    while (!full.includes(q) && i < lines.length) {
      full += '\n' + lines[i].replace(/^ {2,}/, '');
      i++;
    }
    const ci = full.indexOf(q);
    if (ci !== -1) full = full.slice(0, ci);
    return full.trim();
  }

  if (value === '|' || value === '>' || value === '|+' || value === '>+') {
    let block = '';
    for (let i = 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      block += lines[i].replace(/^ {2,}/, '') + '\n';
    }
    return block.trim();
  }

  return value.trim();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
