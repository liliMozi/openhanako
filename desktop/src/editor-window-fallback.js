(function () {
  const hana = window.hana;
  const titleEl = document.getElementById("editorTitle");
  const bodyEl = document.getElementById("editorBody");
  const btnDock = document.getElementById("btnDock");
  const btnClose = document.getElementById("btnClose");

  let filePath = null;
  let saveTimer = null;
  let selfSave = false;
  let textarea = null;
  let fileChangeBound = false;

  function ensureTextarea() {
    if (textarea) return textarea;

    textarea = document.createElement("textarea");
    textarea.className = "editor-textarea";
    textarea.spellcheck = false;
    textarea.addEventListener("input", () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveContent(textarea.value), 600);
    });
    bodyEl.replaceChildren(textarea);
    return textarea;
  }

  function syncTheme() {
    const saved = localStorage.getItem("hana-theme") || "auto";
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved === "auto" ? (isDark ? "midnight" : "warm-paper") : saved;
    document.getElementById("themeSheet").setAttribute("href", "themes/" + theme + ".css");
  }

  function syncFontPreference() {
    document.body.classList.toggle("font-sans", localStorage.getItem("hana-font-serif") === "0");
  }

  async function saveContent(text) {
    if (!filePath) return;
    selfSave = true;
    await hana?.writeFile(filePath, text);
    setTimeout(() => {
      selfSave = false;
    }, 300);
  }

  async function loadContent(data) {
    filePath = data.filePath;
    titleEl.textContent = data.title || filePath.split("/").pop() || "Editor";
    bodyEl.classList.toggle("mode-markdown", data.type === "markdown");

    const content = await hana?.readFile(filePath);
    if (content == null) return;

    const ta = ensureTextarea();
    ta.value = content;

    hana?.watchFile(filePath);
    if (!fileChangeBound) {
      hana?.onFileChanged((changedPath) => {
        if (changedPath !== filePath || selfSave || !textarea) return;
        hana?.readFile(filePath).then((newContent) => {
          if (newContent == null || textarea.value === newContent) return;
          const pos = textarea.selectionStart;
          textarea.value = newContent;
          textarea.selectionStart = textarea.selectionEnd = Math.min(pos, newContent.length);
        });
      });
      fileChangeBound = true;
    }
  }

  btnDock.addEventListener("click", () => hana?.editorDock?.());
  btnClose.addEventListener("click", () => hana?.editorClose?.());
  hana?.onEditorLoad((data) => loadContent(data));

  syncTheme();
  syncFontPreference();
})();
