/**
 * image-gen/routes/card.js
 *
 * Iframe card for chat messages. Self-polls while tasks are pending.
 * Three states: pending (skeleton), success (image/video), failed (error).
 */

export default function (app, ctx) {
  app.get("/card", (c) => {
    const batchId = c.req.query("batch");
    if (!batchId) return c.text("Missing batch parameter", 400);

    const pluginId = ctx.pluginId;
    const apiBase = `/api/plugins/${pluginId}`;

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: "Noto Serif SC", "Source Han Serif SC", serif;
  background: transparent;
  padding: 8px;
}
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cell {
  width: 200px;
  border-radius: 4px;
  overflow: hidden;
  background: #f5f3ef;
  position: relative;
}
.cell img {
  width: 100%;
  display: block;
}
.skeleton {
  width: 200px;
  height: 200px;
  background: linear-gradient(90deg, #f0ede8 25%, #e8e4de 50%, #f0ede8 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.prompt {
  padding: 6px 8px;
  font-size: 12px;
  color: #6b6560;
  line-height: 1.4;
}
.deleted {
  width: 200px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  font-size: 12px;
}
.badge {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0,0,0,0.5);
  color: #fff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
}
.failed {
  color: #c0392b;
  font-size: 12px;
  padding: 12px;
}
</style>
</head>
<body>
<div class="grid" id="grid"></div>
<script>
const BATCH = "${batchId}";
const API = "${apiBase}";
let pollTimer = null;

async function render() {
  const resp = await fetch(API + "/tasks/batch/" + BATCH);
  const { tasks } = await resp.json();
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  let hasPending = false;
  for (const t of tasks) {
    const cell = document.createElement("div");
    cell.className = "cell";

    if (t.status === "pending") {
      hasPending = true;
      cell.innerHTML = '<div class="skeleton"></div><div class="prompt">' + esc(t.prompt) + '</div>';
    } else if (t.status === "success" && t.files?.length) {
      const file = t.files[0];
      const isVideo = file.endsWith(".mp4") || file.endsWith(".mov");
      if (isVideo) {
        cell.innerHTML = '<div style="width:200px;height:150px;background:#222;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;">▶</div>';
      } else {
        cell.innerHTML = '<img src="' + API + '/media/' + file + '" loading="lazy">';
      }
      cell.innerHTML += '<div class="prompt">' + esc(t.prompt) + '</div>';
    } else if (t.status === "failed") {
      cell.innerHTML = '<div class="failed">生成失败：' + esc(t.failReason || "未知") + '</div>';
    } else {
      cell.innerHTML = '<div class="deleted">文件已删除</div>';
    }
    grid.appendChild(cell);
  }

  // Stop polling when all done
  if (!hasPending && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Start polling if pending
  if (hasPending && !pollTimer) {
    pollTimer = setInterval(render, 5000);
  }

  // Notify parent frame ready
  window.parent.postMessage({ type: "ready" }, "*");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

render();
</script>
</body>
</html>`;

    return c.html(html);
  });
}
