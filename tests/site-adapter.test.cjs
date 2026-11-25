"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdapter, walkComponents, findLyricRequest, allowLyricFields } = require("../extension/site-adapter.js");

function fixture(naming = "artist-title") {
  const modal = {};
  const provides = { [Symbol()]: { _s: new Map([["setting", { fileNameFormat: naming }]]) } };
  const song = { id: "42", platform: "kuwo", name: "歌曲" };
  const component = { type: { __name: "DownloadSong" }, props: { song }, subTree: { el: modal } };
  const app = { _vnode: { children: [{ component }] }, __vue_app__: { _context: { provides } } };
  const calls = [];
  const Client = async (config) => {
    calls.push(config);
    return { lyric: "[00:01.000]歌词", trans: "[00:01.000]译文", roma: "", token: "不应传出" };
  };
  const sourceURL = (e, t) => Client({ url: "/v1/song/url", params: { id: e, platform: t } });
  const exports = { randomExport: Client, anotherExport: sourceURL, info: {
    getPlayerInfoObj: (value) => ({ name: value.name, artist: "歌手/A", album: "专辑" }),
  } };
  let open = true;
  let clock = 0;
  let imports = 0;
  const document = {
    querySelector: (selector) => selector === "#app" ? app : open && selector.includes('="test-token"') ? modal : null,
    querySelectorAll: () => [],
  };
  const adapter = createAdapter({
    document, origin: "https://y.hmusic.top", now: () => clock,
    performance: { getEntriesByType: () => [
      { name: "https://malicious.invalid/assets/stores-bad.js" },
      { name: "https://y.hmusic.top/assets/stores-current.js" },
    ] },
    loadModule: async (url) => {
      imports++;
      assert.equal(url, "https://y.hmusic.top/assets/stores-current.js");
      return exports;
    },
  });
  return { adapter, calls, exports, song, app, modal, close: () => { open = false; },
    advance: (ms) => { clock += ms; }, imports: () => imports };
}

test("从实际下载弹窗提取歌曲，文件命名跟随原站设置", async () => {
  for (const [format, expected] of [["artist-title", "歌手&A - 歌曲"], ["title-artist", "歌曲 - 歌手&A"], ["title", "歌曲"]]) {
    const { adapter } = fixture(format);
    assert.deepEqual(await adapter.getContext("test-token"), {
      title: "歌曲", artist: "歌手/A", album: "专辑", filenameBase: expected, songId: "42", platform: "kuwo",
    });
  }
});

test("不固定压缩导出名，复用网站请求客户端获取对应歌曲", async () => {
  const { adapter, calls, imports } = fixture();
  const result = await adapter.getLyrics("test-token");
  assert.equal(result.context.songId, "42");
  assert.deepEqual(result.lyrics, { lyric: "[00:01.000]歌词", trans: "[00:01.000]译文", roma: "" });
  assert.deepEqual(calls, [{ url: "/v1/song/lyric", method: "GET", params: { id: "42", platform: "kuwo" }, timeout: 15000, skipErrorMessage: true }]);
  await adapter.getContext("test-token");
  assert.equal(imports(), 1);
});

test("原站异步下载关闭弹窗后，仍然保留最初选中的歌曲", async () => {
  const f = fixture();
  await f.adapter.getContext("test-token");
  f.close();
  const result = await f.adapter.getLyrics("test-token");
  assert.equal(result.context.songId, "42");
  f.advance(10 * 60 * 1000 + 1);
  await assert.rejects(f.adapter.getLyrics("test-token"), /无法识别/);
});

test("同一弹窗切换歌曲时使用新歌曲，而非上一首缓存", async () => {
  const f = fixture();
  await f.adapter.getContext("test-token");
  f.song.id = "43";
  f.song.name = "新歌曲";
  const result = await f.adapter.getLyrics("test-token");
  assert.equal(result.context.songId, "43");
  assert.equal(result.context.title, "新歌曲");
});

test("支持网站直接导出歌词函数", async () => {
  const Client = async (config) => config.params;
  const direct = (id, platform) => Client({ url: "/v1/song/lyric", params: { id, platform } });
  assert.deepEqual(await findLyricRequest({ renamed: direct })("7", "other"), { id: "7", platform: "other" });
});

test("无法识别请求函数时准确报适配错误，不声称网站接口已改变", () => {
  assert.throws(() => findLyricRequest({}), /无法识别网站的歌词请求函数/);
});

test("兼容当前网站 await 请求后再处理结果的异步包装", async () => {
  const calls = [];
  let audioFunctionCalled = false;
  const Client = async (config) => { calls.push(config); return { lyric: "[00:01]歌词" }; };
  const normalize = (value) => value;
  const audioURL = async (id, platform, extra = {}) => {
    audioFunctionCalled = true;
    return normalize(await Client({ ...extra, url: "/v1/song/url", params: { id, platform } }));
  };
  const result = await findLyricRequest({ renamedURL: audioURL, renamedClient: Client })("42", "kuwo");
  assert.equal(result.lyric, "[00:01]歌词");
  assert.equal(audioFunctionCalled, false);
  assert.deepEqual(calls, [{ url: "/v1/song/lyric", method: "GET", params: { id: "42", platform: "kuwo" },
    timeout: 15000, skipErrorMessage: true }]);
});

