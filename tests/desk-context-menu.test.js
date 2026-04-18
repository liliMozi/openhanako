import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = "";
    this.textContent = "";
    this._listeners = new Map();
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    if (idx >= 0) siblings.splice(idx, 1);
    this.parentNode = null;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }

  addEventListener(type, handler) {
    const handlers = this._listeners.get(type) || [];
    handlers.push(handler);
    this._listeners.set(type, handlers);
  }

  click() {
    const handlers = this._listeners.get("click") || [];
    for (const handler of handlers) {
      handler({ stopPropagation() {} });
    }
  }

  getBoundingClientRect() {
    return { width: 120, height: 80 };
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement("body");
    this._listeners = [];
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  addEventListener(type, handler, options) {
    const capture = options === true || options?.capture === true;
    this._listeners.push({ type, handler, capture });
  }

  removeEventListener(type, handler, options) {
    const capture = options === true || options?.capture === true;
    this._listeners = this._listeners.filter(listener => (
      listener.type !== type ||
      listener.handler !== handler ||
      listener.capture !== capture
    ));
  }

  listenerCount(type) {
    return this._listeners.filter(listener => listener.type === type).length;
  }

  dispatch(type, target) {
    const listeners = this._listeners
      .filter(listener => listener.type === type)
      .map(listener => listener.handler);
    for (const handler of listeners) {
      handler({ target });
    }
  }
}

/**
 * 构建一个命令式 showContextMenu / hideContextMenu pair（与 bridge.ts compat shim 逻辑一致）。
 * 测试验证 DOM 菜单的打开、关闭和 listener 清理行为。
 */
function createContextMenuPair() {
  let _cleanup = null;

  function hideContextMenu() {
    const m = globalThis.window.__ctxMenu;
    if (m) { m.remove(); globalThis.window.__ctxMenu = null; }
    if (_cleanup) { _cleanup(); _cleanup = null; }
  }

  function showContextMenu(x, y, items) {
    hideContextMenu();
    const doc = globalThis.document;
    const menu = doc.createElement("div");
    menu.className = "context-menu";
    for (const item of items) {
      if (item.divider) { const d = doc.createElement("div"); d.className = "context-menu-divider"; menu.appendChild(d); continue; }
      const el = doc.createElement("div");
      el.className = "context-menu-item" + (item.danger ? " danger" : "");
      el.textContent = item.label || "";
      el.addEventListener("click", (e) => { e.stopPropagation(); hideContextMenu(); item.action?.(); });
      menu.appendChild(el);
    }
    doc.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (x + rect.width > globalThis.window.innerWidth) x = globalThis.window.innerWidth - rect.width - 4;
    if (y + rect.height > globalThis.window.innerHeight) y = globalThis.window.innerHeight - rect.height - 4;
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    globalThis.window.__ctxMenu = menu;

    setTimeout(() => {
      if (globalThis.window.__ctxMenu !== menu) return;
      const close = (ev) => {
        if (globalThis.window.__ctxMenu?.contains(ev.target)) return;
        hideContextMenu();
      };
      doc.addEventListener("click", close, true);
      doc.addEventListener("contextmenu", close, true);
      _cleanup = () => {
        doc.removeEventListener("click", close, true);
        doc.removeEventListener("contextmenu", close, true);
      };
    });
  }

  return { showContextMenu, hideContextMenu };
}

describe("desk context menu cleanup", () => {
  let doc;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new FakeDocument();
    globalThis.document = doc;
    globalThis.window = {
      innerWidth: 320,
      innerHeight: 240,
      __ctxMenu: null,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
    delete globalThis.window;
  });

  it("replaces document listeners when reopening and fully cleans up on outside click", async () => {
    const { showContextMenu } = createContextMenuPair();

    showContextMenu(10, 10, [{ label: "A" }]);
    await vi.runAllTimersAsync();

    expect(doc.body.children).toHaveLength(1);
    expect(doc.listenerCount("click")).toBe(1);
    expect(doc.listenerCount("contextmenu")).toBe(1);

    showContextMenu(20, 20, [{ label: "B" }]);
    await vi.runAllTimersAsync();

    expect(doc.body.children).toHaveLength(1);
    expect(doc.listenerCount("click")).toBe(1);
    expect(doc.listenerCount("contextmenu")).toBe(1);

    doc.dispatch("click", new FakeElement("outside"));

    expect(doc.body.children).toHaveLength(0);
    expect(doc.listenerCount("click")).toBe(0);
    expect(doc.listenerCount("contextmenu")).toBe(0);
  });

  it("keeps the menu open when the capture listener sees events from inside the menu", async () => {
    const { showContextMenu } = createContextMenuPair();

    showContextMenu(12, 16, [{ label: "Rename" }]);
    await vi.runAllTimersAsync();

    const menu = doc.body.children[0];
    doc.dispatch("contextmenu", menu);
    expect(doc.body.children).toHaveLength(1);

    const menuItem = menu.children[0];
    menuItem.click();
    expect(doc.body.children).toHaveLength(0);
    expect(doc.listenerCount("click")).toBe(0);
    expect(doc.listenerCount("contextmenu")).toBe(0);
  });
});
