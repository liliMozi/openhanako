/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { PluginCardBlock } from './PluginCardBlock';
import { SubagentCard } from './SubagentCard';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { MessageActions } from './MessageActions';
import { BLOCK_RENDERERS } from './block-renderers';
const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch, hanaUrl } from '../../hooks/use-hana-fetch';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';
import { buildFileRefId, isImageOrSvgExt } from '../../utils/file-kind';
import { openPreview } from '../../stores/artifact-actions';
import { selectIsStreamingSession, selectSelectedIdsBySession } from '../../stores/session-selectors';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar, sessionPath, agentId, readOnly = false }: Props) {
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || 'Hanako';
  const globalYuan = useStore(s => s.agentYuan) || 'hanako';
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const isSelected = selectedIds.includes(message.id);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // Resolve agent identity from agentId prop; fall back to global values
  const agent = agentId ? agents.find(a => a.id === agentId) : null;
  const displayName = agent?.name || globalAgentName;
  const displayYuan = agent?.yuan || globalYuan;
  const fallbackAvatar = useMemo(() => {
    const types = (window.t?.('yuan.types') || {}) as Record<string, { avatar?: string }>;
    const entry = types[displayYuan] || types['hanako'];
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }, [displayYuan]);
  const avatarSrc = (agent?.hasAvatar && agentId)
    ? hanaUrl(`/api/agents/${agentId}/avatar?t=${agentId}`)
    : fallbackAvatar;

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarSrc, fallbackAvatar]);

  const blocks = useMemo(() => message.blocks || [], [message.blocks]);

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const state = useStore.getState();
    const ids = selectSelectedIdsBySession(state, sessionPath);

    if (ids.length > 0) {
      const session = state.chatSessions[sessionPath];
      if (!session) return;
      const texts: string[] = [];
      for (const item of session.items) {
        if (item.type !== 'message') continue;
        if (!ids.includes(item.data.id)) continue;
        if (item.data.role === 'user') {
          texts.push(item.data.text || '');
        } else {
          const textBlocks = (item.data.blocks || []).filter(
            (b): b is ContentBlock & { type: 'text' } => b.type === 'text'
          );
          if (textBlocks.length === 0) continue;
          // eslint-disable-next-line no-restricted-syntax
          const tmp = document.createElement('div');
          tmp.innerHTML = textBlocks.map(b => b.html).join('\n');
          texts.push(tmp.innerText.trim());
        }
      }
      navigator.clipboard.writeText(texts.join('\n\n')).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    } else {
      // single message copy (existing logic)
      const textBlocks = blocks.filter(
        (b): b is ContentBlock & { type: 'text' } => b.type === 'text'
      );
      if (textBlocks.length === 0) return;
      // eslint-disable-next-line no-restricted-syntax
      const tmp = document.createElement('div');
      tmp.innerHTML = textBlocks.map(b => b.html).join('\n');
      const text = tmp.innerText.trim();
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  }, [blocks, sessionPath]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id, sessionPath);
  }, [message.id, sessionPath]);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
         data-message-id={message.id}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          {!avatarFailed ? (
            <img
              className={`${styles.avatar} ${styles.hanaAvatar}`}
              src={avatarSrc}
              alt={displayName}
              draggable={false}
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                if (img.src.endsWith(fallbackAvatar)) {
                  img.onerror = null;
                  setAvatarFailed(true);
                  return;
                }
                img.onerror = null;
                img.src = fallbackAvatar;
              }}
            />
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>🌸</span>
          )}
          <span className={styles.avatarName}>{displayName}</span>
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        {blocks.map((block, i) => (
          <ContentBlockView
            key={`block-${i}`}
            block={block}
            agentName={displayName}
            yuan={displayYuan}
            sessionPath={sessionPath}
            messageId={message.id}
            blockIdx={i}
          />
        ))}
      </div>
      {!readOnly && (
        <MessageActions
          messageId={message.id}
          sessionPath={sessionPath}
          onCopy={handleCopy}
          onScreenshot={handleScreenshot}
          copied={copied}
          isStreaming={isStreaming}
        />
      )}
    </div>
  );
});

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, yuan: _yuan, sessionPath, messageId, blockIdx }: {
  block: ContentBlock;
  agentName: string;
  yuan: string;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} collapsed={block.collapsed} agentName={agentName} />;
    case 'text':
      return <MarkdownContent html={block.html} />;
    case 'file':
      return (
        <FileBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    case 'screenshot':
      return (
        <ScreenshotBlock
          block={block}
          sessionPath={sessionPath}
          messageId={messageId}
          blockIdx={blockIdx}
        />
      );
    default: {
      const Renderer = BLOCK_RENDERERS[block.type];
      return Renderer ? <Renderer block={block} /> : null;
    }
  }
});