test("兼容立即执行函数包裹请求，与当前压缩脚本结构一致", async () => {
  const Client = async (config) => config.params;
  const audioURL = async (id, platform, extra = {}) => function (result) {
    return { ...result, checked: true };
  }(await Client({ ...extra, url: "/v1/song/url", params: { id, platform } }));
  assert.deepEqual(await findLyricRequest({ audioURL, Client })("7", "kuwo"), { id: "7", platform: "kuwo" });
});

test("音频函数不再导出时可从已知歌曲查询函数识别客户端", async () => {
  const Client = async (config) => config;
  function detail(id, platform) {
    return Client({ url: "/v1/song/detail", params: { id, platform } });
  }
  const result = await findLyricRequest({ detail, Client })("9", "kuwo");
  assert.equal(result.url, "/v1/song/lyric");
  assert.deepEqual(result.params, { id: "9", platform: "kuwo" });
});

test("客户端压缩名含美元符号时仍按完整标识符识别", async () => {
  const $client = async (config) => config.params;
  const search = (query) => $client({ url: "/v1/song/lyric/search", params: query });
  assert.deepEqual(await findLyricRequest({ search, $client })("5", "kuwo"), { id: "5", platform: "kuwo" });
});

test("不将属性方法调用或非歌曲接口误认为导出的歌词客户端", () => {
  const Client = async (config) => config;
  const service = { Client };
  const unrelated = () => Client({ url: "/v1/user/profile" });
  const propertyCall = () => service.Client({ url: "/v1/song/url" });
  assert.throws(() => findLyricRequest({ Client, unrelated, propertyCall }), /无法识别/);
});

test("网络与登录失败不向页面传出原始错误详情", async () => {
  const f = fixture();
  f.exports.randomExport = async function Client() { throw new Error("secret-token"); };
  await assert.rejects(f.adapter.getLyrics("test-token"), (error) => {
    assert.match(error.message, /检查网络、登录状态/);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

test("跨窗口消息仅返回允许的歌词字段，过滤认证和其他任意属性", () => {
  assert.deepEqual(allowLyricFields({ token: "secret", lrc: { lyric: "原文", cookie: "secret" },
    data: { tlyric: { lyric: "译文" }, user: { name: "不应传出" } } }),
  { lrc: { lyric: "原文" }, data: { tlyric: { lyric: "译文" } } });
  assert.deepEqual(allowLyricFields(null), {});
  assert.throws(() => allowLyricFields({ lyric: "a".repeat(2 * 1024 * 1024 + 1) }), /内容过大/);
});

test("拒绝不合法弹窗标识", async () => {
  await assert.rejects(fixture().adapter.getContext('x"] div'), /标识无效/);
});

test("遍历 Vue Teleport、Suspense 和循环结构时不会无限递归", () => {
  const wanted = { type: { __name: "DownloadSong" } };
  const root = { children: [] };
  root.children.push(root, { suspense: { activeBranch: { component: wanted } } });
  assert.equal(walkComponents(root, (component) => component === wanted), wanted);
  assert.equal(walkComponents(root, () => false), null);
});

test("歌曲模块拆分时跳过无歌词接口的 store，复用同源主窗口模块", async () => {
  const f = fixture();
  const origin = "https://y.hmusic.top";
  const loaded = [];
  const adapter = createAdapter({
    document: { querySelector: s => s === "#app" ? f.app : f.modal,
      querySelectorAll: () => [{ src: origin + "/assets/mainWindow-current.js" }] },
    performance: { getEntriesByType: () => [{ name: origin + "/assets/stores-current.js" }] },
    origin, loadModule: async url => { loaded.push(url); return url.includes("/stores-") ? {} : f.exports; },
  });
  assert.equal((await adapter.getLyrics("test-token")).lyrics.lyric, "[00:01.000]歌词");
  assert.deepEqual(loaded, [origin + "/assets/stores-current.js", origin + "/assets/mainWindow-current.js"]);
});

test("找不到同源歌曲模块时明确报错", async () => {
  const f = fixture();
  const adapter = createAdapter({
    document: { querySelector: (s) => s === "#app" ? f.app : f.modal, querySelectorAll: () => [] },
    performance: { getEntriesByType: () => [{ name: "https://elsewhere.invalid/assets/stores-test.js" }] },
    origin: "https://y.hmusic.top", loadModule: () => { throw new Error("不应调用"); },
  });
  await assert.rejects(adapter.getContext("test-token"), /未找到网站的歌曲模块/);
});
