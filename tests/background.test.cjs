"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function setup(download = async () => 123, settings = {}) {
  let listener, filenameListener;
  const calls = [];
  const items = new Map();
  const changeListeners = new Set();
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, atob, btoa, clearTimeout,
    setTimeout: (callback, delay) => setTimeout(callback, settings.timeoutDelay ?? delay),
    importScripts: () => {},
    HELyrics: { sanitizeFilenameBase: (text) => text.replace(/[\\/:*?"<>|]/g, "_") },
    chrome: {
      runtime: { id: "test-extension", onMessage: { addListener: (value) => { listener = value; } } },
      downloads: {
        onDeterminingFilename: { addListener: (value) => { filenameListener = value; } },
        onChanged: {
          addListener: (value) => changeListeners.add(value),
          removeListener: (value) => changeListeners.delete(value),
        },
        search: async ({ id, url }) => {
          if (settings.searchError) throw new Error("无法查询下载记录");
          if (url && settings.pageItem?.url === url) {
            const item = settings.pageItem;
            items.set(item.id, item);
            return [item];
          }
          return items.has(id) ? [items.get(id)] : [];
        },
        download: async (options) => {
          calls.push(options);
          const id = await download(options);
          items.set(id, { id, state: settings.state || "complete",
            filename: settings.actualFilename || `C:\\Downloads\\${options.filename}` });
          return id;
        },
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8"), context);
  const sender = { id: "test-extension", tab: { id: 42 }, frameId: 0, url: "https://y.hmusic.top/#/?platform=kuwo" };
  const message = { type: "he-lyrics:download", text: "[00:01.000]歌词", filenameBase: "歌曲 - 歌手", extension: "lrc", saveAs: false };
  return { calls, sender, message,
    listenerCount: () => changeListeners.size,
    change: (id, changes) => {
      Object.assign(items.get(id), changes);
      for (const listener of changeListeners) listener({ id,
        ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { current: value }])) });
    },
    determine: (item) => {
      const suggestions = [];
      filenameListener(item, (value) => suggestions.push(value));
      return suggestions;
    },
    send: (msg = message, from = sender) => new Promise((resolve) => {
      const asyncResponse = listener(msg, from, resolve);
      if (asyncResponse === false) resolve(undefined);
    }),
  };
}

const blobURL = "blob:https://y.hmusic.top/b6b6e425-f213-49b1-a64e-64a65ee64ac1";

test("复核具名下载，仅使用该歌词的唯一 URL，不再启动第二次下载", async () => {
  const f = setup(undefined, { pageItem: { id: 9, state: "complete", url: blobURL, filename: "歌曲 - 歌手 (1).lrc" } });
  const check = { ...f.message, type: "he-lyrics:verify", url: blobURL };
  assert.equal((await f.send(check)).filename, "歌曲 - 歌手 (1).lrc");
  for (const url of ["https://example.org", blobURL.replace("y.hmusic.top", "example.org"), blobURL + "?x"]) {
    assert.equal((await f.send({ ...check, url })).ok, false);
  }
  assert.equal((await f.send(check, { ...f.sender, frameId: 1 })).ok, false);
  assert.equal(f.calls.length, 0);
});

test("浏览器拦截具名下载时报告未找到记录", async () => {
  const f = setup(undefined, { timeoutDelay: 1 });
  const result = await f.send({ ...f.message, type: "he-lyrics:verify", url: blobURL });
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到这次歌词的下载记录/);
});

function downloadBody(url) {
  return decodeURIComponent(url.slice(url.indexOf(",") + 1));
}

test("后台仅下载 UTF-8 BOM 歌词文本，沿用安全文件名", async () => {
  const f = setup();
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.downloadId, 123);
  const options = f.calls[0];
  assert.equal(options.filename, "歌曲 - 歌手.lrc");
  assert.equal(options.conflictAction, "uniquify");
  assert.equal(options.saveAs, false);
  assert.equal(downloadBody(options.url), "﻿[00:01.000]歌词");
});

