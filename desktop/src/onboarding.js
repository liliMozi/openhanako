/**
 * Hanako Desktop — Onboarding Wizard
 *
 * 5 步引导：欢迎 → 名字 → API 供应商 → 模型选择 → 功能介绍
 * 独立 BrowserWindow，通过 HTTP 与已启动的 Server 通信。
 */

// 阻止拖拽默认行为
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── URL 参数模式 ──
const _params = new URLSearchParams(window.location.search);
const PREVIEW = _params.has("preview");           // 纯 UI 预览，不调 API 不写配置
const SKIP_TO_TUTORIAL = _params.has("skipToTutorial"); // 老用户，跳过配置直接看教程

// ── State ──
const state = {
  serverPort: null,
  serverToken: null,
  currentStep: 0,
  totalSteps: 6,
  agentName: "Hanako",
  agentId: "hanako",
  // 收集的配置
  locale: "zh-CN",
  userName: "",
  providerSelection: "",
  providerName: "",
  providerUrl: "",
  providerApi: "",
  apiKey: "",
  customProviderName: "",
  customProviderUrl: "",
  customProviderApi: "",
  selectedModel: "",
  selectedUtility: "",
  selectedUtilityLarge: "",
  fetchedModels: [],
  connectionTested: false,
  isLocalProvider: false,
};

