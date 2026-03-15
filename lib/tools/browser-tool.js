/**
 * browser-tool.js — 浏览器控制工具
 *
 * 单一 tool，通过 action 字段选择子命令。
 * 感知主要基于 AXTree snapshot（文本，便宜），截图为辅助。
 *
 * 每个动作的 details 都包含 { running, url, thumbnail? } 状态字段，
 * 供 chat.js 拦截后推送 browser_status WS 事件给前端。
 *
 * 操作：
 * - start    启动浏览器
 * - stop     关闭浏览器
 * - navigate 导航到 URL
 * - snapshot  获取当前页面的无障碍树
 * - screenshot 截取当前页面截图
 * - click    点击元素（by ref）
 * - type     输入文本
 * - scroll   滚动页面
 * - select   选择下拉选项
 * - key      按键
 * - wait     等待页面加载
 * - evaluate 执行页面 JavaScript
 * - show     将浏览器窗口置前
 */

import { Type } from "@sinclair/typebox";
import { BrowserManager } from "../browser/browser-manager.js";

/** 成功结果 */
function ok(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

/** 错误结果 */
function err(text) {
  return {
    content: [{ type: "text", text: `错误: ${text}` }],
    details: { error: text },
  };
}

/**
 * 创建浏览器工具
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createBrowserTool() {
  const browser = BrowserManager.instance();

  /** 操作日志（每次 start 时清空，记录所有操作供回看纠错） */
  let _actionLog = [];

  function logAction(action, params, resultSummary, error) {
    _actionLog.push({
      ts: new Date().toISOString(),
      action,
      params: params || {},
      result: error ? `ERROR: ${error}` : resultSummary,
      url: browser.currentUrl,
    });
  }

  /** 当前状态快照（附加到每个 action 的 details），运行时自动带缩略图 */
  async function statusFields() {
    const fields = { running: browser.isRunning, url: browser.currentUrl };
    if (browser.isRunning) {
      fields.thumbnail = await browser.thumbnail();
    }
    return fields;
  }

  return {
    name: "browser",
    label: "浏览器",
    description:
      "控制浏览器浏览网页。可以导航、点击、输入、滚动、截图。\n" +
      "操作：\n" +
      "- start：启动浏览器（首次使用前必须调用）\n" +
      "- stop：关闭浏览器\n" +
      "- navigate(url)：导航到指定 URL\n" +
      "- snapshot：获取当前页面的元素树（推荐：文本格式，成本低）\n" +
      "- screenshot：截取当前页面截图（仅在需要视觉信息时使用）\n" +
      "- click(ref)：点击 snapshot 返回的 [ref] 编号对应的元素\n" +
      "- type(text, ref?)：在元素中输入文本，可选先点击 ref 聚焦\n" +
      "- scroll(direction, amount?)：滚动页面，direction 为 up/down\n" +
      "- select(ref, value)：选择下拉菜单选项\n" +
      "- key(key)：按键，如 Enter、Escape、Tab、Control+a\n" +
      "- wait(timeout?, state?)：等待页面加载\n" +
      "- evaluate(expression)：执行页面 JavaScript\n" +
      "- show：将浏览器窗口置于前台\n\n" +
      "重要：snapshot 返回的 [ref] 编号在页面变化后会失效，每次 navigate/click 后会自动返回新的 snapshot。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("stop"),
        Type.Literal("navigate"),
        Type.Literal("snapshot"),
        Type.Literal("screenshot"),
        Type.Literal("click"),
        Type.Literal("type"),
        Type.Literal("scroll"),
        Type.Literal("select"),
        Type.Literal("key"),
        Type.Literal("wait"),
        Type.Literal("evaluate"),
        Type.Literal("show"),
      ], { description: "操作类型" }),
      url: Type.Optional(Type.String({ description: "URL（navigate 时必填）" })),
      ref: Type.Optional(Type.Number({ description: "元素 ref 编号（click/type/select 时使用）" })),
      text: Type.Optional(Type.String({ description: "输入文本（type 时必填）" })),
      direction: Type.Optional(Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
      ], { description: "滚动方向（scroll 时必填）" })),
      amount: Type.Optional(Type.Number({ description: "滚动量（scroll 时可选，默认 3）" })),
      value: Type.Optional(Type.String({ description: "选项值（select 时必填）" })),
      key: Type.Optional(Type.String({ description: "按键名（key 时必填），如 Enter、Escape、Tab、Control+a" })),
      expression: Type.Optional(Type.String({ description: "JavaScript 表达式（evaluate 时必填）" })),
      timeout: Type.Optional(Type.Number({ description: "超时毫秒数（wait 时可选，默认 5000）" })),
      state: Type.Optional(Type.String({ description: "等待状态（wait 时可选）：domcontentloaded / idle" })),
      pressEnter: Type.Optional(Type.Boolean({ description: "输入后按回车（type 时可选）" })),
    }),

    execute: async (_toolCallId, params) => {
      try {
        switch (params.action) {

          // ── start ──
          case "start": {
            if (browser.isRunning) {
              logAction("start", null, "already_running");
              return ok("浏览器已在运行中", { status: "already_running", ...await statusFields() });
            }
            _actionLog = [];
            await browser.launch();
            logAction("start", null, "launched");
            return ok("浏览器已启动", { status: "launched", ...await statusFields() });
          }

          // ── stop ──
          case "stop": {
            if (!browser.isRunning) {
              return ok("浏览器未在运行", { status: "not_running", running: false, url: null });
            }
            logAction("stop", null, "closed");
            const sessionLog = [..._actionLog];
            await browser.close();
            return ok("浏览器已关闭", { status: "closed", running: false, url: null, actionLog: sessionLog });
          }

          // ── navigate ──
          case "navigate": {
            if (!params.url) return err("navigate 需要 url 参数");
            const result = await browser.navigate(params.url);
            logAction("navigate", { url: params.url }, result.title);
            return ok(
              `已导航到 ${result.title}\nURL: ${result.url}\n\n${result.snapshot}`,
              { action: "navigate", ...await statusFields(), title: result.title },
            );
          }

          // ── snapshot ──
          case "snapshot": {
            const text = await browser.snapshot();
            return ok(text, { action: "snapshot", ...await statusFields() });
          }

          // ── screenshot ──
          case "screenshot": {
            const { base64, mimeType } = await browser.screenshot();
            return {
              content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
              ],
              details: { action: "screenshot", mimeType, ...await statusFields(), thumbnail: base64 },
            };
          }

          // ── click ──
          case "click": {
            if (params.ref == null) return err("click 需要 ref 参数");
            const snapshot = await browser.click(params.ref);
            logAction("click", { ref: params.ref }, `clicked [${params.ref}]`);
            return ok(`已点击 [${params.ref}]\n\n${snapshot}`, { action: "click", ref: params.ref, ...await statusFields() });
          }

          // ── type ──
          case "type": {
            if (params.text == null) return err("type 需要 text 参数");
            const snapshot = await browser.type(params.text, params.ref, { pressEnter: params.pressEnter ?? false });
            logAction("type", { ref: params.ref, text: params.text.slice(0, 100) }, "typed");
            return ok(
              `已输入文本${params.ref != null ? ` 到 [${params.ref}]` : ""}\n\n${snapshot}`,
              { action: "type", ref: params.ref, ...await statusFields() },
            );
          }

          // ── scroll ──
          case "scroll": {
            if (!params.direction) return err("scroll 需要 direction 参数（up/down）");
            const snapshot = await browser.scroll(params.direction, params.amount ?? 3);
            logAction("scroll", { direction: params.direction, amount: params.amount }, "scrolled");
            return ok(
              `已向${params.direction === "up" ? "上" : "下"}滚动\n\n${snapshot}`,
              { action: "scroll", direction: params.direction, ...await statusFields() },
            );
          }

          // ── select ──
          case "select": {
            if (params.ref == null) return err("select 需要 ref 参数");
            if (!params.value) return err("select 需要 value 参数");
            const snapshot = await browser.select(params.ref, params.value);
            return ok(
              `已选择 [${params.ref}] → "${params.value}"\n\n${snapshot}`,
              { action: "select", ref: params.ref, value: params.value, ...await statusFields() },
            );
          }

          // ── key ──
          case "key": {
            if (!params.key) return err("key 需要 key 参数");
            const snapshot = await browser.pressKey(params.key);
            return ok(`已按键 ${params.key}\n\n${snapshot}`, { action: "key", key: params.key, ...await statusFields() });
          }

          // ── wait ──
          case "wait": {
            const snapshot = await browser.wait({
              timeout: params.timeout ?? 5000,
              state: params.state ?? "domcontentloaded",
            });
            return ok(`等待完成\n\n${snapshot}`, { action: "wait", ...await statusFields() });
          }

          // ── evaluate ──
          case "evaluate": {
            if (!params.expression) return err("evaluate 需要 expression 参数");
            const result = await browser.evaluate(params.expression);
            const truncated = result.length > 8000
              ? result.slice(0, 8000) + "\n\n[... 输出已截断]"
              : result;
            return ok(truncated, { action: "evaluate", ...await statusFields() });
          }

          // ── show ──
          case "show": {
            await browser.show();
            return ok("浏览器窗口已置前", { action: "show", ...await statusFields() });
          }

          default:
            return err(`未知操作: ${params.action}`);
        }
      } catch (error) {
        logAction(params.action, params, null, error.message);
        return err(`浏览器操作失败: ${error.message}`);
      }
    },
  };
}
