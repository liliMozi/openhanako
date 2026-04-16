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
import { StringEnum } from "../pi-sdk/index.js";
import { BrowserManager } from "../browser/browser-manager.js";
import { t } from "../../server/i18n.js";
import { toolOk } from "./tool-result.js";
import { getToolSessionPath } from "./tool-session.js";

/** Browser 专用错误：content 显示格式化文本，details.error 保留原始消息 */
function browserError(rawMsg) {
  return {
    content: [{ type: "text", text: t("error.browserError", { msg: rawMsg }) }],
    details: { error: rawMsg },
  };
}

/**
 * 创建浏览器工具
 * @param {(() => string|null)|undefined} getSessionPath - 返回当前 sessionPath 的回调
 * @returns {import('../pi-sdk/index.js').ToolDefinition}
 */
export function createBrowserTool(getSessionPath) {
  const browser = BrowserManager.instance();

  /** 操作日志 per-session（每次 start 时清空，记录所有操作供回看纠错） */
  const _actionLogs = new Map(); // sessionPath → action[]
  const ACTION_LOG_MAX_SESSIONS = 20;  // 最多保留 20 个 session 的日志
  const ACTION_LOG_MAX_PER_SESSION = 200; // 每个 session 最多 200 条

  function getActionLog(sessionPath) {
    return _actionLogs.get(sessionPath) || [];
  }

  function logAction(sessionPath, action, params, resultSummary, error) {
    if (!_actionLogs.has(sessionPath)) {
      _actionLogs.set(sessionPath, []);
      // 淘汰最早的 session 日志
      if (_actionLogs.size > ACTION_LOG_MAX_SESSIONS) {
        _actionLogs.delete(_actionLogs.keys().next().value);
      }
    }
    const log = _actionLogs.get(sessionPath);
    log.push({
      ts: new Date().toISOString(),
      action,
      params: params || {},
      result: error ? `ERROR: ${error}` : resultSummary,
      url: browser.currentUrl(sessionPath),
    });
    // 截断过长的单 session 日志
    if (log.length > ACTION_LOG_MAX_PER_SESSION) {
      log.splice(0, log.length - ACTION_LOG_MAX_PER_SESSION);
    }
  }

  /** 当前状态快照（附加到每个 action 的 details），运行时自动带缩略图 */
  async function statusFields(sessionPath) {
    const running = browser.isRunning(sessionPath);
    const url = browser.currentUrl(sessionPath);
    const fields = { running, url };
    if (running) {
      fields.thumbnail = await browser.thumbnail(sessionPath);
    }
    return fields;
  }

  return {
    name: "browser",
    label: t("toolDef.browser.label"),
    description: t("toolDef.browser.description"),
    parameters: Type.Object({
      action: StringEnum(
        ["start", "stop", "navigate", "snapshot", "screenshot", "click", "type", "scroll", "select", "key", "wait", "evaluate", "show"],
        { description: t("toolDef.browser.actionDesc") },
      ),
      url: Type.Optional(Type.String({ description: t("toolDef.browser.urlDesc") })),
      ref: Type.Optional(Type.Number({ description: t("toolDef.browser.refDesc") })),
      text: Type.Optional(Type.String({ description: t("toolDef.browser.textDesc") })),
      direction: Type.Optional(StringEnum(
        ["up", "down"],
        { description: t("toolDef.browser.directionDesc") },
      )),
      amount: Type.Optional(Type.Number({ description: t("toolDef.browser.amountDesc") })),
      value: Type.Optional(Type.String({ description: t("toolDef.browser.valueDesc") })),
      key: Type.Optional(Type.String({ description: t("toolDef.browser.keyDesc") })),
      expression: Type.Optional(Type.String({ description: t("toolDef.browser.expressionDesc") })),
      timeout: Type.Optional(Type.Number({ description: t("toolDef.browser.timeoutDesc") })),
      state: Type.Optional(Type.String({ description: t("toolDef.browser.stateDesc") })),
      pressEnter: Type.Optional(Type.Boolean({ description: t("toolDef.browser.pressEnterDesc") })),
    }),

    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      try {
        const sessionPath = getToolSessionPath(ctx);

        switch (params.action) {

          // ── start ──
          case "start": {
            if (browser.isRunning(sessionPath)) {
              logAction(sessionPath, "start", null, "already_running");
              return toolOk(t("error.browserAlreadyRunning"), { status: "already_running", ...await statusFields(sessionPath) });
            }
            _actionLogs.delete(sessionPath);
            await browser.launch(sessionPath);
            logAction(sessionPath, "start", null, "launched");
            return toolOk(t("error.browserLaunched"), { status: "launched", ...await statusFields(sessionPath) });
          }

          // ── stop ──
          case "stop": {
            if (!browser.isRunning(sessionPath)) {
              return toolOk(t("error.browserNotRunning"), { status: "not_running", running: false, url: null });
            }
            logAction(sessionPath, "stop", null, "closed");
            const sessionLog = [...getActionLog(sessionPath)];
            await browser.close(sessionPath);
            _actionLogs.delete(sessionPath);
            return toolOk(t("error.browserClosed"), { status: "closed", running: false, url: null, actionLog: sessionLog });
          }

          // ── navigate ──
          case "navigate": {
            if (!params.url) return browserError(t("error.browserNavigateNeedUrl"));
            const result = await browser.navigate(params.url, sessionPath);
            logAction(sessionPath, "navigate", { url: params.url }, result.title);
            return toolOk(
              t("error.browserNavigated", { title: result.title, url: result.url, snapshot: result.snapshot }),
              { action: "navigate", ...await statusFields(sessionPath), title: result.title },
            );
          }

          // ── snapshot ──
          case "snapshot": {
            const text = await browser.snapshot(sessionPath);
            return toolOk(text, { action: "snapshot", ...await statusFields(sessionPath) });
          }

          // ── screenshot ──
          case "screenshot": {
            const { base64, mimeType } = await browser.screenshot(sessionPath);
            return {
              content: [
                { type: "image", mimeType, data: base64 },
              ],
              details: { action: "screenshot", mimeType, ...await statusFields(sessionPath), thumbnail: base64 },
            };
          }

          // ── click ──
          case "click": {
            if (params.ref == null) return browserError(t("error.browserClickNeedRef"));
            const snapshot = await browser.click(params.ref, sessionPath);
            logAction(sessionPath, "click", { ref: params.ref }, `clicked [${params.ref}]`);
            return toolOk(t("error.browserClicked", { ref: params.ref, snapshot }), { action: "click", ref: params.ref, ...await statusFields(sessionPath) });
          }

          // ── type ──
          case "type": {
            if (params.text == null) return browserError(t("error.browserTypeNeedText"));
            const snapshot = await browser.type(params.text, params.ref, { pressEnter: params.pressEnter ?? false }, sessionPath);
            logAction(sessionPath, "type", { ref: params.ref, text: params.text.slice(0, 100) }, "typed");
            return toolOk(
              t("error.browserTyped", { target: params.ref != null ? ` to [${params.ref}]` : "", snapshot }),
              { action: "type", ref: params.ref, ...await statusFields(sessionPath) },
            );
          }

          // ── scroll ──
          case "scroll": {
            if (!params.direction) return browserError(t("error.browserScrollNeedDir"));
            const snapshot = await browser.scroll(params.direction, params.amount ?? 3, sessionPath);
            logAction(sessionPath, "scroll", { direction: params.direction, amount: params.amount }, "scrolled");
            return toolOk(
              t("error.browserScrolled", { dir: params.direction, snapshot }),
              { action: "scroll", direction: params.direction, ...await statusFields(sessionPath) },
            );
          }

          // ── select ──
          case "select": {
            if (params.ref == null) return browserError(t("error.browserSelectNeedRef"));
            if (!params.value) return browserError(t("error.browserSelectNeedValue"));
            const snapshot = await browser.select(params.ref, params.value, sessionPath);
            return toolOk(
              t("error.browserSelected", { ref: params.ref, value: params.value, snapshot }),
              { action: "select", ref: params.ref, value: params.value, ...await statusFields(sessionPath) },
            );
          }

          // ── key ──
          case "key": {
            if (!params.key) return browserError(t("error.browserKeyNeedKey"));
            const snapshot = await browser.pressKey(params.key, sessionPath);
            return toolOk(t("error.browserKeyPressed", { key: params.key, snapshot }), { action: "key", key: params.key, ...await statusFields(sessionPath) });
          }

          // ── wait ──
          case "wait": {
            const snapshot = await browser.wait({
              timeout: params.timeout ?? 5000,
              state: params.state ?? "domcontentloaded",
            }, sessionPath);
            return toolOk(t("error.browserWaitDone", { snapshot }), { action: "wait", ...await statusFields(sessionPath) });
          }

          // ── evaluate ──
          case "evaluate": {
            if (!params.expression) return browserError(t("error.browserEvalNeedExpr"));
            const result = await browser.evaluate(params.expression, sessionPath);
            const truncated = result.length > 30000
              ? result.slice(0, 30000) + t("error.browserOutputTruncated")
              : result;
            return toolOk(truncated, { action: "evaluate", ...await statusFields(sessionPath) });
          }

          // ── show ──
          case "show": {
            await browser.show(sessionPath);
            return toolOk(t("error.browserShown"), { action: "show", ...await statusFields(sessionPath) });
          }

          default:
            return browserError(t("error.browserUnknownAction", { action: params.action }));
        }
      } catch (error) {
        const sessionPath = getToolSessionPath(ctx);
        logAction(sessionPath, params.action, params, null, error.message);
        return browserError(t("error.browserActionFailed", { msg: error.message }));
      }
    },
  };
}