const CUSTOM_PROVIDER_VALUE = "__custom__";
const API_FORMAT_OPTIONS = [
  { value: "openai-completions", label: "OpenAI Compatible" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-codex-responses", label: "OpenAI Codex Responses" },
];

// ── Provider 预设 ──
const PROVIDER_PRESETS = [
  { value: "ollama",      label: "Ollama (本地)",      url: "http://localhost:11434/v1", api: "openai-completions", local: true },
  { value: "dashscope",   label: "DashScope (Qwen)",  url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  { value: "openai",      label: "OpenAI",            url: "https://api.openai.com/v1", api: "openai-completions" },
  { value: "deepseek",    label: "DeepSeek",          url: "https://api.deepseek.com/v1", api: "openai-completions" },
  { value: "volcengine",  label: "Volcengine (豆包)",  url: "https://ark.cn-beijing.volces.com/api/v3", api: "openai-completions" },
  { value: "moonshot",    label: "Moonshot (Kimi)",    url: "https://api.moonshot.cn/v1", api: "openai-completions" },
  { value: "zhipu",       label: "Zhipu (GLM)",       url: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions" },
  { value: "siliconflow", label: "SiliconFlow",       url: "https://api.siliconflow.cn/v1", api: "openai-completions" },
  { value: "groq",        label: "Groq",              url: "https://api.groq.com/openai/v1", api: "openai-completions" },
  { value: "mistral",     label: "Mistral",           url: "https://api.mistral.ai/v1", api: "openai-completions" },
  { value: "minimax",     label: "MiniMax",           url: "https://api.minimaxi.com/anthropic", api: "anthropic-messages" },
];

function isCustomProviderSelected() {
  return state.providerSelection === CUSTOM_PROVIDER_VALUE;
}

function providerSignature() {
  // 自定义供应商不会变更 providerName 之外的“已选项”标识，
  // 用完整签名做缓存键，才能在 URL/API/Key 变动后重新拉取模型。
  return JSON.stringify({
    selection: state.providerSelection,
    name: state.providerName,
    url: state.providerUrl,
    api: state.providerApi,
    key: state.apiKey,
  });
}

// ── Server 通信 ──
function hanaFetch(urlPath, opts = {}) {
  const headers = { ...opts.headers };
  if (state.serverToken) {
    headers["Authorization"] = `Bearer ${state.serverToken}`;
  }
  return fetch(`http://127.0.0.1:${state.serverPort}${urlPath}`, { ...opts, headers });
}

// ── 错误提示 ──

function showError(msg) {
  let toast = $("#obErrorToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "obErrorToast";
    toast.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--coral,#c66);color:#fff;padding:8px 20px;border-radius:8px;font-size:0.82rem;z-index:999;opacity:0;transition:opacity 0.3s;";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = "1";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = "0"; }, 3000);
}

// ── Step 导航 ──

function goToStep(index) {
  if (index < 0 || index >= state.totalSteps) return;

  const current = $(`.onboarding-step[data-step="${state.currentStep}"]`);
  if (current) current.classList.remove("active");

  state.currentStep = index;

  const next = $(`.onboarding-step[data-step="${index}"]`);
  if (next) {
    next.classList.remove("active");
    // 触发 reflow 让动画重播
    void next.offsetWidth;
    next.classList.add("active");
  }

  updateProgressDots();

  // 步骤特定初始化
  if (index === 3) loadModels();
}

function updateProgressDots() {
  $$(".onboarding-dot").forEach((dot, i) => {
    dot.classList.toggle("active", i === state.currentStep);
    dot.classList.toggle("done", i < state.currentStep);
  });
}

// ── i18n 文本注入 ──

function applyI18n() {
  const s = (id, key, vars) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key, vars);
  };
  const sp = (id, key, vars) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = "";
      const text = t(key, vars);
      text.split("\n").forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement("br"));
        el.appendChild(document.createTextNode(line));
      });
    }
  };

  // Step 0: Welcome
  s("welcomeTitle", "onboarding.welcome.title");
  sp("welcomeSubtitle", "onboarding.welcome.subtitle");
  s("welcomeNextBtn", "onboarding.welcome.next");
  s("skipSetupBtn", "onboarding.skipSetup");
  s("skipPageBtn", "onboarding.skipPage");

  // Step 1: Name
  s("nameTitle", "onboarding.name.title");
  s("nameSubtitle", "onboarding.name.subtitle");
  $("#nameInput").placeholder = t("onboarding.name.placeholder");
  s("nameBackBtn", "onboarding.name.back");
  s("nameNextBtn", "onboarding.name.next");

  // Step 2: Provider
  s("providerTitle", "onboarding.provider.title");
  sp("providerSubtitle", "onboarding.provider.subtitle");
  s("providerCustomNameLabel", "settings.providers.customName");
  s("providerCustomUrlLabel", "settings.providers.customUrl");
  s("providerCustomApiLabel", "settings.providers.apiFormat");
  s("providerKeyLabel", "onboarding.provider.keyLabel");
  $("#providerKeyInput").placeholder = t("onboarding.provider.keyPlaceholder");
  $("#providerCustomNameInput").placeholder = "my-provider";
  $("#providerCustomUrlInput").placeholder = "https://api.example.com/v1";
  s("providerTestBtn", "onboarding.provider.test");
  s("providerBackBtn", "onboarding.provider.back");
  s("providerNextBtn", "onboarding.provider.next");
  renderProviderApiOptions();

  // Step 3: Model
  s("modelTitle", "onboarding.model.title");
  s("modelSubtitle", "onboarding.model.subtitle");
  $("#modelSearchInput").placeholder = t("onboarding.model.searchPlaceholder");
  s("utilityLabel", "onboarding.model.utility");
  s("utilityHint", "onboarding.model.utilityHint");
  s("utilityLargeLabel", "onboarding.model.utilityLarge");
  s("utilityLargeHint", "onboarding.model.utilityLargeHint");
  s("modelBackBtn", "onboarding.model.back");
  s("modelNextBtn", "onboarding.model.next");

  // Step 4: Theme
  s("themeTitle", "onboarding.theme.title");
  s("themeSubtitle", "onboarding.theme.subtitle");
  s("themeBackBtn", "onboarding.theme.back");
  s("themeNextBtn", "onboarding.theme.next");

  // Step 5: Tutorial
  s("tutorialTitle", "onboarding.tutorial.title");
  s("tutMemoryTitle", "onboarding.tutorial.memory.title");
  sp("tutMemoryDesc", "onboarding.tutorial.memory.desc");
  s("tutSkillsTitle", "onboarding.tutorial.skills.title");
  s("tutSkillsDesc", "onboarding.tutorial.skills.desc");
  s("tutWorkspaceTitle", "onboarding.tutorial.workspace.title");
  s("tutWorkspaceDesc", "onboarding.tutorial.workspace.desc");
  s("tutJianTitle", "onboarding.tutorial.jian.title");
  sp("tutJianDesc", "onboarding.tutorial.jian.desc");
  s("finishBtn", "onboarding.tutorial.finish");
}

