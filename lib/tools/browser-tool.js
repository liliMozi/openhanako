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
import { toolOk, toolError } from "./tool-result.js";

/**
 * 创建浏览器工具
 * @returns {import('../pi-sdk/index.js').ToolDefinition}
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

    execute: async (_toolCallId, params) => {
      try {
        switch (params.action) {

          // ── start ──
          case "start": {
            if (browser.isRunning) {
              logAction("start", null, "already_running");
              return toolOk(t("error.browserAlreadyRunning"), { status: "already_running", ...await statusFields() });
            }
            _actionLog = [];
            await browser.launch();
            logAction("start", null, "launched");
            return toolOk(t("error.browserLaunched"), { status: "launched", ...await statusFields() });
          }

          // ── stop ──
          case "stop": {
            if (!browser.isRunning) {
              return toolOk(t("error.browserNotRunning"), { status: "not_running", running: false, url: null });
            }
            logAction("stop", null, "closed");
            const sessionLog = [..._actionLog];
            await browser.close();
            return toolOk(t("error.browserClosed"), { status: "closed", running: false, url: null, actionLog: sessionLog });
          }

          // ── navigate ──
          case "navigate": {
            if (!params.url) return toolError(t("error.browserError", { msg: t("error.browserNavigateNeedUrl") }));
            const result = await browser.navigate(params.url);
            logAction("navigate", { url: params.url }, result.title);
            return toolOk(
              t("error.browserNavigated", { title: result.title, url: result.url, snapshot: result.snapshot }),
              { action: "navigate", ...await statusFields(), title: result.title },
            );
          }

          // ── snapshot ──
          case "snapshot": {
            const text = await browser.snapshot();
            return toolOk(text, { action: "snapshot", ...await statusFields() });
          }

          // ── screenshot ──
          case "screenshot": {
            const { base64, mimeType } = await browser.screenshot();
            return {
              content: [
                { type: "image", mimeType, data: base64 },
              ],
              details: { action: "screenshot", mimeType, ...await statusFields(), thumbnail: base64 },
            };
          }

          // ── click ──
          case "click": {
            if (params.ref == null) return toolError(t("error.browserError", { msg: t("error.browserClickNeedRef") }));
            const snapshot = await browser.click(params.ref);
            logAction("click", { ref: params.ref }, `clicked [${params.ref}]`);
            return toolOk(t("error.browserClicked", { ref: params.ref, snapshot }), { action: "click", ref: params.ref, ...await statusFields() });
          }

          // ── type ──
          case "type": {
            if (params.text == null) return toolError(t("error.browserError", { msg: t("error.browserTypeNeedText") }));
            const snapshot = await browser.type(params.text, params.ref, { pressEnter: params.pressEnter ?? false });
            logAction("type", { ref: params.ref, text: params.text.slice(0, 100) }, "typed");
            return toolOk(
              t("error.browserTyped", { target: params.ref != null ? ` to [${params.ref}]` : "", snapshot }),
              { action: "type", ref: params.ref, ...await statusFields() },
            );
          }

          // ── scroll ──
          case "scroll": {
            if (!params.direction) return toolError(t("error.browserError", { msg: t("error.browserScrollNeedDir") }));
            const snapshot = await browser.scroll(params.direction, params.amount ?? 3);
            logAction("scroll", { direction: params.direction, amount: params.amount }, "scrolled");
            return toolOk(
              t("error.browserScrolled", { dir: params.direction, snapshot }),
              { action: "scroll", direction: params.direction, ...await statusFields() },
            );
          }

          // ── select ──
          case "select": {
            if (params.ref == null) return toolError(t("error.browserError", { msg: t("error.browserSelectNeedRef") }));
            if (!params.value) return toolError(t("error.browserError", { msg: t("error.browserSelectNeedValue") }));
            const snapshot = await browser.select(params.ref, params.value);
            return toolOk(
              t("error.browserSelected", { ref: params.ref, value: params.value, snapshot }),
              { action: "select", ref: params.ref, value: params.value, ...await statusFields() },
            );
          }

          // ── key ──
          case "key": {
            if (!params.key) return toolError(t("error.browserError", { msg: t("error.browserKeyNeedKey") }));
            const snapshot = await browser.pressKey(params.key);
            return toolOk(t("error.browserKeyPressed", { key: params.key, snapshot }), { action: "key", key: params.key, ...await statusFields() });
          }

          // ── wait ──
          case "wait": {
            const snapshot = await browser.wait({
              timeout: params.timeout ?? 5000,
              state: params.state ?? "domcontentloaded",
            });
            return toolOk(t("error.browserWaitDone", { snapshot }), { action: "wait", ...await statusFields() });
          }

          // ── evaluate ──
          case "evaluate": {
            if (!params.expression) return toolError(t("error.browserError", { msg: t("error.browserEvalNeedExpr") }));
            const result = await browser.evaluate(params.expression);
            const truncated = result.length > 30000
              ? result.slice(0, 30000) + t("error.browserOutputTruncated")
              : result;
            return toolOk(truncated, { action: "evaluate", ...await statusFields() });
          }

          // ── show ──
          case "show": {
            await browser.show();
            return toolOk(t("error.browserShown"), { action: "show", ...await statusFields() });
          }

          default:
            return toolError(t("error.browserError", { msg: t("error.browserUnknownAction", { action: params.action }) }));
        }
      } catch (error) {
        logAction(params.action, params, null, error.message);
        return toolError(t("error.browserError", { msg: t("error.browserActionFailed", { msg: error.message }) }));
      }
    },
  };
}
