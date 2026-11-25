(() => {
  "use strict";
  if (globalThis.__heLyricsContentInstalled) return;
  globalThis.__heLyricsContentInstalled = true;
  const channel = "he-music-lyrics/v1";
  const requests = new Map();
  const dialogs = new WeakMap();
  const activeDialogs = new Set();
  let preferences = HELyrics.normalizePreferences();
  let toastTimer;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function explainError(error) {
    if (/context invalidated|receiving end does not exist/i.test(error?.message || "")) {
      return "插件已重新加载，请刷新音乐网页后重试";
    }
    return error?.message || "歌词下载失败，请稍后重试";
  }

  function toast(text, isError = false) {
    let node = document.getElementById("he-lyrics-toast");
    if (!node) {
      node = element("div", "he-lyrics-toast");
      node.id = "he-lyrics-toast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.body.append(node);
    }
    node.textContent = text;
    node.classList.toggle("he-lyrics-toast-error", isError);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 9000 : 6500);
  }

  function request(method, token) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("读取歌词超时，请刷新网页后重试"));
      }, 20000);
      requests.set(id, { resolve, reject, timer });
      window.postMessage({ channel, kind: "request", id, method, token }, location.origin);
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        message?.channel !== channel || message.kind !== "response") return;
    const pending = requests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    requests.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(typeof message.error === "string" ? message.error : "读取歌词失败"));
  });

  function applyPreferences(state) {
    state.enabled.checked = preferences.enabled;
    state.format.value = preferences.format;
    state.translation.checked = preferences.includeTranslation;
    state.romanization.checked = preferences.includeRomanization;
  }

  async function storePreferences(state) {
    preferences = HELyrics.normalizePreferences({
      ...preferences,
      enabled: state.enabled.checked,
      format: state.format.value,
      includeTranslation: state.translation.checked,
      includeRomanization: state.romanization.checked,
    });
    try {
      await chrome.storage.local.set({ preferences });
    } catch (error) {
      toast(explainError(error), true);
    }
  }

  async function saveFile(file, filenameBase, saveAs) {
    if (saveAs) {
      return chrome.runtime.sendMessage({ type: "he-lyrics:download", filenameBase,
        extension: file.extension, text: file.text, saveAs: true });
    }
    if (!file.text.trim() || file.text.length > 2 * 1024 * 1024) throw new Error("歌词文件内容无效或过大");
    const filename = `${HELyrics.sanitizeFilenameBase(filenameBase)}.${file.extension}`;
    const mime = file.extension === "lrc" ? "application/x-lrc" : "text/plain";
    const url = URL.createObjectURL(new Blob(["﻿", file.text.replace(/^﻿/, "")], { type: `${mime};charset=utf-8` }));
    try {
      // 下载链接直接携带歌名；部分 Chrome 下载环境会忽略扩展对 data: URL 的命名建议。
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      return await chrome.runtime.sendMessage({ type: "he-lyrics:verify", url, filenameBase, extension: file.extension });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  async function startDownload(state, automatic) {
    if (state.busy) return;
    state.busy = true;
    state.onlyButton.disabled = true;
    state.onlyButton.textContent = "正在获取…";
    state.status.textContent = "正在读取这首歌的歌词…";
    state.status.classList.remove("he-lyrics-error");
    if (automatic) toast("正在获取对应歌词，音频继续按原站流程下载…");
    const options = {
      ...preferences,
      format: state.format.value,
      includeTranslation: state.translation.checked,
      includeRomanization: state.romanization.checked,
    };
    try {
      const { context, lyrics } = await request("get-lyrics", state.token);
      const file = HELyrics.buildLyricFile(lyrics, { ...options, ...context });
      const response = await saveFile(file, context.filenameBase, options.saveAs);
      if (!response?.ok) throw new Error(response?.error || "无法启动歌词下载");
      const fallback = options.format === "lrc" && file.extension === "txt" ? "（无时间戳，改用 TXT）" : "";
      const prefix = response.verification === "complete" ? "歌词已保存" :
        response.verification === "pending" ? "已提交，浏览器尚未确认保存完成" : "已提交，但无法核对实际保存结果";
      state.status.textContent = `${prefix}：${response.filename}${fallback}`;
      toast(`${prefix}：${response.filename}${fallback}`);
    } catch (error) {
      const message = explainError(error);
      state.status.textContent = message;
      state.status.classList.add("he-lyrics-error");
      toast(automatic ? `歌词下载未能按预期完成：${message}。音频下载不受插件影响。` : message, true);
    } finally {
      state.busy = false;
      state.onlyButton.disabled = false;
      state.onlyButton.textContent = "仅下载歌词";
    }
  }

  function checkbox(text, className) {
    const label = element("label", className);
    const input = document.createElement("input");
    input.type = "checkbox";
    label.append(input, element("span", "", text));
    return { label, input };
  }

  function mount(modal) {
    const old = dialogs.get(modal);
    if (old?.section.isConnected) return;
    if (old) activeDialogs.delete(old);
    const menu = modal.querySelector(":scope > .menu");
    if (!menu) return;
    const token = crypto.randomUUID();
    modal.dataset.heLyricsDialog = token;
    const section = element("section", "he-lyrics-panel");
    section.setAttribute("aria-label", "歌词下载选项");
    const heading = element("div", "he-lyrics-heading");
    const enabled = checkbox("同时下载歌词", "he-lyrics-main-check");
    heading.append(enabled.label, element("span", "he-lyrics-badge", "歌词助手 v1.0.5"));
    const description = element("p", "he-lyrics-description", "歌词单独保存，不改动原站音频下载流程。");
    const controls = element("div", "he-lyrics-controls");
    const formatLabel = element("label", "he-lyrics-format", "格式");
    const format = element("select", "he-lyrics-select");
    format.setAttribute("aria-label", "歌词文件格式");
    for (const [value, text] of [["lrc", "LRC · 带时间轴"], ["txt", "TXT · 纯文本"]]) {
      const option = element("option", "", text);
      option.value = value;
      format.append(option);
    }
    formatLabel.append(format);
    const translation = checkbox("附带翻译", "he-lyrics-option");
    const romanization = checkbox("附带罗马音", "he-lyrics-option");
    controls.append(formatLabel, translation.label, romanization.label);
    const footer = element("div", "he-lyrics-footer");
    const status = element("p", "he-lyrics-status", "正在识别歌曲…");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const onlyButton = element("button", "he-lyrics-only", "仅下载歌词");
    onlyButton.type = "button";
    footer.append(status, onlyButton);
    section.append(heading, description, controls, footer);
    const state = { modal, token, section, enabled: enabled.input, format,
      translation: translation.input, romanization: romanization.input, status, onlyButton, busy: false };
    dialogs.set(modal, state);
    activeDialogs.add(state);
    applyPreferences(state);
    for (const input of [state.enabled, format, state.translation, state.romanization]) {
      input.addEventListener("change", () => { void storePreferences(state); });
    }
    onlyButton.addEventListener("click", (event) => {
      if (event.isTrusted) void startDownload(state, false);
    });
    menu.before(section);
    request("get-context", token).then(
      (context) => {
        if (!state.busy) {
          status.textContent = `${context.title} · 文件名跟随原站设置`;
          status.title = context.filenameBase;
        }
      },
      (error) => {
        if (!state.busy) {
          status.textContent = explainError(error);
          status.classList.add("he-lyrics-error");
        }
      },
    );
  }

  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    const modal = button?.closest(".download-song");
    const state = modal && dialogs.get(modal);
    if (!state?.enabled.checked || !button.matches(".menu button.n-button--primary-type") ||
        !modal.querySelector(":scope > .menu")?.contains(button) ||
        button.disabled || button.classList.contains("n-button--loading")) return;
    // 不阻止事件，不调用原站下载函数，原站照常处理音频及权限检查。
    void startDownload(state, true);
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.preferences) return;
    preferences = HELyrics.normalizePreferences(changes.preferences.newValue);
    for (const state of activeDialogs) applyPreferences(state);
  });

  async function initialize() {
    try {
      const saved = await chrome.storage.local.get("preferences");
      preferences = HELyrics.normalizePreferences(saved.preferences);
    } catch (error) {
      toast(explainError(error), true);
    }
    const scan = (node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(".download-song")) mount(node);
      node.querySelectorAll(".download-song").forEach(mount);
      const parentModal = node.closest(".download-song");
      if (parentModal) mount(parentModal);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(scan);
      for (const state of activeDialogs) {
        if (!state.modal.isConnected) activeDialogs.delete(state);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
  }
  void initialize();
})();