// ── Progress dots 渲染 ──

function renderProgressDots() {
  const container = $("#obProgress");
  container.innerHTML = "";
  for (let i = 0; i < state.totalSteps; i++) {
    const dot = document.createElement("div");
    dot.className = "onboarding-dot";
    container.appendChild(dot);
  }
}

// ── Locale picker 渲染 ──

const LOCALES = [
  { value: "zh-CN", flag: "🇨🇳", label: "简体中文" },
  { value: "en",    flag: "🇺🇸", label: "English" },
];

function renderLocalePicker() {
  const container = $("#localePicker");
  container.innerHTML = "";

  for (const loc of LOCALES) {
    const btn = document.createElement("button");
    btn.className = "ob-locale-btn" + (state.locale === loc.value ? " active" : "");

    const flag = document.createElement("span");
    flag.className = "ob-locale-flag";
    flag.textContent = loc.flag;

    const label = document.createElement("span");
    label.textContent = loc.label;

    btn.appendChild(flag);
    btn.appendChild(label);

    btn.addEventListener("click", async () => {
      if (state.locale === loc.value) return;
      state.locale = loc.value;
      container.querySelectorAll(".ob-locale-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // 切换语言包并重新渲染所有文本
      await i18n.load(loc.value);
      applyI18n();
      renderProviderGrid();
      if (state.providerSelection) selectProvider(state.providerSelection);
      renderThemeGrid();
    });

    container.appendChild(btn);
  }
}

// ── Provider grid 渲染 ──

function renderProviderGrid() {
  const grid = $("#providerGrid");
  grid.innerHTML = "";

  for (const preset of PROVIDER_PRESETS) {
    const card = document.createElement("div");
    card.className = "provider-card";
    card.textContent = preset.label;
    card.dataset.value = preset.value;

    card.addEventListener("click", () => {
      selectProvider(preset.value);
    });

    grid.appendChild(card);
  }

  const customCard = document.createElement("div");
  customCard.className = "provider-card";
  customCard.textContent = t("settings.api.customInput");
  customCard.dataset.value = CUSTOM_PROVIDER_VALUE;
  customCard.addEventListener("click", () => {
    selectProvider(CUSTOM_PROVIDER_VALUE);
  });
  grid.appendChild(customCard);
}

function renderProviderApiOptions() {
  const select = $("#providerCustomApiSelect");
  if (!select) return;
  const currentValue = state.customProviderApi || select.value || "";
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("settings.providers.apiFormat");
  select.appendChild(placeholder);

  for (const option of API_FORMAT_OPTIONS) {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    select.appendChild(item);
  }

  select.value = currentValue;
}

function resetProviderState() {
  state.connectionTested = false;
  $("#providerTestStatus").textContent = "";
  _modelsLoadedFor = "";
}

function syncCustomProviderState() {
  state.providerName = state.customProviderName.trim().toLowerCase();
  state.providerUrl = state.customProviderUrl.trim();
  state.providerApi = state.customProviderApi;
  state.isLocalProvider = false;
}

function updateProviderFieldVisibility() {
  const customFields = $("#providerCustomFields");
  if (customFields) customFields.style.display = isCustomProviderSelected() ? "flex" : "none";

  const keyRow = $("#providerKeyInput")?.parentElement;
  const keyLabel = $("#providerKeyLabel");
  const hideKey = state.isLocalProvider;
  if (keyRow) keyRow.style.display = hideKey ? "none" : "";
  if (keyLabel) keyLabel.style.display = hideKey ? "none" : "";
}

function selectProvider(value) {
  state.providerSelection = value;
  $("#providerGrid").querySelectorAll(".provider-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.value === value);
  });

  if (value === CUSTOM_PROVIDER_VALUE) {
    syncCustomProviderState();
  } else {
    const preset = PROVIDER_PRESETS.find((item) => item.value === value);
    if (!preset) return;
    state.providerName = preset.value;
    state.providerUrl = preset.url;
    state.providerApi = preset.api;
    state.isLocalProvider = !!preset.local;
    if (preset.local) state.apiKey = "";
  }

  resetProviderState();
  updateProviderFieldVisibility();
  updateProviderBtns();
}

