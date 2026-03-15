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

describe("desk context menu cleanup", () => {
  let doc;
  let setupDeskShim;

  beforeEach(async () => {
    vi.useFakeTimers();
    doc = new FakeDocument();
    globalThis.document = doc;
    globalThis.window = {
      innerWidth: 320,
      innerHeight: 240,
    };
    vi.resetModules();
    ({ setupDeskShim } = await import("../desktop/src/react/shims/desk-shim.ts"));
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
    delete globalThis.window;
  });

  it("replaces document listeners when reopening and fully cleans up on outside click", async () => {
    const modules = {};
    setupDeskShim(modules);
    const { showContextMenu } = modules.desk;

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
    const modules = {};
    setupDeskShim(modules);
    const { showContextMenu } = modules.desk;

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
