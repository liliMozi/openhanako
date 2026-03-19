/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import { XingCard } from './XingCard';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch, hanaUrl } from '../../hooks/use-hana-fetch';
import { renderMarkdown } from '../../utils/markdown';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar }: Props) {
  const agentName = useStore(s => s.agentName) || 'Hanako';
  const agentYuan = useStore(s => s.agentYuan) || 'hanako';
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const sessionAgent = useStore(s => s.sessionAgent);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // 非主 agent session 用 sessionAgent 信息
  const displayName = sessionAgent?.name || agentName;
  const displayYuan = sessionAgent?.yuan || agentYuan;
  const fallbackAvatar = useMemo(() => {
    const types = (window as any).t?.('yuan.types') || {};
    const entry = types[displayYuan] || types.hanako;
    return `assets/${entry?.avatar || 'Hanako.png'}`;
  }, [displayYuan]);
  const avatarSrc = sessionAgent?.avatarUrl || agentAvatarUrl || fallbackAvatar;

  useEffect(() => {
    setAvatarFailed(false);
  }, [sessionAgent?.avatarUrl, agentAvatarUrl, fallbackAvatar]);

  const blocks = message.blocks || [];

  return (
    <div className="message-group assistant">
      {showAvatar && (
        <div className="avatar-row assistant">
          {!avatarFailed ? (
            <img
              className="avatar hana-avatar"
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
            <span className="avatar user-avatar">🌸</span>
          )}
          <span className="avatar-name">{displayName}</span>
        </div>
      )}
      <div className="message assistant">
        {blocks.map((block, i) => (
          <ContentBlockView key={i} block={block} agentName={displayName} yuan={displayYuan} />
        ))}
      </div>
    </div>
  );
});

// ── ContentBlock 分发 ──

const ContentBlockView = memo(function ContentBlockView({ block, agentName, yuan }: {
  block: ContentBlock;
  agentName: string;
  yuan: string;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'tool_group':
      return <ToolGroupBlock tools={block.tools} collapsed={block.collapsed} />;
    case 'text':
      return <MarkdownContent html={block.html} />;
    case 'xing':
      return <XingCard title={block.title} content={block.content} sealed={block.sealed} agentName={agentName} />;
    case 'file_output':
      return <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} />;
    case 'artifact':
      return <ArtifactCard title={block.title} artifactType={block.artifactType} artifactId={block.artifactId} content={block.content} language={block.language} />;
    case 'browser_screenshot':
      return <img className="browser-screenshot" src={`data:${block.mimeType};base64,${block.base64}`} alt="screenshot" />;
    case 'skill':
      return <SkillCard skillName={block.skillName} skillFilePath={block.skillFilePath} />;
    case 'cron_confirm':
      return <CronConfirmCard jobData={block.jobData} status={block.status} />;
    default:
      return null;
  }
});

// ── 简单子块组件 ──

const FileOutputCard = memo(function FileOutputCard({ filePath, label, ext }: { filePath: string; label: string; ext: string }) {
  const handleClick = () => {
    // 复用 file-cards-shim 的 appendFileCard 逻辑：读文件内容 → 打开预览
    const fc = (window as any).HanaModules?.fileCards;
    if (fc?.openFilePreview) {
      fc.openFilePreview(filePath, label, ext);
    } else {
      // fallback：用 platform API 打开
      (window as any).platform?.openPath?.(filePath);
    }
  };

  return (
    <div className="file-output-card file-output-previewable" onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="file-output-name">{label || filePath}</span>
      {ext && <span className="file-output-ext">{ext}</span>}
    </div>
  );
});

const ArtifactCard = memo(function ArtifactCard({ title, artifactType, artifactId, content, language }: {
  title: string; artifactType: string; artifactId: string; content: string; language?: string;
}) {
  const handleClick = () => {
    const ar = (window as any).HanaModules?.artifacts;
    if (ar?.handleArtifact) {
      ar.handleArtifact({ id: artifactId, type: artifactType, title, content, language });
    }
  };

  return (
    <div className="artifact-inline-card" onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
      </svg>
      <span>{title || artifactType}</span>
    </div>
  );
});

const SkillCard = memo(function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  const handleClick = () => {
    (window as any).platform?.openSkillViewer?.({ skillPath: skillFilePath });
  };

  return (
    <div className="skill-card" onClick={handleClick} style={{ cursor: 'pointer' }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <span>{skillName}</span>
    </div>
  );
});

const CronConfirmCard = memo(function CronConfirmCard({ jobData, status: initialStatus }: { jobData: Record<string, unknown>; status: string }) {
  const [status, setStatus] = useState(initialStatus);
  const label = (jobData.label as string) || (jobData.prompt as string)?.slice(0, 40) || '';

  const handleApprove = async () => {
    try {
      await hanaFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', ...jobData }),
      });
      setStatus('approved');
    } catch { /* silent */ }
  };

  const handleReject = () => {
    setStatus('rejected');
  };

  if (status !== 'pending') {
    return (
      <div className="cron-confirm-card">
        <div className="cron-confirm-title">{label}</div>
        <div className={`cron-confirm-status ${status}`}>
          {status === 'approved' ? '已批准' : '已拒绝'}
        </div>
      </div>
    );
  }

  return (
    <div className="cron-confirm-card">
      <div className="cron-confirm-title">{label}</div>
      <div className="cron-confirm-actions">
        <button className="cron-confirm-btn approve" onClick={handleApprove}>批准</button>
        <button className="cron-confirm-btn reject" onClick={handleReject}>拒绝</button>
      </div>
    </div>
  );
});