function hasProviderConfig() {
  return !!(state.providerName && state.providerUrl && state.providerApi);
}

// ── Provider step 逻辑 ──

function updateProviderBtns() {
  if (PREVIEW) {
    // 预览模式：所有按钮可用
    $("#providerTestBtn").disabled = false;
    $("#providerNextBtn").disabled = false;
    return;
  }
  const ready = hasProviderConfig();
  $("#providerTestBtn").disabled = !ready;
  $("#providerNextBtn").disabled = !(ready && state.connectionTested);
}

async function testConnection() {
  const statusEl = $("#providerTestStatus");
  const testBtn = $("#providerTestBtn");

  statusEl.className = "ob-status loading";
  statusEl.textContent = t("onboarding.provider.testing");
  testBtn.disabled = true;

  try {
    const res = await hanaFetch("/api/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: state.providerUrl,
        api: state.providerApi,
        api_key: state.apiKey,
      }),
    });
    const data = await res.json();

    if (data.ok) {
      statusEl.className = "ob-status success";
      statusEl.textContent = t("onboarding.provider.testSuccess");
      state.connectionTested = true;
    } else {
      statusEl.className = "ob-status error";
      statusEl.textContent = t("onboarding.provider.testFailed");
      state.connectionTested = false;
    }
  } catch (err) {
    statusEl.className = "ob-status error";
    statusEl.textContent = err.message;
    state.connectionTested = false;
  }

  testBtn.disabled = false;
  updateProviderBtns();
}

