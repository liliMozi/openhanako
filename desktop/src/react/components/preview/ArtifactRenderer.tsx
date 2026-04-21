/**
 * ArtifactRenderer — Artifact 内容的声明式渲染
 *
 * 替代 PreviewPanel 中命令式 DOM 构建的 switch/case useEffect。
 * 每种 artifact 类型对应一个 JSX 分支或子组件。
 */

import { useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../../utils/markdown';
import { parseCSV, injectCopyButtons } from '../../utils/format';
import { fileIconSvg } from '../../utils/icons';
import { openFilePreview } from '../../utils/file-preview';
import { DESK_OWNER } from '../../stores/artifact-slice';
import type { Artifact } from '../../types';

interface ArtifactRendererProps {
  artifact: Artifact;
  /** 该 artifact 所属的 owner（session path 或 DESK_OWNER），用于 fallback 路由 */
  owner: string;
}

// ── MarkdownPreview ──

function MarkdownPreview({ content }: { content: string }) {
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (divRef.current) {
      injectCopyButtons(divRef.current);
    }
  }, [content]);

  return (
    <div
      ref={divRef}
      className="preview-markdown md-content"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
}

// ── CsvPreview ──

function CsvPreview({ content }: { content: string }) {
  const rows = parseCSV(content);
  if (rows.length === 0) {
    return <div className="preview-csv"><table /></div>;
  }

  const headerRow = rows[0];
  const bodyRows = rows.slice(1);

  return (
    <div className="preview-csv">
      <table>
        <thead>
          <tr>
            {headerRow.map((cell, i) => (
              <th key={`csv-h-${i}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={`csv-r-${ri}`}>
              {row.map((cell, ci) => (
                <td key={`csv-c-${ri}-${ci}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── PdfPreview ──
// data: URL 在 Electron 中无法渲染大 PDF，改用 blob URL 触发 Chromium 内置查看器

function PdfPreview({ content }: { content: string }) {
  const url = useMemo(() => {
    const raw = atob(content);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }, [content]);

  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return <iframe className="preview-pdf" src={`${url}#toolbar=0&navpanes=0`} />;
}

// ── FileInfoPreview ──

function FileInfoPreview({ artifact }: { artifact: Artifact }) {
  const t = window.t ?? ((p: string) => p);
  const ext = artifact.ext || '';

  return (
    <div className="preview-file-info">
      <div
        className="preview-file-icon"
        dangerouslySetInnerHTML={{ __html: fileIconSvg(ext) }}
      />
      <div className="preview-file-name">{artifact.title}</div>
      <div className="preview-file-ext">
        {ext.toUpperCase()} {t('desk.fileLabel')}
      </div>
      <button
        className="preview-file-open-btn"
        onClick={() => {
          if (artifact.filePath) window.platform?.openFile?.(artifact.filePath);
        }}
      >
        {t('desk.openWithDefault')}
      </button>
    </div>
  );
}

// ── ArtifactRenderer ──

export function ArtifactRenderer({ artifact, owner }: ArtifactRendererProps) {
  switch (artifact.type) {
    case 'html':
      return (
        <iframe
          sandbox="allow-scripts"
          srcDoc={artifact.content}
        />
      );

    case 'markdown':
      return <MarkdownPreview content={artifact.content} />;

    case 'code':
      return (
        <pre className="preview-code">
          <code className={artifact.language ? `language-${artifact.language}` : undefined}>
            {artifact.content}
          </code>
        </pre>
      );

    case 'csv':
      return <CsvPreview content={artifact.content} />;

    // image / svg：旧类型 artifact 的 fallback。新路径不再产生此类 artifact，
    // 持久化或旧 session 恢复时可能命中。点击后按 owner 路由到统一的 MediaViewer。
    case 'image':
    case 'svg': {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[ArtifactRenderer] 旧类型 image/svg artifact，走 fallback，请通过文件重新打开以使用新 MediaViewer');
      }
      const onOpen = () => {
        if (!artifact.filePath || !artifact.ext) return;
        const context = owner === DESK_OWNER
          ? { origin: 'desk' as const }
          : { origin: 'session' as const, sessionPath: owner };
        openFilePreview(artifact.filePath, artifact.title, artifact.ext, context);
      };
      return (
        <div
          onClick={onOpen}
          role="button"
          tabIndex={0}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 200,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <span>此图片预览已升级，点此在新查看器打开</span>
        </div>
      );
    }

    case 'pdf':
      return <PdfPreview content={artifact.content} />;

    case 'docx':
      return (
        <div
          className="preview-docx md-content"
          dangerouslySetInnerHTML={{ __html: artifact.content }}
        />
      );

    case 'xlsx':
      return (
        <div
          className="preview-csv"
          dangerouslySetInnerHTML={{ __html: artifact.content }}
        />
      );

    case 'file-info':
      return <FileInfoPreview artifact={artifact} />;

    default:
      return (
        <pre className="preview-code">{artifact.content}</pre>
      );
  }
}
