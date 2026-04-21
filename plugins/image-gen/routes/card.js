/**
 * image-gen/routes/card.js
 *
 * Iframe card for chat messages. Server-rendered initial state + client-side
 * polling with per-cell DOM swap. 已加载完整的 cell 在后续轮询中不动，避免
 * meta refresh 整页重载导致的"逐行重绘"撕裂感。
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
    const ratio = tasks[0]?.params?.ratio || "1:1";

    function renderCellInner(t) {
      if (t.status === "done" && t.files?.length) {
        const file = t.files[0];
        const isVideo = file.endsWith(".mp4") || file.endsWith(".mov");
        if (isVideo) {
          const videoUrl = `${mediaBase}/media/${esc(file)}${tokenParam}`;
          const openUrl = `${mediaBase}/media/open/${esc(file)}${tokenParam ? tokenParam + '&' : '?'}token=${token}`;
          return `<div class="video-wrap" onclick="fetch('${openUrl}',{method:'POST'})"><video src="${videoUrl}" preload="metadata" muted playsinline></video><div class="play-btn">▶</div></div>`;
        }
        return `<img src="${mediaBase}/media/${esc(file)}${tokenParam}">`;
      }
      if (t.status === "failed") {
        return `<div class="failed">${esc(t.failReason || "生成失败")}</div>`;
      }
      // pending / cancelled / unknown → skeleton
      return `<div class="skeleton"></div>`;
    }

    let cellsHtml = "";
    for (const t of tasks) {
      const state = t.status || "pending";
      cellsHtml += `<div class="cell" data-task-id="${esc(t.taskId)}" data-state="${esc(state)}">${renderCellInner(t)}</div>`;
    }
    if (!tasks.length) cellsHtml = `<div class="failed">任务不存在</div>`;

    const [rw, rh] = ratio.split(":").map(Number);
    const cssRatio = (rw && rh) ? `${rw}/${rh}` : "1/1";

    const pollApi = `${mediaBase}/tasks/batch/${encodeURIComponent(batchId)}${tokenParam}`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${hanaCss ? `<link rel="stylesheet" href="${hanaCss}">` : ''}
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg-card,#FCFAF5);padding:6px}
.cell{display:block}
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
(function(){
  var pollApi = ${JSON.stringify(pollApi)};
  var mediaBase = ${JSON.stringify(mediaBase)};
  var tokenParam = ${JSON.stringify(tokenParam)};
  var token = ${JSON.stringify(token)};
  var hasPending = ${hasPending ? "true" : "false"};
  var POLL_MS = 2000;
  var ERROR_BACKOFF_MS = 3000;
  var timer = null;

  function escHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function buildInner(t) {
    if (t.status === 'done' && t.files && t.files.length) {
      var file = t.files[0];
      var isVideo = /\\.(mp4|mov)$/i.test(file);
      var encoded = escHtml(file);
      if (isVideo) {
        var videoUrl = mediaBase + '/media/' + encoded + tokenParam;
        var openUrl = mediaBase + '/media/open/' + encoded + (tokenParam ? tokenParam + '&' : '?') + 'token=' + token;
        return '<div class="video-wrap" onclick="fetch(\\'' + openUrl + '\\',{method:\\'POST\\'})">' +
               '<video src="' + videoUrl + '" preload="metadata" muted playsinline></video>' +
               '<div class="play-btn">▶</div></div>';
      }
      return '<img src="' + mediaBase + '/media/' + encoded + tokenParam + '">';
    }
    if (t.status === 'failed') {
      return '<div class="failed">' + escHtml(t.failReason || '生成失败') + '</div>';
    }
    return '<div class="skeleton"></div>';
  }

  function findCell(taskId) {
    // taskId 是 base36 字符串（无引号/斜杠），直接拼 selector 安全；仍兜底 escape
    var safe = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (safe !== String(taskId)) return null;
    return document.querySelector('[data-task-id="' + safe + '"]');
  }

  async function poll() {
    timer = null;
    try {
      var res = await fetch(pollApi, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      var data = await res.json();
      var tasks = (data && data.tasks) || [];
      var stillPending = false;
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (t.status === 'pending') stillPending = true;
        var cell = findCell(t.taskId);
        if (!cell) continue;
        if (cell.dataset.state === t.status) continue;
        // 状态变了——只替换这一个 cell 的 innerHTML
        // 其他 cell（包括已 done 的 img）完全不动，不会被重新解码
        cell.innerHTML = buildInner(t);
        cell.dataset.state = t.status;
      }
      if (stillPending) {
        timer = setTimeout(poll, POLL_MS);
      }
    } catch (e) {
      timer = setTimeout(poll, ERROR_BACKOFF_MS);
    }
  }

  function notifyResize() {
    parent.postMessage({
      type: 'resize-request',
      payload: { width: document.body.scrollWidth, height: document.body.scrollHeight },
    }, '*');
  }

  // 初次加载：等现有 img 加载完毕再报 ready（避免 iframe 显示成半透明）
  var imgs = document.querySelectorAll('img');
  var remaining = imgs.length;
  function initialReady() {
    notifyResize();
    parent.postMessage({ type: 'ready' }, '*');
  }
  if (!remaining) {
    requestAnimationFrame(initialReady);
  } else {
    [].forEach.call(imgs, function(img) {
      if (img.complete) { if (--remaining === 0) initialReady(); }
      else img.onload = img.onerror = function() { if (--remaining === 0) initialReady(); };
    });
  }

  // DOM 尺寸变化（cell 替换后）自动通知父窗口
  new ResizeObserver(notifyResize).observe(document.body);

  // 只有还有 pending 任务时才启动轮询；全 done/failed 直接静止
  if (hasPending) timer = setTimeout(poll, POLL_MS);
})();
</script>
</body></html>`;

    return c.html(html);
  });
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