async function saveProvider() {
  // 只写 api.provider 到 per-agent config
  // providers 块由路由层拦截后存入全局 providers.yaml
  await hanaFetch(`/api/agents/${state.agentId}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api: {
        provider: state.providerName,
      },
      providers: {
        [state.providerName]: {
          base_url: state.providerUrl,
          api_key: state.apiKey,
          api: state.providerApi,
        },
      },
    }),
  });
}

// ── Model step 逻辑 ──

let _modelsLoadedFor = ""; // 记录上次加载模型的供应商签名

async function loadModels() {
  // 预览模式：展示 mock 模型列表
  if (PREVIEW) {
    state.fetchedModels = [
      { id: "model-a" },
      { id: "model-b" },
      { id: "model-c" },
    ];
    $("#modelLoading").style.display = "none";
    $("#modelNextBtn").disabled = false;
    renderModelList(state.fetchedModels);
    return;
  }

  const signature = providerSignature();
  if (_modelsLoadedFor === signature) return;

  const loadingEl = $("#modelLoading");
  loadingEl.textContent = t("onboarding.model.loading");
  loadingEl.style.display = "block";

  try {
    const res = await hanaFetch("/api/providers/fetch-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.providerName,
        base_url: state.providerUrl,
        api: state.providerApi,
        api_key: state.apiKey,
      }),
    });
    const data = await res.json();

    if (data.error) {
      loadingEl.className = "model-empty";
      loadingEl.textContent = data.error;
      return;
    }

    state.fetchedModels = data.models || [];
    state.selectedModel = ""; // 换供应商后清空已选模型
    state.selectedUtility = "";
    state.selectedUtilityLarge = "";
    $("#modelNextBtn").disabled = true;
    _modelsLoadedFor = signature;
    loadingEl.style.display = "none";

    renderModelList(state.fetchedModels);
    populateUtilitySelects(state.fetchedModels);
  } catch (err) {
    loadingEl.className = "model-empty";
    loadingEl.textContent = err.message;
  }
}

function _buildSdw(container, models, stateKey) {
  container.innerHTML = "";
  container.classList.remove("open");

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "sdw-trigger";

  const valSpan = document.createElement("span");
  valSpan.className = "sdw-value sdw-placeholder";
  valSpan.textContent = "—";

  const arrow = document.createElement("span");
  arrow.className = "sdw-arrow";
  arrow.textContent = "▾";

  trigger.appendChild(valSpan);
  trigger.appendChild(arrow);
  container.appendChild(trigger);

  const popup = document.createElement("div");
  popup.className = "sdw-popup";

  for (const m of models) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "sdw-option";
    opt.textContent = m.id;
    opt.addEventListener("click", () => {
      state[stateKey] = m.id;
      valSpan.textContent = m.id;
      valSpan.classList.remove("sdw-placeholder");
      popup.querySelectorAll(".sdw-option").forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      container.classList.remove("open");
    });
    popup.appendChild(opt);
  }
  container.appendChild(popup);

  trigger.addEventListener("click", () => container.classList.toggle("open"));
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) container.classList.remove("open");
  });
}

function populateUtilitySelects(models) {
  _buildSdw($("#utilitySelect"), models, "selectedUtility");
  _buildSdw($("#utilityLargeSelect"), models, "selectedUtilityLarge");
}

function renderModelList(models) {
  const listEl = $("#modelList");
  // 保留 loadingEl
  listEl.querySelectorAll(".model-item").forEach(el => el.remove());

  if (models.length === 0) {
    const empty = listEl.querySelector(".model-empty") || document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = t("onboarding.model.empty");
    empty.style.display = "block";
    if (!empty.parentNode) listEl.appendChild(empty);
    return;
  }

  const loadingEl = listEl.querySelector(".model-empty");
  if (loadingEl) loadingEl.style.display = "none";

  for (const model of models) {
    const item = document.createElement("div");
    item.className = "model-item";
    if (model.id === state.selectedModel) item.classList.add("selected");
    item.textContent = model.id;

    item.addEventListener("click", () => {
      listEl.querySelectorAll(".model-item").forEach(i => i.classList.remove("selected"));
      item.classList.add("selected");
      state.selectedModel = model.id;
      $("#modelNextBtn").disabled = false;
    });

    listEl.appendChild(item);
  }
}

async function saveModel() {
  // 保存 chat 模型
  await hanaFetch(`/api/agents/${state.agentId}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      models: { chat: state.selectedModel },
    }),
  });

  // 保存模型列表到 provider
  const modelIds = state.fetchedModels.map(m => m.id);
  await hanaFetch(`/api/agents/${state.agentId}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providers: { [state.providerName]: { models: modelIds } },
    }),
  });

  // 把选中的模型加到收藏
  const favs = [state.selectedModel];
  if (state.selectedUtility && !favs.includes(state.selectedUtility)) favs.push(state.selectedUtility);
  if (state.selectedUtilityLarge && !favs.includes(state.selectedUtilityLarge)) favs.push(state.selectedUtilityLarge);
  await hanaFetch("/api/favorites", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: favs }),
  });

  // 保存 utility 模型到全局偏好
  if (state.selectedUtility || state.selectedUtilityLarge) {
    const utilityModels = {};
    if (state.selectedUtility) utilityModels.utility = state.selectedUtility;
    if (state.selectedUtilityLarge) utilityModels.utility_large = state.selectedUtilityLarge;
    await hanaFetch("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: utilityModels }),
    });
  }
}

// ── Theme grid 渲染 ──

const OB_THEMES = ['warm-paper', 'midnight', 'auto', 'high-contrast', 'grass-aroma', 'contemplation', 'absolutely', 'delve', 'deep-think'];

// kebab-case → camelCase，i18n key 遵循 settings.appearance.{camelCase} 约定
function _themeKey(id) { return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

function renderThemeGrid() {
  const grid = $("#obThemeGrid");
  grid.innerHTML = "";
  const saved = localStorage.getItem("hana-theme") || "auto";
  let activeCard = null;

  for (const theme of OB_THEMES) {
    const key = _themeKey(theme);
    const card = document.createElement("button");
    card.className = "theme-card" + (saved === theme ? " active" : "");
    card.dataset.theme = theme;
    if (saved === theme) activeCard = card;

    const nameEl = document.createElement("div");
    nameEl.className = "theme-card-name";
    nameEl.textContent = t(`settings.appearance.${key}`);

    const modeEl = document.createElement("div");
    modeEl.className = "theme-card-mode";
    modeEl.textContent = t(`settings.appearance.${key}Mode`);

    card.appendChild(nameEl);
    card.appendChild(modeEl);

    card.addEventListener("click", () => {
      if (activeCard) activeCard.classList.remove("active");
      card.classList.add("active");
      activeCard = card;
      setTheme(theme);
    });

    grid.appendChild(card);
  }
}

// ── 事件绑定 ──

function bindEvents() {
  $("#skipSetupBtn").addEventListener("click", async () => {
    if (PREVIEW) {
      window.close();
      return;
    }
    $("#skipSetupBtn").disabled = true;
    try {
      await window.hana.onboardingComplete();
    } catch (err) {
      console.error("[onboarding] skip setup failed:", err);
      showError(t("onboarding.provider.testFailed"));
      $("#skipSetupBtn").disabled = false;
    }
  });

  $("#skipPageBtn").addEventListener("click", async () => {
    // 引导允许跨过当前步骤，避免上游接口异常时把新用户彻底卡死。
    if (state.currentStep >= state.totalSteps - 1) {
      if (PREVIEW) {
        window.close();
        return;
      }
      try {
        await window.hana.onboardingComplete();
      } catch (err) {
        console.error("[onboarding] skip final step failed:", err);
        showError(t("onboarding.provider.testFailed"));
      }
      return;
    }
    goToStep(state.currentStep + 1);
  });

  // Welcome → next（保存 locale）
  $("#welcomeNextBtn").addEventListener("click", async () => {
    if (!PREVIEW) {
      try {
        await hanaFetch(`/api/agents/${state.agentId}/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: state.locale }),
        });
      } catch (err) {
        console.error("[onboarding] save locale failed:", err);
      }
    }
    goToStep(1);
  });

  // Name
  const nameInput = $("#nameInput");
  const nameNextBtn = $("#nameNextBtn");
  nameInput.addEventListener("input", () => {
    state.userName = nameInput.value.trim();
    if (!PREVIEW) nameNextBtn.disabled = !state.userName;
  });
  if (PREVIEW) nameNextBtn.disabled = false;
  $("#nameBackBtn").addEventListener("click", () => goToStep(0));
  nameNextBtn.addEventListener("click", async () => {
    if (PREVIEW) { goToStep(2); return; }
    if (!state.userName) return;
    nameNextBtn.disabled = true;
    try {
      await hanaFetch(`/api/agents/${state.agentId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: { name: state.userName } }),
      });
      goToStep(2);
    } catch (err) {
      console.error("[onboarding] save name failed:", err);
      showError(t("onboarding.provider.testFailed"));
      nameNextBtn.disabled = false;
    }
  });

  // Provider
  const keyInput = $("#providerKeyInput");
  const customNameInput = $("#providerCustomNameInput");
  const customUrlInput = $("#providerCustomUrlInput");
  const customApiSelect = $("#providerCustomApiSelect");

  keyInput.addEventListener("input", () => {
    state.apiKey = keyInput.value.replace(/[^\x20-\x7E]/g, "").trim();
    resetProviderState();
    updateProviderBtns();
  });

  customNameInput.addEventListener("input", () => {
    state.customProviderName = customNameInput.value;
    if (!isCustomProviderSelected()) return;
    syncCustomProviderState();
    resetProviderState();
    updateProviderBtns();
  });

  customUrlInput.addEventListener("input", () => {
    state.customProviderUrl = customUrlInput.value;
    if (!isCustomProviderSelected()) return;
    syncCustomProviderState();
    resetProviderState();
    updateProviderBtns();
  });

  customApiSelect.addEventListener("change", () => {
    state.customProviderApi = customApiSelect.value;
    if (!isCustomProviderSelected()) return;
    syncCustomProviderState();
    resetProviderState();
    updateProviderBtns();
  });

  $("#toggleKey").addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });

  $("#providerTestBtn").addEventListener("click", () => {
    if (PREVIEW) {
      // 预览模式：模拟测试成功
      const statusEl = $("#providerTestStatus");
      statusEl.className = "ob-status success";
      statusEl.textContent = t("onboarding.provider.testSuccess");
      return;
    }
    testConnection();
  });

  $("#providerBackBtn").addEventListener("click", () => goToStep(1));
  $("#providerNextBtn").addEventListener("click", async () => {
    if (PREVIEW) { goToStep(3); return; }
    if (!state.connectionTested) return;
    $("#providerNextBtn").disabled = true;
    try {
      await saveProvider();
      goToStep(3);
    } catch (err) {
      console.error("[onboarding] save provider failed:", err);
      showError(t("onboarding.provider.testFailed"));
      $("#providerNextBtn").disabled = false;
    }
  });

  // Model
  const searchInput = $("#modelSearchInput");
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    const filtered = state.fetchedModels.filter(m =>
      m.id.toLowerCase().includes(q)
    );
    renderModelList(filtered);
  });

  $("#modelBackBtn").addEventListener("click", () => goToStep(2));
  $("#modelNextBtn").addEventListener("click", async () => {
    if (PREVIEW) { goToStep(4); return; }
    if (!state.selectedModel) return;
    $("#modelNextBtn").disabled = true;
    try {
      await saveModel();
      goToStep(4);
    } catch (err) {
      console.error("[onboarding] save model failed:", err);
      showError(t("onboarding.provider.testFailed"));
      $("#modelNextBtn").disabled = false;
    }
  });

  // Theme
  $("#themeBackBtn").addEventListener("click", () => goToStep(3));
  $("#themeNextBtn").addEventListener("click", () => goToStep(5));

  // Finish
  $("#finishBtn").addEventListener("click", async () => {
    if (PREVIEW) {
      // 预览模式：直接关闭窗口，不写任何配置
      window.close();
      return;
    }
    $("#finishBtn").disabled = true;
    try {
      await window.hana.onboardingComplete();
    } catch (err) {
      console.error("[onboarding] complete failed:", err);
      showError(t("onboarding.provider.testFailed"));
      $("#finishBtn").disabled = false;
    }
  });
}

// ── 加载头像 ──

async function loadAvatar() {
  try {
    const localPath = await window.hana.getAvatarPath("agent");
    if (localPath) {
      // Electron file:// 协议需要编码特殊字符
      $("#obAvatar").src = `file://${encodeURI(localPath)}`;
    }
  } catch {}
}

// ── 初始化 ──

(async function init() {
  try {
    state.serverPort = await window.hana.getServerPort();
    state.serverToken = await window.hana.getServerToken();

    // 从 splash info 获取 locale 和 agent 名字
    const splashInfo = await window.hana.getSplashInfo();
    const locale = splashInfo?.locale || "zh-CN";
    state.locale = locale;
    state.agentName = splashInfo?.agentName || "Hanako";

    // 加载语言包
    await i18n.load(locale);
    i18n.defaultName = state.agentName;

    // 渲染
    renderProgressDots();
    renderLocalePicker();
    renderProviderGrid();
    renderThemeGrid();
    applyI18n();
    updateProviderFieldVisibility();
    updateProviderBtns();
    loadAvatar();
    bindEvents();

    // 根据模式决定起始步骤
    if (SKIP_TO_TUTORIAL) {
      goToStep(5); // 老用户直接看教程
    } else {
      goToStep(0);
    }
  } catch (err) {
    console.error("[onboarding] init failed:", err);
  }
})();