// ── 简单子块组件（物种 B，统一接受 { block: any }） ──

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React', tsx: 'React',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', cpp: 'C++', h: 'Header', sh: 'Shell', sql: 'SQL', xml: 'XML',
  csv: 'CSV', svg: 'SVG', skill: 'Skill',
  png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image',
};

// file / image block

interface FileBlockCtx {
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}

const ImageOutputCard = memo(function ImageOutputCard({ filePath, label, ext, ctx }: { filePath: string; label: string; ext: string; ctx: FileBlockCtx }) {
  const [failed, setFailed] = useState(false);
  const displayName = label || filePath.split('/').pop() || filePath;

  if (failed) return <FileOutputCard filePath={filePath} label={label} ext={ext} ctx={ctx} />;

  return (
    <div
      className={styles.imageOutputCard}
      onClick={() => openFilePreview(filePath, label, ext, {
        origin: 'session',
        sessionPath: ctx.sessionPath,
        messageId: ctx.messageId,
        blockIdx: ctx.blockIdx,
      })}
      style={{ cursor: 'pointer' }}
    >
      <img
        src={window.platform?.getFileUrl?.(filePath) ?? ''}
        alt={displayName}
        className={styles.imageOutputPreview}
        onError={() => setFailed(true)}
        draggable={false}
      />
    </div>
  );
});

const FileOutputCard = memo(function FileOutputCard({ filePath, label, ext, ctx }: { filePath: string; label: string; ext: string; ctx: FileBlockCtx }) {
  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = window.platform;
    if (p?.openFile) p.openFile(filePath);
  };

  const displayName = label || filePath.split('/').pop() || filePath;
  const typeLabel = EXT_LABELS[ext] || ext.toUpperCase();

  return (
    <div
      className={`${styles.fileOutputCard} ${styles.fileOutputPreviewable}`}
      onClick={() => openFilePreview(filePath, label, ext, {
        origin: 'session',
        sessionPath: ctx.sessionPath,
        messageId: ctx.messageId,
        blockIdx: ctx.blockIdx,
      })}
      style={{ cursor: 'pointer' }}
    >
      <div className={styles.fileOutputIcon}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </div>
      <div className={styles.fileOutputInfo}>
        <div className={styles.fileOutputName}>{displayName}</div>
        <div className={styles.fileOutputType}>{typeLabel}{ext ? ` \u00b7 ${ext.toUpperCase()}` : ''}</div>
      </div>
      <button className={styles.fileOutputOpen} onClick={handleOpen} title={window.t('desk.openWithDefault')}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
    </div>
  );
});

const FileBlock = memo(function FileBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  const ctx: FileBlockCtx = { sessionPath, messageId, blockIdx };
  // 扩展名识别统一走中心表（inferKindByExt via isImageOrSvgExt）
  return isImageOrSvgExt(block.ext)
    ? <ImageOutputCard filePath={block.filePath} label={block.label} ext={block.ext} ctx={ctx} />
    : <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} ctx={ctx} />;
});

// artifact block

const ArtifactBlock = memo(function ArtifactBlock({ block }: { block: any }) {
  const handleClick = () => {
    const artifact = { id: block.artifactId, type: block.artifactType, title: block.title, content: block.content, language: block.language };
    openPreview(artifact);
  };

  return (
    <div className={styles.artifactCard} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{block.title || block.artifactType}</span>
    </div>
  );
});

