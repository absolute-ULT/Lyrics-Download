"use strict";
importScripts("lyrics.js");

const SITE_ORIGIN = "https://y.hmusic.top";
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

function trustedSender(sender) {
  try {
    return sender.id === chrome.runtime.id && Boolean(sender.tab) && sender.frameId === 0 &&
      new URL(sender.url).origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

function createDownloadURL(content, filename) {
  const encodedName = btoa(String.fromCharCode(...new TextEncoder().encode(filename)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // LRC 不能标成 text/plain，否则最终文件名处理可能按 MIME 补回 .txt。
  const mimeType = filename.endsWith(".lrc") ? "application/x-lrc" : "text/plain";
  // 将安全文件名随 data URL 保存，最终命名事件即使唤醒新 worker 也能恢复它。
  return `data:${mimeType};charset=utf-8;he-lyrics-filename=${encodedName},${encodeURIComponent(content)}`;
}

function filenameFromDownloadURL(url) {
  const match = typeof url === "string" && url.match(/^data:(?:application\/x-lrc|text\/plain);charset=utf-8;he-lyrics-filename=([A-Za-z0-9_-]{1,1600}),/);
  if (!match) return null;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
    const parts = decoded.match(/^(.+)\.(lrc|txt)$/);
    return parts ? `${HELyrics.sanitizeFilenameBase(parts[1])}.${parts[2]}` : null;
  } catch {
    return null;
  }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // 不改歌曲音频，也不接管其他扩展或普通网页的下载命名。
  const filename = item.byExtensionId === chrome.runtime.id ? filenameFromDownloadURL(item.url) : null;
  if (filename) suggest({ filename, conflictAction: "uniquify" });
  else suggest();
});

function verifyDownload(downloadId, requestedFilename, allowRenamed = false) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let checking = false;
    let recheck = false;
    const finish = (result, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve(result);
    };
    const inspect = async () => {
      if (finished) return;
      if (checking) { recheck = true; return; }
      checking = true;
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (finished) return;
        if (item?.state === "interrupted") {
          finish(null, new Error("歌词下载未完成，请检查浏览器下载记录"));
        } else if (item?.state === "complete") {
          const actualFilename = item.filename?.split(/[\\/]/).pop() || "";
          const expectedExtension = requestedFilename.match(/\.(lrc|txt)$/)?.[1];
          const suffix = `.${expectedExtension}`;
          const expectedBase = requestedFilename.slice(0, -suffix.length).normalize("NFC");
          const actualBase = actualFilename.slice(0, -suffix.length).normalize("NFC");
          const matchingName = actualBase === expectedBase || (actualBase.startsWith(expectedBase) &&
            /^ \(\d+\)$/.test(actualBase.slice(expectedBase.length)));
          if (!actualFilename.toLowerCase().endsWith(suffix) || (!matchingName && !allowRenamed)) {
            finish(null, new Error(`浏览器实际保存为“${actualFilename || "未知文件名"}”，预期为“${requestedFilename}”；请检查其他下载重命名扩展或保存设置`));
          } else {
            finish({ filename: actualFilename, requestedFilename, verification: "complete" });
          }
        }
      } catch {
        finish({ filename: requestedFilename, requestedFilename, verification: "unavailable" });
      } finally {
        checking = false;
        if (recheck && !finished) { recheck = false; void inspect(); }
      }
    };
    const onChanged = (delta) => {
      if (delta.id === downloadId) void inspect();
    };
    const timer = setTimeout(() => finish({ filename: requestedFilename,
      requestedFilename, verification: "pending" }), 10000);
    chrome.downloads.onChanged.addListener(onChanged);
    // 初次查询同时覆盖“下载完成事件比 API 回调更早”的情况。
    void inspect();
  });
}

async function downloadLyrics(message, sender) {
  if (!trustedSender(sender)) throw new Error("歌词下载仅允许由 HE-Music 页面发起");
  if (typeof message.text !== "string" || !message.text.trim() || message.text.length > MAX_TEXT_LENGTH ||
      typeof message.filenameBase !== "string" || !message.filenameBase.trim() ||
      !["lrc", "txt"].includes(message.extension)) throw new Error("歌词文件内容或文件名无效");

  const filename = `${HELyrics.sanitizeFilenameBase(message.filenameBase)}.${message.extension}`;
  const content = "﻿" + message.text.replace(/^﻿/, "");
  // 只创建本地文本下载，页面不能借此请求任意网络地址。
  const downloadId = await chrome.downloads.download({
    url: createDownloadURL(content, filename),
    filename,
    conflictAction: "uniquify",
    saveAs: message.saveAs === true,
  });
  return { downloadId, ...await verifyDownload(downloadId, filename, message.saveAs === true) };
}

async function verifyPageDownload(message, sender) {
  if (!trustedSender(sender) || typeof message.url !== "string" ||
      !/^blob:https:\/\/y\.hmusic\.top\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(message.url) ||
      typeof message.filenameBase !== "string" || !["txt", "lrc"].includes(message.extension)) {
    throw new Error("歌词下载标识无效");
  }
  const filename = `${HELyrics.sanitizeFilenameBase(message.filenameBase)}.${message.extension}`;
  // click() 返回时 Chrome 可能还没创建下载记录。只查询本次唯一的 Blob URL。
  for (const delay of [0, 100, 250, 500, 1000, 2000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    let item;
    try { [item] = await chrome.downloads.search({ url: message.url, limit: 1 }); }
    catch { return { filename, verification: "unavailable" }; }
    if (item) return verifyDownload(item.id, filename);
  }
  throw new Error("未找到这次歌词的下载记录，请检查浏览器是否拦截下载后重试");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["he-lyrics:download", "he-lyrics:verify"].includes(message?.type)) return false;
  const action = message.type === "he-lyrics:verify" ? verifyPageDownload : downloadLyrics;
  action(message, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: /cancel/i.test(error.message) ? "已取消歌词下载" :
      error.message || "无法下载歌词，请刷新网页后重试" }),
  );
  return true;
});
