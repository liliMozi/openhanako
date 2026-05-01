const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

export function createMockComputerProvider({ providerId = "mock" } = {}) {
  const actions = [];

  return {
    providerId,
    capabilities: {
      platform: "sandbox",
      observationModes: ["vision-native"],
      screenshot: true,
      accessibilityTree: true,
      elementActions: true,
      backgroundControl: "full",
      pointClick: "requiresApproval",
      drag: "unsupported",
      textInput: "semantic",
      keyboardInput: "pidScoped",
      requiresForegroundForInput: false,
      isolated: true,
    },

    async getStatus() {
      return { providerId, available: true, permissions: [] };
    },

    async requestPermissions() {
      return { providerId, available: true, permissions: [] };
    },

    async listApps() {
      return [{ appId: "app.notes", name: "Mock Notes", windows: [{ windowId: "win-1", title: "Notes" }] }];
    },

    async createLease(_ctx, target) {
      return {
        providerId,
        appId: target?.appId || "app.notes",
        windowId: target?.windowId || "win-1",
        allowedActions: ["click_element", "double_click", "type_text", "press_key", "scroll", "perform_secondary_action", "stop"],
        providerState: {
          appId: target?.appId || "app.notes",
          windowId: target?.windowId || "win-1",
          mock: true,
        },
      };
    },

    async releaseLease() {
      return { released: true };
    },

    async getAppState(_ctx, lease) {
      return {
        mode: "vision-native",
        appId: lease.appId,
        windowId: lease.windowId || "win-1",
        screenshot: { type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG_BASE64 },
        display: { width: 800, height: 600, scaleFactor: 1 },
        focusedElementId: "mock-input",
        elements: [
          {
            elementId: "mock-button",
            role: "button",
            label: "Continue",
            bounds: { x: 100, y: 120, width: 160, height: 44 },
            enabled: true,
          },
          {
            elementId: "mock-input",
            role: "textbox",
            label: "Name",
            value: "",
            bounds: { x: 100, y: 180, width: 260, height: 36 },
            enabled: true,
          },
        ],
      };
    },

    async performAction(_ctx, lease, action) {
      actions.push({ leaseId: lease.leaseId, action });
      return { ok: true, action: action.type };
    },

    async stop() {
      actions.push({ action: { type: "stop" } });
      return { ok: true };
    },

    get actions() {
      return [...actions];
    },
  };
}
