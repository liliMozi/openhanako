/**
 * generate-screenshot-previews.cjs
 *
 * 用 Playwright 渲染 6 张截图预览图，保存到 assets。
 * 用法: node scripts/generate-screenshot-previews.cjs
 */
let chromium;
try {
  chromium = require("playwright").chromium;
} catch {
  chromium = require("playwright-core").chromium;
}
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const THEMES = {
  "solarized-light":         { width: 460 },
  "solarized-dark":          { width: 460 },
  "solarized-light-desktop": { width: 880 },
  "solarized-dark-desktop":  { width: 880 },
  "sakura-light":            { width: 460 },
  "sakura-light-desktop":    { width: 880 },
};

const COMBOS = [
  { color: "light",  width: "mobile",  theme: "solarized-light" },
  { color: "light",  width: "desktop", theme: "solarized-light-desktop" },
  { color: "dark",   width: "mobile",  theme: "solarized-dark" },
  { color: "dark",   width: "desktop", theme: "solarized-dark-desktop" },
  { color: "sakura", width: "mobile",  theme: "sakura-light" },
  { color: "sakura", width: "desktop", theme: "sakura-light-desktop" },
];

const PREVIEW_ESSAY = `# 风

风不是一个东西。风是空气决定换个位置时产生的动静。

你拍不了风的照片。你只能拍被风碰过的东西：旗子、水面、某个人被吹乱的刘海。风永远需要借别人的身体才能被看见，它自己是透明的，连影子都没有。整座城市里最大的存在感来自一个看不见的东西，想想也挺奇怪的。

午后三点的风带着温度。不热不凉，是那种"跟环境差不多，但吹过来你才意识到空气其实在移动"的风。像有人在你旁边轻轻叹了口气。不是冲着你，也不是冲着谁，就是它自己的呼吸。

风穿过巷子和穿过大路完全是两个性格。巷子里的风是被挤过来的，带加速度，有点横冲直撞。大路上的风散漫，到处溜达，没什么目标。最有脾气的是高楼之间的风，两栋楼把它夹在中间，像一个漏斗，它挤出来的时候又快又急，带着被压缩过的委屈。`;

const THEME_DIR = path.join(__dirname, "..", "desktop", "src", "screenshot-themes");
const OUT_DIR = path.join(__dirname, "..", "desktop", "src", "assets", "screenshot-previews");
const LOGO_PATH = path.join(__dirname, "..", "desktop", "src", "assets", "Hanako.png");

function buildHTML(themeName) {
  const MarkdownIt = require("markdown-it");
  const md = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: true });

  const themeConf = THEMES[themeName];
  if (!themeConf) throw new Error(`Unknown theme: ${themeName}`);

  const cssPath = path.join(THEME_DIR, `${themeName}.css`);
  const themeCSS = fs.readFileSync(cssPath, "utf-8");

  // sakura 主题：内联图片为 base64
  let extraCSS = "";
  if (themeName.startsWith("sakura-")) {
    const isDesktop = themeName.endsWith("-desktop");
    const branchFile = isDesktop ? "sakura-branch-desktop.png" : "sakura-branch-mobile.png";
    const flowerFile = isDesktop ? "sakura-flower-desktop.png" : "sakura-flower-mobile.png";
    const branchPath = path.join(THEME_DIR, "sakura", branchFile);
    const flowerPath = path.join(THEME_DIR, "sakura", flowerFile);
    const b64Branch = fs.existsSync(branchPath) ? fs.readFileSync(branchPath).toString("base64") : "";
    const b64Flower = fs.existsSync(flowerPath) ? fs.readFileSync(flowerPath).toString("base64") : "";
    extraCSS = `:root {
      --sakura-branch-url: url('data:image/png;base64,${b64Branch}');
      --sakura-flower-url: url('data:image/png;base64,${b64Flower}');
    }`;
  }

  let logoUrl = "";
  try {
    const logoBuf = fs.readFileSync(LOGO_PATH);
    logoUrl = `data:image/png;base64,${logoBuf.toString("base64")}`;
  } catch {}

  const bodyHTML = `<article>${md.render(PREVIEW_ESSAY)}</article>`;

  const layoutCSS = `
    .watermark {
      display: flex; align-items: center; justify-content: center;
      gap: 0.5em; padding: 1.5em 0 1em; opacity: 0.5;
    }
    .watermark-logo { width: ${themeName.endsWith("-desktop") ? "28px" : "20px"}; height: ${themeName.endsWith("-desktop") ? "28px" : "20px"}; border-radius: 50%; object-fit: cover; }
    .watermark-text { font-size: ${themeName.endsWith("-desktop") ? "0.85em" : "0.75em"}; color: #999; letter-spacing: 0.05em; }
    html, body { scrollbar-width: none; -ms-overflow-style: none; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${themeCSS}</style>
  <style>${extraCSS}</style>
  <style>${layoutCSS}</style>
</head>
<body>
  ${bodyHTML}
  <footer class="watermark">
    <img class="watermark-logo" src="${logoUrl}" />
    <span class="watermark-text">OpenHanako</span>
  </footer>
</body>
</html>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: (() => {
      // 优先使用 npx playwright install 下载的 chromium
      const cacheDir = path.join(require("os").homedir(), "Library", "Caches", "ms-playwright");
      if (fs.existsSync(cacheDir)) {
        for (const entry of fs.readdirSync(cacheDir).sort().reverse()) {
          const bin = path.join(cacheDir, entry, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
          if (fs.existsSync(bin)) return bin;
        }
      }
      return undefined;
    })(),
  });
  const context = await browser.newContext({ deviceScaleFactor: 2 });

  for (const combo of COMBOS) {
    const themeName = combo.theme;
    const themeWidth = THEMES[themeName].width;
    const fileName = `${combo.color}-${combo.width}.png`;
    const outPath = path.join(OUT_DIR, fileName);

    console.log(`Rendering ${themeName} → ${fileName}...`);

    const html = buildHTML(themeName);
    const page = await context.newPage();
    await page.setViewportSize({ width: themeWidth, height: 100 });
    await page.setContent(html, { waitUntil: "networkidle" });

    // 等字体渲染
    await page.waitForTimeout(300);

    const height = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    );
    await page.setViewportSize({ width: themeWidth, height: Math.min(height, 4000) });
    await page.waitForTimeout(200);

    await page.screenshot({ path: outPath, fullPage: true });
    const stat = fs.statSync(outPath);
    console.log(`  ✓ ${(stat.size / 1024).toFixed(0)} KB`);

    await page.close();
  }

  await browser.close();
  console.log("\nDone! Preview images saved to:", OUT_DIR);
}

main().catch(err => { console.error(err); process.exit(1); });