test("拒绝其他站点、扩展、iframe 或无标签页的下载请求", async () => {
  for (const change of [{ url: "https://evil.invalid/" }, { url: "https://y.hmusic.top.evil.invalid/" },
    { id: "other-extension" }, { frameId: 1 }, { tab: undefined }, { url: "无效地址" }]) {
    const f = setup();
    const result = await f.send(f.message, { ...f.sender, ...change });
    assert.equal(result.ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test("拒绝空歌词、超大内容、无效文件名与任意可执行扩展名", async () => {
  for (const change of [{ text: " " }, { text: null }, { text: "a".repeat(2 * 1024 * 1024 + 1) },
    { extension: "exe" }, { filenameBase: "" }, { filenameBase: undefined }]) {
    const f = setup();
    assert.equal((await f.send({ ...f.message, ...change })).ok, false);
    assert.equal(f.calls.length, 0);
  }
});

test("页面不能提供任意网络下载 URL，也不会重复添加 BOM", async () => {
  const f = setup();
  await f.send({ ...f.message, url: "https://evil.invalid/payload.exe", text: "﻿歌词", saveAs: true });
  assert.match(f.calls[0].url, /^data:application\/x-lrc;charset=utf-8;he-lyrics-filename=/);
  assert.equal(downloadBody(f.calls[0].url), "﻿歌词");
  assert.equal(f.calls[0].saveAs, true);
});

test("最终命名阶段恢复歌名和 LRC 后缀，不采用 Chrome 的下载.txt 默认值", async () => {
  const f = setup();
  await f.send({ ...f.message, filenameBase: "5&20AM - 刀酱" });
  const suggestions = f.determine({ byExtensionId: "test-extension", url: f.calls[0].url, filename: "下载.txt" });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].filename, "5&20AM - 刀酱.lrc");
  assert.equal(suggestions[0].conflictAction, "uniquify");
});

test("worker 重启后仍能正确命名中文、标点、emoji 和 TXT 文件", async () => {
  const first = setup();
  await first.send({ ...first.message, filenameBase: "歌 (Live) - 歌手🎵", extension: "txt" });
  const restarted = setup();
  const result = restarted.determine({ byExtensionId: "test-extension", url: first.calls[0].url });
  assert.equal(result[0].filename, "歌 (Live) - 歌手🎵.txt");
});

test("命名处理不影响音频、其他扩展和普通网页下载", async () => {
  const f = setup();
  await f.send();
  for (const item of [{ byExtensionId: "other-extension", url: f.calls[0].url },
    { url: f.calls[0].url }, { byExtensionId: "test-extension", url: "https://example.invalid/audio.mp3" },
    { byExtensionId: "test-extension", url: "data:text/plain;charset=utf-8,普通文本" }]) {
    assert.deepEqual(f.determine(item), [undefined]);
  }
});

test("命名元信息损坏、非法 UTF-8 或可执行后缀不会成为下载文件名", () => {
  const f = setup();
  for (const encoded of ["a", "_w", btoa("payload.exe"), "x".repeat(1601)]) {
    assert.deepEqual(f.determine({ byExtensionId: "test-extension",
      url: `data:text/plain;charset=utf-8;he-lyrics-filename=${encoded},text` }), [undefined]);
  }
});

test("浏览器取消与其他失败会传回错误，而不是假报成功", async () => {
  const f = setup(async () => { throw new Error("User canceled"); });
  assert.equal((await f.send()).error, "已取消歌词下载");
  const other = setup(async () => { throw new Error("文件不可写"); });
  assert.equal((await other.send()).error, "文件不可写");
});

test("忽略与歌词下载无关的扩展消息", async () => {
  assert.equal(await setup().send({ type: "unrelated" }), undefined);
});

test("LRC 与 TXT 全流程使用不同 MIME，TXT 正文确实不带时间轴", async () => {
  const { buildLyricFile } = require("../extension/lyrics.js");
  for (const format of ["lrc", "txt"]) {
    const f = setup();
    const file = buildLyricFile({ lyric: "[00:01.000]第一行\n[00:02.000]第二行" }, { format });
    const result = await f.send({ ...f.message, text: file.text, extension: file.extension });
    const mime = format === "lrc" ? "application/x-lrc" : "text/plain";
    assert.ok(f.calls[0].url.startsWith(`data:${mime};`));
    assert.equal(/\[00:/.test(downloadBody(f.calls[0].url)), format === "lrc");
    assert.ok(result.filename.endsWith(`.${format}`));
    assert.equal(result.verification, "complete");
  }
});

test("不能把实际被改成 TXT 的 LRC 下载假报为成功", async () => {
  const f = setup(undefined, { actualFilename: "C:\\Downloads\\歌曲 - 歌手.txt" });
  const result = await f.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /实际保存为.*歌曲 - 歌手\.txt/);
  assert.match(result.error, /预期为.*歌曲 - 歌手\.lrc/);
  assert.equal(f.listenerCount(), 0);
});

test("扩展名正确但歌名丢失时同样提示命名异常", async () => {
  const f = setup(undefined, { actualFilename: "C:\\Downloads\\下载.lrc" });
  assert.equal((await f.send()).ok, false);
});

test("允许 Chrome 重名后缀，并反馈真实落盘文件名", async () => {
  const f = setup(undefined, { actualFilename: "C:\\Downloads\\歌曲 - 歌手 (1).lrc" });
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.filename, "歌曲 - 歌手 (1).lrc");
  assert.equal(result.requestedFilename, "歌曲 - 歌手.lrc");
  assert.equal(result.verification, "complete");
});

test("另存为时尊重手动修改的歌名，但仍校验歌词格式后缀", async () => {
  const f = setup(undefined, { actualFilename: "C:\\My Music\\手动命名.lrc" });
  assert.equal((await f.send({ ...f.message, saveAs: true })).filename, "手动命名.lrc");
  const wrong = setup(undefined, { actualFilename: "C:\\My Music\\手动命名.txt" });
  assert.equal((await wrong.send({ ...wrong.message, saveAs: true })).ok, false);
});

test("下载中断会提示失败并清理监听器", async () => {
  const f = setup(undefined, { state: "interrupted" });
  const result = await f.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /下载未完成/);
  assert.equal(f.listenerCount(), 0);
});

test("等到完成事件后查询最终文件名，而不是提前采用请求名", async () => {
  const f = setup(undefined, { state: "in_progress" });
  let replied = false;
  const pending = f.send().then((result) => { replied = true; return result; });
  await new Promise(setImmediate);
  assert.equal(replied, false);
  assert.equal(f.listenerCount(), 1);
  f.change(123, { state: "complete", filename: "C:\\Downloads\\歌曲 - 歌手 (2).lrc" });
  const result = await pending;
  assert.equal(result.filename, "歌曲 - 歌手 (2).lrc");
  assert.equal(result.verification, "complete");
  assert.equal(f.listenerCount(), 0);
});

test("保存超时时明确返回等待状态，不假报完成且清理监听器", async () => {
  const f = setup(undefined, { state: "in_progress", timeoutDelay: 1 });
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.verification, "pending");
  assert.equal(f.listenerCount(), 0);
});

test("无法读取浏览器记录时只能说已提交，不能宣称已保存", async () => {
  const f = setup(undefined, { searchError: true });
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.verification, "unavailable");
  assert.equal(f.listenerCount(), 0);
});
