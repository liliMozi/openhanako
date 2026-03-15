/**
 * file-cards-shim.ts — 文件卡片 / Skill 卡片
 *
 * 从 bridge.ts 提取（Phase 6D）。
 */

import { useStore } from '../stores';
import type { Artifact } from '../types';
import { SVG_ICONS, fileIconSvg } from '../utils/icons';
import { openPreview } from './artifacts-shim';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── 可在 Artifacts 面板中预览的文件类型 ──
const PREVIEWABLE_EXTS: Record<string, string> = {
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
  py: 'code', css: 'code', json: 'code', yaml: 'code', yml: 'code',
  xml: 'code', sql: 'code', sh: 'code', bash: 'code',
  txt: 'code', svg: 'svg',
  c: 'code', cpp: 'code', h: 'code', java: 'code',
  rs: 'code', go: 'code', rb: 'code', php: 'code',
  csv: 'csv', pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  docx: 'docx', xlsx: 'xlsx', xls: 'xlsx',
};

const BINARY_PREVIEW_TYPES = new Set(['image', 'pdf']);

async function readFileForPreview(filePath: string, ext: string): Promise<string | null> {
  const previewType = PREVIEWABLE_EXTS[ext];
  if (!previewType) return null;
  const p = (window as any).platform;
  if (!p) return null;
  if (previewType === 'docx') return p.readDocxHtml?.(filePath) ?? null;
  if (previewType === 'xlsx') return p.readXlsxHtml?.(filePath) ?? null;
  if (BINARY_PREVIEW_TYPES.has(previewType)) return p.readFileBase64?.(filePath) ?? null;
  return p.readFile?.(filePath) ?? null;
}

function appendFileCard(filePath: string, label: string, ext: string): void {
  const legacyState = window.__hanaState;
  const el = legacyState?.currentAssistantEl as HTMLElement | undefined;
  if (!el) return;

  const canPreview = ext in PREVIEWABLE_EXTS;
  const card = document.createElement('div');
  card.className = 'file-output-card file-output-previewable';
  card.style.cursor = 'pointer';

  const iconEl = document.createElement('span');
  iconEl.className = 'file-output-icon';
  iconEl.innerHTML = fileIconSvg(ext);

  const nameEl = document.createElement('span');
  nameEl.className = 'file-output-name';
  nameEl.textContent = label || filePath;

  card.addEventListener('click', async (e) => {
    if ((e.target as HTMLElement).closest('.file-output-open')) return;
    const fileName = label || filePath.split('/').pop() || filePath;

    if (ext === 'skill') {
      (window as any).platform?.openSkillViewer?.({ skillPath: filePath });
      return;
    }

    if (canPreview) {
      const content = await readFileForPreview(filePath, ext);
      if (content != null) {
        const previewType = PREVIEWABLE_EXTS[ext];
        const artifact: Artifact = {
          id: `file-${filePath}`,
          type: previewType,
          title: fileName,
          content,
          filePath,
          ext,
          language: previewType === 'code' ? ext : undefined,
        };
        const s = useStore.getState();
        const arts = [...s.artifacts];
        const idx = arts.findIndex(a => a.id === artifact.id);
        if (idx >= 0) arts[idx] = artifact;
        else arts.push(artifact);
        s.setArtifacts(arts);
        openPreview(artifact);
        return;
      }
    }
    const artifact: Artifact = {
      id: `file-${filePath}`,
      type: 'file-info',
      title: fileName,
      content: '',
      filePath,
      ext,
    };
    const s = useStore.getState();
    const arts = [...s.artifacts];
    const idx = arts.findIndex(a => a.id === artifact.id);
    if (idx >= 0) arts[idx] = artifact;
    else arts.push(artifact);
    s.setArtifacts(arts);
    openPreview(artifact);
  });

  const finderBtn = document.createElement('button');
  finderBtn.className = 'file-output-open file-output-secondary';
  finderBtn.textContent = 'Finder';
  finderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    (window as any).platform?.showInFinder?.(filePath);
  });

  const btn = document.createElement('button');
  btn.className = 'file-output-open';
  btn.textContent = '↗ 外部打开';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if ((window as any).platform?.openFile) {
      (window as any).platform.openFile(filePath);
    } else {
      navigator.clipboard.writeText(filePath).then(() => {
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '↗ 外部打开'; }, 1500);
      });
    }
  });

  card.appendChild(iconEl);
  card.appendChild(nameEl);
  card.appendChild(finderBtn);
  card.appendChild(btn);
  el.appendChild(card);
}

function appendSkillCard(skillName: string, skillFilePath: string): void {
  const legacyState = window.__hanaState;
  const el = legacyState?.currentAssistantEl as HTMLElement | undefined;
  if (!el) return;

  const card = document.createElement('div');
  card.className = 'file-output-card file-output-previewable';
  card.style.cursor = 'pointer';

  const iconEl = document.createElement('span');
  iconEl.className = 'file-output-icon';
  iconEl.innerHTML = SVG_ICONS.skill;

  const nameEl = document.createElement('span');
  nameEl.className = 'file-output-name';
  nameEl.textContent = skillName;

  card.addEventListener('click', async () => {
    const content = await (window as any).platform?.readFile?.(skillFilePath);
    if (content != null) {
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
      const artifact: Artifact = {
        id: `skill-${skillName}`,
        type: 'markdown',
        title: skillName,
        content: body,
      };
      const s = useStore.getState();
      const arts = [...s.artifacts];
      const idx = arts.findIndex(a => a.id === artifact.id);
      if (idx >= 0) arts[idx] = artifact;
      else arts.push(artifact);
      s.setArtifacts(arts);
      openPreview(artifact);
    }
  });

  card.appendChild(iconEl);
  card.appendChild(nameEl);
  el.appendChild(card);
}

export function setupFileCardsShim(modules: Record<string, unknown>): void {
  modules.fileCards = {
    PREVIEWABLE_EXTS,
    BINARY_PREVIEW_TYPES,
    readFileForPreview,
    appendFileCard,
    appendSkillCard,
    initFileCards: () => { /* 不再需要 ctx 注入 */ },
  };
}
