/**
 * cli.js — 终端交互界面
 *
 * 服务器启动后自动附加。通过 WebSocket 与本机 server 通信，
 * 和 Electron 前端走完全一样的协议。
 */
import readline from "readline";
import WebSocket from "ws";

// ── 终端颜色 ──
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
};

export function startCLI({ port, token, agentName, userName }) {
  const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;
  const apiBase = `http://127.0.0.1:${port}`;

  let ws = null;
  let isStreaming = false;
  let currentMood = "";
  let inMood = false;
  let inThinking = false;

  // ── HTTP 工具 ──
  async function api(path, opts = {}) {
    const headers = { "Authorization": `Bearer ${token}`, ...opts.headers };
    if (opts.body && typeof opts.body === "object") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${apiBase}${path}`, { ...opts, headers });
    return res.json();
  }

  // ── WebSocket ──
  function connect() {
    ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      showPrompt();
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      handleMessage(msg);
    });

    ws.on("close", () => {
      console.log(`\n${c.dim}连接断开${c.reset}`);
      process.exit(0);
    });

    ws.on("error", (err) => {
      console.error(`${c.red}WebSocket 错误: ${err.message}${c.reset}`);
    });
  }

  // ── 消息处理 ──
  function handleMessage(msg) {
    switch (msg.type) {
      case "text_delta":
        if (!isStreaming) {
          isStreaming = true;
          process.stdout.write("\n");
        }
        process.stdout.write(msg.delta);
        break;

      case "mood_start":
        inMood = true;
        currentMood = "";
        break;

      case "mood_text":
        currentMood += msg.delta;
        break;

      case "mood_end":
        inMood = false;
        // 灰色显示 mood
        if (currentMood.trim()) {
          process.stdout.write(`${c.gray}${c.italic}`);
          for (const line of currentMood.trim().split("\n")) {
            process.stdout.write(`  ${line}\n`);
          }
          process.stdout.write(`${c.reset}`);
        }
        currentMood = "";
        break;

      case "thinking_start":
        inThinking = true;
        process.stdout.write(`${c.dim}  thinking...${c.reset}`);
        break;

      case "thinking_delta":
        // 不显示内容，只保持提示
        break;

      case "thinking_end":
        inThinking = false;
        // 清除 "thinking..." 行
        process.stdout.write("\r\x1b[K");
        break;

      case "tool_start":
        process.stdout.write(`\n${c.dim}  ⚙ ${msg.name}${c.reset}`);
        break;

      case "tool_end":
        if (msg.success === false) {
          process.stdout.write(` ${c.red}✗${c.reset}`);
        }
        process.stdout.write("\n");
        break;

      case "turn_end":
        isStreaming = false;
        process.stdout.write("\n");
        showPrompt();
        break;

      case "error":
        process.stdout.write(`\n${c.red}错误: ${msg.message}${c.reset}\n`);
        isStreaming = false;
        showPrompt();
        break;

      case "session_title":
        // 静默，不显示
        break;

      case "status":
        // 静默
        break;
    }
  }

  // ── 输入 ──
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  function showPrompt() {
    process.stdout.write(`${c.cyan}${userName}${c.reset} ${c.dim}›${c.reset} `);
  }

  // 监听 ESC 键中断生成
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // 自己处理按键，同时喂给 readline
    process.stdin.on("data", (key) => {
      const keyStr = key.toString();

      // ESC
      if (keyStr === "\x1b" && isStreaming) {
        ws.send(JSON.stringify({ type: "abort" }));
        process.stdout.write(`\n${c.dim}(已中断)${c.reset}\n`);
        isStreaming = false;
        inThinking = false;
        showPrompt();
        return;
      }

      // Ctrl+C
      if (keyStr === "\x03") {
        if (isStreaming) {
          ws.send(JSON.stringify({ type: "abort" }));
          isStreaming = false;
          inThinking = false;
          process.stdout.write(`\n${c.dim}(已中断)${c.reset}\n`);
          showPrompt();
        } else {
          console.log(`\n${c.dim}再见 ✿${c.reset}`);
          process.exit(0);
        }
        return;
      }

      // Ctrl+D
      if (keyStr === "\x04") {
        console.log(`\n${c.dim}再见 ✿${c.reset}`);
        process.exit(0);
      }

      // 其他按键喂给 readline
      rl.write(key);
    });
  }

  rl.on("line", async (input) => {
    const line = input.trim();
    if (!line) {
      showPrompt();
      return;
    }

    // 如果正在流式输出，忽略
    if (isStreaming) return;

    // 斜杠命令
    if (line.startsWith("/")) {
      await handleCommand(line);
      return;
    }

    // 发送消息
    ws.send(JSON.stringify({ type: "prompt", text: line }));
  });

  // ── 斜杠命令 ──
  async function handleCommand(line) {
    const [cmd, ...args] = line.slice(1).split(/\s+/);

    switch (cmd) {
      case "help":
      case "h":
        console.log(`
${c.bold}命令列表${c.reset}
  ${c.cyan}/model${c.reset}              查看当前模型
  ${c.cyan}/model set${c.reset}          切换模型（交互式）
  ${c.cyan}/config${c.reset}             查看配置
  ${c.cyan}/session new${c.reset}        新建会话
  ${c.cyan}/session list${c.reset}       列出会话
  ${c.cyan}/agent${c.reset}              查看当前 agent
  ${c.cyan}/agent list${c.reset}         列出所有 agent
  ${c.cyan}/agent switch <id>${c.reset}  切换 agent
  ${c.cyan}/jian${c.reset}               查看当前目录的笺
  ${c.cyan}/jian <subdir>${c.reset}      查看子目录的笺
  ${c.cyan}/ls${c.reset}                 列出书桌文件
  ${c.cyan}/ls <subdir>${c.reset}        列出子目录文件
  ${c.cyan}/cat <path>${c.reset}         查看文件内容
  ${c.cyan}/help${c.reset}               显示此帮助
  ${c.dim}ESC${c.reset}                 中断生成
  ${c.dim}Ctrl+C${c.reset}              中断生成 / 退出
`);
        showPrompt();
        break;

      case "model": {
        if (args[0] === "set") {
          const data = await api("/api/models");
          const models = data.models || [];
          if (!models.length) {
            console.log(`${c.yellow}没有可用模型${c.reset}`);
            showPrompt();
            return;
          }
          console.log(`\n${c.bold}可用模型：${c.reset}`);
          models.forEach((m, i) => {
            const current = m.name === data.current ? ` ${c.green}← 当前${c.reset}` : "";
            console.log(`  ${c.dim}${i + 1}.${c.reset} ${m.name}${current}`);
          });
          process.stdout.write(`\n输入编号选择: `);
          rl.once("line", async (answer) => {
            const idx = parseInt(answer.trim()) - 1;
            if (idx >= 0 && idx < models.length) {
              await api("/api/models/set", {
                method: "POST",
                body: { modelId: models[idx].name },
              });
              console.log(`${c.green}已切换到 ${models[idx].name}${c.reset}`);
            } else {
              console.log(`${c.dim}取消${c.reset}`);
            }
            showPrompt();
          });
          return;
        }
        const data = await api("/api/health");
        console.log(`${c.dim}当前模型:${c.reset} ${data.model || "(无)"}`);
        showPrompt();
        break;
      }

      case "config": {
        const data = await api("/api/config");
        console.log(`\n${c.bold}当前配置${c.reset}`);
        console.log(`  ${c.dim}Agent:${c.reset}  ${data.agent?.name || "Hanako"}`);
        console.log(`  ${c.dim}Yuan:${c.reset}   ${data.agent?.yuan || "hanako"}`);
        console.log(`  ${c.dim}User:${c.reset}   ${data.user?.name || "User"}`);
        console.log(`  ${c.dim}Locale:${c.reset} ${data.locale || "en"}`);
        console.log(`  ${c.dim}Model:${c.reset}  ${data.api?.model || "(未设置)"}`);
        console.log();
        showPrompt();
        break;
      }

      case "session": {
        if (args[0] === "new") {
          await api("/api/sessions/new", { method: "POST" });
          console.log(`${c.green}新会话已创建${c.reset}`);
          showPrompt();
        } else if (args[0] === "list") {
          const sessions = await api("/api/sessions");
          if (!sessions.length) {
            console.log(`${c.dim}暂无会话${c.reset}`);
          } else {
            console.log(`\n${c.bold}会话列表${c.reset}`);
            for (const s of sessions.slice(0, 15)) {
              const title = s.title || s.firstMessage || "(无标题)";
              const date = s.modified ? new Date(s.modified).toLocaleDateString() : "";
              console.log(`  ${c.dim}${date}${c.reset}  ${title.slice(0, 60)}`);
            }
            console.log();
          }
          showPrompt();
        } else {
          console.log(`${c.dim}用法: /session new | /session list${c.reset}`);
          showPrompt();
        }
        break;
      }

      case "agent": {
        if (args[0] === "list") {
          const data = await api("/api/agents");
          console.log(`\n${c.bold}Agent 列表${c.reset}`);
          for (const a of data.agents || []) {
            const current = a.id === data.currentAgentId ? ` ${c.green}← 当前${c.reset}` : "";
            console.log(`  ${c.dim}${a.id}${c.reset}  ${a.name}${current}`);
          }
          console.log();
          showPrompt();
        } else if (args[0] === "switch" && args[1]) {
          const result = await api("/api/agents/switch", {
            method: "POST",
            body: { id: args[1] },
          });
          if (result.error) {
            console.log(`${c.red}${result.error}${c.reset}`);
          } else {
            agentName = result.agentName || args[1];
            console.log(`${c.green}已切换到 ${agentName}${c.reset}`);
          }
          showPrompt();
        } else {
          const data = await api("/api/health");
          console.log(`${c.dim}当前 Agent:${c.reset} ${data.agent || agentName}`);
          showPrompt();
        }
        break;
      }

      case "jian": {
        const subdir = args.join(" ");
        const query = subdir ? `?subdir=${encodeURIComponent(subdir)}` : "";
        const data = await api(`/api/desk/jian${query}`);
        if (data.content) {
          console.log(`\n${c.dim}── 笺${subdir ? ` (${subdir})` : ""} ──${c.reset}`);
          console.log(data.content);
        } else {
          console.log(`${c.dim}此目录没有笺${c.reset}`);
        }
        showPrompt();
        break;
      }

      case "ls": {
        const subdir = args.join(" ");
        const query = subdir ? `?subdir=${encodeURIComponent(subdir)}` : "";
        const data = await api(`/api/desk/files${query}`);
        if (data.error) {
          console.log(`${c.red}${data.error}${c.reset}`);
        } else if (!data.files?.length) {
          console.log(`${c.dim}(空)${c.reset}`);
        } else {
          console.log(`\n${c.dim}${data.basePath}${subdir ? "/" + data.subdir : ""}${c.reset}`);
          for (const f of data.files) {
            const icon = f.isDir ? "📁" : "  ";
            const size = f.isDir ? "" : `  ${c.dim}${formatSize(f.size)}${c.reset}`;
            console.log(`  ${icon} ${f.name}${size}`);
          }
          console.log();
        }
        showPrompt();
        break;
      }

      case "cat": {
        const filePath = args.join(" ");
        if (!filePath) {
          console.log(`${c.dim}用法: /cat <文件路径>${c.reset}`);
          showPrompt();
          return;
        }
        try {
          const res = await fetch(`${apiBase}/api/fs/read?path=${encodeURIComponent(filePath)}`, {
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (res.ok) {
            const text = await res.text();
            console.log(`\n${c.dim}── ${filePath} ──${c.reset}`);
            console.log(text);
          } else {
            console.log(`${c.red}无法读取: ${res.status}${c.reset}`);
          }
        } catch (err) {
          console.log(`${c.red}错误: ${err.message}${c.reset}`);
        }
        showPrompt();
        break;
      }

      default:
        console.log(`${c.dim}未知命令: /${cmd}  输入 /help 查看帮助${c.reset}`);
        showPrompt();
    }
  }

  // ── 启动 ──
  console.log(`\n${c.bold}${agentName}${c.reset} ${c.dim}CLI${c.reset}`);
  console.log(`${c.dim}输入 /help 查看命令列表${c.reset}\n`);
  connect();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
