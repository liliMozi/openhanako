import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

/**
 * Dev 模式下放宽 CSP：
 * - 加 'unsafe-inline' 到 script-src（React Refresh 需要）
 * - 加 ws://localhost:5173 到 connect-src（Vite HMR 需要）
 * Production build 不受影响。
 */
function devCsp(): Plugin {
  return {
    name: 'hana-dev-csp',
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === 'production') return html;
      return html
        .replace(
          /script-src 'self'/g,
          "script-src 'self' 'unsafe-inline'"
        )
        .replace(
          /connect-src 'self'/g,
          "connect-src 'self' ws://localhost:5173"
        );
    },
  };
}

/**
 * 保留旧 CSS link 标签：
 * Vite 默认会把 <link rel="stylesheet" href="..."> 打包进 bundle。
 * 渐进迁移期间，styles.css 和 themes/*.css 必须保持为独立文件
 * （theme.js 运行时动态切换 themeSheet 的 href）。
 *
 * 做法：在 HTML 处理前把旧 CSS link 替换成占位符，build 后再还原。
 */
function preserveLegacyCss(): Plugin {
  const CSS_PLACEHOLDER_RE = /<!--HANA_CSS:(.*?)-->/g;
  return {
    name: 'hana-preserve-legacy-css',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // 把 <link rel="stylesheet" href="..."> 替换成 HTML 注释占位符
        // 保留 id 等属性
        return html.replace(
          /<link\s+rel="stylesheet"\s+href="([^"]+)"([^>]*)>/g,
          (_match, href, rest) => `<!--HANA_CSS:${href}${rest}-->`
        );
      },
    },
  };
}

function restoreLegacyCss(): Plugin {
  return {
    name: 'hana-restore-legacy-css',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // 把占位符还原为 <link> 标签
        return html.replace(
          /<!--HANA_CSS:(.*?)-->/g,
          (_match, content) => {
            // content 是 "styles.css" 或 "themes/warm-paper.css" id="themeSheet"
            const parts = content.split(/\s+/);
            const href = parts[0];
            const rest = parts.slice(1).join(' ');
            return `<link rel="stylesheet" href="${href}"${rest ? ' ' + rest : ''}>`;
          }
        );
      },
    },
  };
}

/**
 * Build 后复制旧文件到 dist-renderer/：
 * 旧 JS 模块、CSS、主题、资源、语言包等，
 * 在渐进迁移完成前还需要从 dist-renderer/ 加载。
 */
function copyLegacyFiles(): Plugin {
  return {
    name: 'hana-copy-legacy-files',
    closeBundle() {
      const srcDir = path.resolve(__dirname, 'desktop/src');
      const outDir = path.resolve(__dirname, 'desktop/dist-renderer');

      const dirs = ['lib', 'modules', 'themes', 'assets', 'locales'];
      const files = ['app.js', 'styles.css',
        'splash.html', 'onboarding.html', 'onboarding.js',
        'browser-viewer.html', 'skill-viewer.html', 'devtools.html'];

      for (const dir of dirs) {
        const src = path.join(srcDir, dir);
        const dest = path.join(outDir, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }

      for (const file of files) {
        const src = path.join(srcDir, file);
        const dest = path.join(outDir, file);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest);
        }
      }
    },
  };
}

export default defineConfig({
  root: 'desktop/src',
  base: './',
  plugins: [
    preserveLegacyCss(),
    react(),
    devCsp(),
    restoreLegacyCss(),
    copyLegacyFiles(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'desktop/src/react'),
    },
  },
  build: {
    outDir: '../dist-renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'desktop/src/index.html'),
        settings: path.resolve(__dirname, 'desktop/src/settings.html'),
        'editor-window': path.resolve(__dirname, 'desktop/src/editor-window.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    root: path.resolve(__dirname),
  },
});
