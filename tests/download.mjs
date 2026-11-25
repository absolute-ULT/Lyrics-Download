// Windows + Chrome. Run from any folder: node tests/download.mjs <unpacked extension>
// Real Chrome extension, isolated profile, local song fixture; no account or network needed.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
const extension = path.resolve(process.argv[2]);
const dir = await mkdtemp(path.join(tmpdir(), 'he-lyrics-test-'));
const downloads = path.join(dir, 'downloads');
await mkdir(downloads);
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--disable-background-networking', '--no-first-run', `--user-data-dir=${path.join(dir,'profile')}`,
], { stdio:['ignore','ignore','ignore','pipe','pipe'] });
const exited = once(browser, 'exit');
let seq = 0, buffer = '';
const waiting = new Map();
function call(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(Error('Timeout: '+method)); },10000);
    waiting.set(id, m => { clearTimeout(timer); m.error ? reject(Error(method+': '+m.error.message)) : resolve(m.result); });
    browser.stdio[3].write(JSON.stringify({id,method,params,sessionId})+'\0');
  });
}
const fixture = `<!doctype html><meta charset=utf-8><div id="app"><div class="download-song"><div class="menu"><button class="n-button--primary-type">下载歌曲</button></div></div></div>
<script type="module" src="/assets/stores-fixture.js"></script><script>
const el=document.querySelector('.download-song');document.querySelector('#app')._vnode={component:{type:{name:'DownloadSong'},subTree:{el},props:{song:{id:42,platform:'test',name:'测试曲'}}}};
</script>`;
const moduleText = `export async function lyric(id,platform){const route={url:'/v1/song/lyric'};if(id!=='42'||platform!=='test')throw Error('wrong song');return {lyric:'[00:01.00]测试歌词'}}`;
browser.stdio[4].setEncoding('utf8');
browser.stdio[4].on('data', data => {
  buffer+=data; let cut;
  while((cut=buffer.indexOf('\0'))>=0){
    const m=JSON.parse(buffer.slice(0,cut));buffer=buffer.slice(cut+1);
    if(waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}
    if(m.method==='Fetch.requestPaused'){
      const p=new URL(m.params.request.url).pathname;
      const body=p==='/'?fixture:p==='/assets/stores-fixture.js'?moduleText:'';
      void call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:body?200:404,responseHeaders:[{name:'Content-Type',value:p.endsWith('.js')?'text/javascript':'text/html;charset=utf-8'}],body:Buffer.from(body).toString('base64')},m.sessionId);
    }
  }
});
try {
  await call('Extensions.loadUnpacked',{path:extension});
  await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const tab=(m,p)=>call(m,p,sessionId);
  await tab('Fetch.enable',{patterns:[{urlPattern:'https://y.hmusic.top/*'}]});
  await tab('Page.navigate',{url:'https://y.hmusic.top/'});
  const evaluate=async expression=>{const r=await tab('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  async function until(expr){for(let i=0;i<100;i++){const v=await evaluate(expr);if(v)return v;await delay(100);}throw Error('Timeout waiting for '+expr);}
  await until(`document.querySelector('.he-lyrics-status')?.textContent.includes('测试曲')`);
  for(const [format,button] of [['lrc','.he-lyrics-only'],['txt','.menu button']]){
    await evaluate(`document.querySelector('.he-lyrics-select').value=${JSON.stringify(format)}`);
    const {x,y}=await evaluate(`(()=>{const r=document.querySelector('${button}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await tab('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
    const status=await until(`(()=>{const e=document.querySelector('.he-lyrics-status');return (e.classList.contains('he-lyrics-error')||e.textContent.includes('.${format}'))&&e.textContent})()`);
    assert.match(status,/^歌词已保存/);
    const bytes=await readFile(path.join(downloads,'测试曲.'+format));
    assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
    const text=bytes.subarray(3).toString();
    assert.ok(format==='txt'?text==='测试歌词':text.includes('[00:01.000]测试歌词'));
    console.log('PASS '+format+': 中文歌名、文件后缀、内容和完成提示');
  }
} finally {
  await call('Browser.close').catch(()=>browser.kill());
  await exited;
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
