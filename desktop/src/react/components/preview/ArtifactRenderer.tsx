/**
 * ArtifactRenderer — Artifact 内容的声明式渲染
 *
 * 替代 PreviewPanel 中命令式 DOM 构建的 switch/case useEffect。
 * 每种 artifact 类型对应一个 JSX 分支或子组件。
 */

import { useEffect, useRef } from 'react';
import { renderMarkdown } from '../../utils/markdown';
import { parseCSV, injectCopyButtons } from '../../utils/format';
import { fileIconSvg } from '../../utils/icons';
import type { Artifact } from '../../types';

interface ArtifactRendererProps {
  artifact: Artifact;
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

export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
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

    case 'svg':
      return (
        <img
          className="preview-image"
          src={`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(artifact.content)))}`}
          alt={artifact.title}
        />
      );

    case 'image': {
      const ext = artifact.ext === 'jpg' ? 'jpeg' : (artifact.ext || 'png');
      return (
        <img
          className="preview-image"
          src={`data:image/${ext};base64,${artifact.content}`}
          alt={artifact.title}
        />
      );
    }

    case 'pdf':
      return (
        <iframe
          className="preview-pdf"
          src={`data:application/pdf;base64,${artifact.content}`}
        />
      );

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