// plugin_card block

const PluginCardWrapper = memo(function PluginCardWrapper({ block }: { block: any }) {
  return <PluginCardBlock card={block.card} />;
});

// screenshot block

const ScreenshotBlock = memo(function ScreenshotBlock({ block, sessionPath, messageId, blockIdx }: {
  block: any;
  sessionPath: string;
  messageId: string;
  blockIdx: number;
}) {
  // screenshot 无 path 但 id 由 buildFileRefId 生成，与 selectSessionFiles 一致，能命中 session 图片序列
  const handleClick = () => {
    const id = buildFileRefId({
      source: 'session-block-screenshot',
      sessionPath,
      messageId,
      blockIdx,
      path: '',
    });
    openMediaViewerForRef({
      id,
      kind: 'image',
      source: 'session-block-screenshot',
      name: `screenshot-${messageId}-${blockIdx}.png`,
      path: '',
      mime: block.mimeType,
      sessionMessageId: messageId,
      inlineData: { base64: block.base64, mimeType: block.mimeType },
    }, { origin: 'session', sessionPath });
  };

  return (
    <div className={styles.browserScreenshot} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <img src={`data:${block.mimeType};base64,${block.base64}`} alt={window.t('chat.browserScreenshot')} />
    </div>
  );
});

// skill block

const SkillBlock = memo(function SkillBlock({ block }: { block: any }) {
  return (
    <div className={styles.skillCard} onClick={() => openSkillPreview(block.skillName, block.skillFilePath)} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <span>{block.skillName}</span>
    </div>
  );
});

// cron_confirm block

const CronConfirmBlock = memo(function CronConfirmBlock({ block }: { block: any }) {
  const [status, setStatus] = useState(block.status);
  const label = (block.jobData.label as string) || (block.jobData.prompt as string)?.slice(0, 40) || '';

  const handleApprove = async () => {
    try {
      if (block.confirmId) {
        await hanaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirmed' }),
        });
      } else {
        await hanaFetch('/api/desk/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', ...block.jobData }),
        });
      }
      setStatus('approved');
    } catch { /* silent */ }
  };

  const handleReject = async () => {
    if (block.confirmId) {
      try {
        await hanaFetch(`/api/confirm/${block.confirmId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rejected' }),
        });
      } catch { /* silent */ }
    }
    setStatus('rejected');
  };

  if (status !== 'pending') {
    return (
      <div className={styles.cronConfirmCard}>
        <div className={styles.cronConfirmTitle}>{label}</div>
        <div className={`${styles.cronConfirmStatus} ${status === 'approved' ? styles.cronConfirmStatusApproved : styles.cronConfirmStatusRejected}`}>
          {status === 'approved' ? window.t('common.approved') : window.t('common.rejected')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{label}</div>
      <div className={styles.cronConfirmActions}>
        <button className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnApprove}`} onClick={handleApprove}>{window.t('common.approve')}</button>
        <button className={`${styles.cronConfirmBtn} ${styles.cronConfirmBtnReject}`} onClick={handleReject}>{window.t('common.reject')}</button>
      </div>
    </div>
  );
});

// settings_confirm block

const SettingsConfirmBlock = memo(function SettingsConfirmBlock({ block }: { block: any }) {
  return <SettingsConfirmCard {...block} />;
});

// ── 注册所有物种 B 渲染器 ──
// 注：`file` 与 `screenshot` 需 session 上下文（sessionPath/messageId/blockIdx），
// 统一走 ContentBlockView 的 switch 内联分发，不注册到全局表中。
BLOCK_RENDERERS['subagent'] = SubagentCard;
BLOCK_RENDERERS['artifact'] = ArtifactBlock;
BLOCK_RENDERERS['plugin_card'] = PluginCardWrapper;
BLOCK_RENDERERS['skill'] = SkillBlock;
BLOCK_RENDERERS['cron_confirm'] = CronConfirmBlock;
BLOCK_RENDERERS['settings_confirm'] = SettingsConfirmBlock;
