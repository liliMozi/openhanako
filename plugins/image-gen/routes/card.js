/**
 * image-gen/routes/card.js
 *
 * Iframe card for chat messages. Server-rendered.
 * Reads aspect ratio from task params — works for both new and old cards.
 * ResizeObserver reports final size after image loads.
 */

export default function (app, ctx) {
  app.get("/card", (c) => {
    const batchId = c.req.query("batch");
    if (!batchId) return c.text("Missing batch parameter", 400);

    const store = ctx._mediaGen?.store;
    const tasks = store?.getByBatch(batchId) || [];
    const token = c.req.query("token") || "";
    const pluginId = ctx.pluginId;
    const mediaBase = `/api/plugins/${pluginId}`;
    const tokenParam = token ? `?token=${token}` : "";
    const hanaCss = c.req.query("hana-css") || "";

    const hasPending = tasks.some((t) => t.status === "pending");

    // Read ratio from task params (works for old cards without aspectRatio in card details)
    const ratio = tasks[0]?.params?.ratio || "1:1";

    let cellsHtml = "";
    for (const t of tasks) {
      if (t.status === "pending") {
        cellsHtml += `<div class="skeleton"></div>`;
      } else if (t.status === "done" && t.files?.length) {
        const file = t.files[0];
        const isVideo = file.endsWith(".mp4") || file.endsWith(".mov");
        if (isVideo) {
          const videoUrl = `${mediaBase}/media/${esc(file)}${tokenParam}`;
          const openUrl = `${mediaBase}/media/open/${esc(file)}${tokenParam ? tokenParam + '&' : '?'}token=${token}`;
          cellsHtml += `<div class="video-wrap" onclick="fetch('${openUrl}',{method:'POST'})"><video src="${videoUrl}" preload="metadata" muted playsinline></video><div class="play-btn">▶</div></div>`;
        } else {
          cellsHtml += `<img src="${mediaBase}/media/${esc(file)}${tokenParam}">`;
        }
      } else if (t.status === "failed") {
        cellsHtml += `<div class="failed">${esc(t.failReason || "生成失败")}</div>`;
      }
    }

    if (!tasks.length) cellsHtml = `<div class="failed">任务不存在</div>`;

    // Parse ratio for CSS
    const [rw, rh] = ratio.split(":").map(Number);
    const cssRatio = (rw && rh) ? `${rw}/${rh}` : "1/1";

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${hasPending ? '<meta http-equiv="refresh" content="5">' : ''}
${hanaCss ? `<link rel="stylesheet" href="${hanaCss}">` : ''}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg-card,#FCFAF5);padding:6px}
img{display:block;max-width:100%;border-radius:8px}
.skeleton{aspect-ratio:${cssRatio};max-height:580px;background:linear-gradient(90deg,#f0ede8 25%,#e8e4de 50%,#f0ede8 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.video-wrap{position:relative;cursor:pointer;border-radius:8px;overflow:hidden}
.video-wrap video{display:block;max-width:100%;border-radius:8px}
.play-btn{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;background:rgba(0,0,0,0.5);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;pointer-events:none}
.failed{padding:12px;color:#c0392b;font-size:12px}
</style></head>
<body>${cellsHtml}
<script>
// Wait for images to load, then report final size
var imgs = document.querySelectorAll('img');
var pending = imgs.length;
function done() {
  var w = document.body.scrollWidth, h = document.body.scrollHeight;
  parent.postMessage({ type: 'resize-request', payload: { width: w, height: h } }, '*');
  parent.postMessage({ type: 'ready' }, '*');
}
if (!pending) { requestAnimationFrame(done); }
else {
  [].forEach.call(imgs, function(img) {
    if (img.complete) { if (--pending === 0) done(); }
    else { img.onload = img.onerror = function() { if (--pending === 0) done(); }; }
  });
}
// ResizeObserver for ongoing changes
new ResizeObserver(function() {
  parent.postMessage({ type: 'resize-request', payload: { width: document.body.scrollWidth, height: document.body.scrollHeight } }, '*');
}).observe(document.body);
</script>
</body></html>`;

    return c.html(html);
  });
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
