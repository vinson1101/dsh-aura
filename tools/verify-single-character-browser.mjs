/**
 * Real Chromium decoder/visual check of the production SingleCharacter only.
 * NOT Aura task, microphone, audio, authentication or end-to-end acceptance.
 * No backend mock. The only inputs are explicit stage props and local assets.
 * Starts its own loopback :0 server and browser, closes both in finally.
 *
 * Run: node tools/verify-single-character-browser.mjs
 * Optional: PLAYWRIGHT_CORE_PATH and CHROMIUM_EXECUTABLE override local tools.
 * VISUAL_WIDTHS=220 selects a diagnostic subset; default checks all three widths.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(ROOT, 'assets/runtime/short-hair/inspection/browser');
const widths = process.env.VISUAL_WIDTHS ? process.env.VISUAL_WIDTHS.split(',').map(Number) : [220,480,720];
assert.ok(widths.length && widths.every(width=>[220,480,720].includes(width)), 'VISUAL_WIDTHS must select 220,480,720');
const source = await readFile(path.join(ROOT, 'client.js'), 'utf8');
const componentStart = source.indexOf('function SingleCharacter(');
const componentEnd = source.indexOf('/** The tab body:', componentStart);
const styleStart = source.indexOf('const CHARACTER_SURROUND = {');
const styleEnd = source.indexOf('const CAPTION = {', styleStart);
assert.ok(componentStart > 0 && componentEnd > componentStart && styleStart > 0 && styleEnd > styleStart);
const component = source.slice(componentStart, componentEnd);
const styles = source.slice(styleStart, styleEnd);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH ||
  '/Users/vinson/.codex/worktrees/zebra-safe-response-diagnostics-20261016/UI/desktop/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core');
const executablePath = process.env.CHROMIUM_EXECUTABLE ||
  '/Users/vinson/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
await access(executablePath);
await mkdir(OUT, { recursive: true });

// Resource names are a fixed map. Never resolve a URL/user-supplied filesystem path.
const assets = new Map([
  ['/react.js', ['node_modules/react/umd/react.development.js', 'text/javascript']],
  ['/react-dom.js', ['node_modules/react-dom/umd/react-dom.development.js', 'text/javascript']],
  ['/aura/character/side.png', ['assets/runtime/short-hair/side.png', 'image/png']],
  ['/aura/character/short-hair.png', ['assets/previews/短发直播测试/无声倾听/短发正面直视-参考帧.png', 'image/png']],
  ...['turn', 'listen', 'return'].map(name => [`/aura/character/${name}.mp4`, [`assets/runtime/short-hair/${name}.mp4`, 'video/mp4']]),
]);
const instrumentation = String.raw`
window.__visualEvidence = { events: [], decoders: [], rafSamples: 0, missingPresentation: 0,
  presentationGaps: [], pendingImageDraws: 0, unexpectedClockResets: [], sampleErrors: [] };
const evidence = window.__visualEvidence;
const started = performance.now();
const seen = new WeakSet();
const attachDecoderObserver = video => {
  if (seen.has(video)) return;
  seen.add(video);
  video.dataset.checkId = String(document.querySelectorAll('video').length) + '-' + Math.random().toString(16).slice(2);
  const canvas = document.createElement('canvas'); canvas.width = 56; canvas.height = 71;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  const stats = new Map();
  const observe = (_, metadata) => {
    try {
      const src = video.getAttribute('src');
      if (src && video.videoWidth > 0) {
        ctx.drawImage(video, 0, 0, 56, 71);
        const pixels = ctx.getImageData(0, 0, 56, 71).data;
        let sum = 0, black = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const value = (pixels[i] + pixels[i+1] + pixels[i+2]) / 3;
          sum += value; if (value < 8) black++;
        }
        let item = stats.get(src);
        if (!item) {
          item = {id: video.dataset.checkId, src, frames: 0, minMeanRGB: 255, maxBlackPixelFraction: 0,
            firstMediaTime: metadata.mediaTime, lastMediaTime: 0, naturalLoops: 0};
          stats.set(src, item); evidence.decoders.push(item);
        }
        if (metadata.mediaTime + 0.1 < item.lastMediaTime && video.loop) item.naturalLoops++;
        item.frames++; item.lastMediaTime = metadata.mediaTime;
        item.minMeanRGB = Math.min(item.minMeanRGB, sum / (56*71));
        item.maxBlackPixelFraction = Math.max(item.maxBlackPixelFraction, black / (56*71));
      }
    } catch (error) { evidence.sampleErrors.push(String(error)); }
    video.requestVideoFrameCallback(observe);
  };
  video.requestVideoFrameCallback(observe);
};
new MutationObserver(() => document.querySelectorAll('video').forEach(attachDecoderObserver))
  .observe(document.getElementById('root'), {childList: true, subtree: true});
for (const event of ['loadeddata', 'playing', 'ended', 'error']) document.addEventListener(event, e => {
  if (e.target.tagName !== 'VIDEO') return;
  evidence.events.push({event, at: performance.now()-started, src: e.target.getAttribute('src'),
    time: e.target.currentTime, readyState: e.target.readyState, error: e.target.error?.message || null});
}, true);
const lastClocks = new Map();
const stillCanvas = document.createElement('canvas'); stillCanvas.width = stillCanvas.height = 1;
const stillContext = stillCanvas.getContext('2d', {willReadFrequently:true});
const monitorPresentation = () => {
  const node = document.querySelector('[data-aura-visual="single-character"]');
  if (node) {
    evidence.rafSamples++;
    const image = node.querySelector('img');
    let imageDrawable = image?.naturalWidth > 0, imageDrawError = null, imagePixelAlpha = null;
    // complete=false or naturalWidth=0 alone is not proof of a blank frame.
    // Always attempt native drawImage, including zero-naturalWidth transitions.
    if (image && !image.complete) {
      try {
        stillContext.clearRect(0,0,1,1); stillContext.drawImage(image,0,0,1,1);
        imagePixelAlpha = stillContext.getImageData(0,0,1,1).data[3];
        imageDrawable = imagePixelAlpha > 0;
        if (imageDrawable) evidence.pendingImageDraws++;
      } catch (error) { imageDrawable = false; imageDrawError = String(error); }
    }
    const visible = [...node.querySelectorAll('video')].filter(v => +v.style.opacity > 0);
    const ready = imageDrawable || visible.some(v => v.readyState >= 2 && v.videoWidth > 0);
    // Sample every RAF too: a reset cannot hide by catching up before an assertion.
    for (const video of visible) {
      const key = video.dataset.checkId + ':' + video.getAttribute('src');
      const previous = lastClocks.get(key);
      if (previous !== undefined && video.currentTime + .05 < previous &&
          !(video.loop && previous > video.duration - .5 && video.currentTime < .5)) {
        evidence.unexpectedClockResets.push({key,stage:node.dataset.auraState,previous,current:video.currentTime});
      }
      lastClocks.set(key,video.currentTime);
    }
    // Exclude only the initial image network load, not stage transitions.
    if (window.__initialImageReady && !ready) {
      evidence.missingPresentation++;
      evidence.presentationGaps.push({stage:node.dataset.auraState,clip:node.dataset.auraClip,
        imageComplete:image.complete,imageNaturalWidth:image.naturalWidth,imageCurrentSrc:image.currentSrc,
        imageDrawError,imagePixelAlpha,
        videos:[...node.querySelectorAll('video')].map(v=>({opacity:v.style.opacity,readyState:v.readyState,
          src:v.getAttribute('src'),time:v.currentTime}))});
    }
  }
  requestAnimationFrame(monitorPresentation);
};
requestAnimationFrame(monitorPresentation);
`;
const appScript = `
const h = React.createElement;
${styles}
const diag = (event, detail) => window.__visualEvidence.events.push({ event, detail, at: performance.now() });
${component}
const control = React.createRef();
function PlayerFixture() {
  const [stage, setStage] = React.useState('idle');
  window.setVisualStage = setStage;
  return h(SingleCharacter, {stage, sessionId:'VISUAL-ONLY-NO-TASK-INTERFACE', control});
}
ReactDOM.createRoot(document.getElementById('root')).render(h(PlayerFixture));
`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>仅播放器视觉检查 · 无任务接口</title>
<style>html,body{margin:0;width:100%;background:#242329;color:#fff;font:13px system-ui}header{box-sizing:border-box;padding:12px 10px;min-height:98px;background:#433414;border-bottom:2px solid #e7c15b}strong{display:block;color:#ffe29a}small{display:block;margin-top:5px}#root{position:relative;isolation:isolate;height:712px;width:100%;overflow:hidden}</style>
<header><strong>仅播放器视觉检查</strong><strong>无任务接口 / 非 Aura 全链路验收</strong><small>真实组件与解码器；只切换 stage。无麦克风、任务或音频后端。</small></header><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/instrumentation.js"></script><script src="/app.js"></script></html>`;
const requests = [];
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  requests.push({method: req.method, pathname, range: req.headers.range || null});
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  const scripts = new Map([['/', [html, 'text/html']], ['/app.js', [appScript, 'text/javascript']],
    ['/instrumentation.js', [instrumentation, 'text/javascript']]]);
  const script = scripts.get(pathname);
  if (script) { res.writeHead(200, {'content-type': `${script[1]};charset=utf-8`}).end(req.method === 'HEAD' ? null : script[0]); return; }
  const asset = assets.get(pathname);
  if (!asset) { res.writeHead(404).end(); return; }
  try {
    const data = await readFile(path.join(ROOT, asset[0]));
    const headers = {'content-type':asset[1], 'content-length':data.length, 'accept-ranges':'bytes', 'cache-control':'no-cache'};
    let start = 0, end = data.length - 1, status = 200;
    if (req.headers.range && req.method === 'GET') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match || +match[1] >= data.length) { res.writeHead(416, {'content-range':`bytes */${data.length}`}).end(); return; }
      start = +match[1]; end = Math.min(match[2] ? +match[2] : end, end);
      if (end < start) { res.writeHead(416).end(); return; }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${data.length}`;
      headers['content-length'] = end - start + 1;
    }
    res.writeHead(status, headers).end(req.method === 'HEAD' ? null : data.subarray(start, end + 1));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
let browser;
const results = {
  kind: 'ISOLATED PLAYER VISUAL CHECK ONLY — NO AURA TASK BACKEND OR END-TO-END CLAIM',
  timestamp: new Date().toISOString(), sourceFile: 'client.js',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  componentSha256: createHash('sha256').update(component).digest('hex'),
  styleSha256: createHash('sha256').update(styles).digest('hex'),
  fixture: {widths, height:712, browserViewportHeight:850,
    productionComponentUnmodified:true, productionStylesUnmodified:true, mockedMediaAPIs:false,
    stagePropsOnly:true, noTaskInterfaces:true, assetCacheControl:'no-cache'},
  executablePath, cases: [], requests,
};
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  results.isolatedOrigin = origin;
  browser = await chromium.launch({executablePath, headless:true});
  results.browserVersion = browser.version();
  for (const width of widths) {
    const context = await browser.newContext({viewport:{width,height:850}, deviceScaleFactor:1, reducedMotion:'no-preference'});
    const page = await context.newPage();
    const item = {width, screenshots:[], continuity:[], consoleErrors:[], pageErrors:[], networkErrors:[]};
    results.cases.push(item);
    page.on('pageerror', error => item.pageErrors.push(String(error)));
    page.on('console', message => { if(message.type()==='error') item.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => item.networkErrors.push({url:request.url(),error:request.failure()?.errorText}));
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await page.goto(origin, {waitUntil:'load'});
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-aura-visual] img');
      return img?.complete && img.naturalWidth > 0;
    });
    await page.evaluate(() => { window.__initialImageReady = true; });
    const snapshot = () => page.evaluate(() => {
      const node = document.querySelector('[data-aura-visual]');
      const video = [...node.querySelectorAll('video')].find(v => +v.style.opacity > 0);
      return {stage:node.dataset.auraState,clip:node.dataset.auraClip,id:video?.dataset.checkId,
        time:video?.currentTime || 0,src:video?.getAttribute('src'),readyState:video?.readyState,
        paused:video?.paused,videoWidth:video?.videoWidth,videoHeight:video?.videoHeight};
    });
    const waitClip = clip => page.waitForFunction(expected => {
      const node = document.querySelector('[data-aura-visual]');
      const video = [...node.querySelectorAll('video')].find(v => +v.style.opacity > 0);
      return node.dataset.auraClip === expected && video?.readyState >= 2 && video.videoWidth > 0 &&
        window.__visualEvidence.decoders.some(d => d.id === video.dataset.checkId && d.src.endsWith('/'+expected+'.mp4') && d.frames > 0);
    }, clip, {timeout:20000});
    const capture = async name => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const file = `${width}-${name}.png`;
      await page.screenshot({path:path.join(OUT,file), fullPage:true});
      const layout = await page.evaluate(() => {
        const surround = document.querySelector('[data-aura-visual]');
        const box = surround.querySelector('[data-aura-media-box]');
        const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
        return {containerUnitsSupported:CSS.supports('width','min(100cqw, calc(100cqh * 1113 / 1414))'),
          surround:rect(surround), mediaBox:box?rect(box):null,
          boxMask:box?getComputedStyle(box).maskImage:null,
          imageMask:getComputedStyle(surround.querySelector('img')).maskImage};
      });
      assert.ok(layout.containerUnitsSupported && layout.mediaBox, 'production media box must be laid out');
      assert.ok(layout.mediaBox.width>0 && layout.mediaBox.height>0, 'media box must not collapse');
      assert.ok(layout.mediaBox.width<=layout.surround.width+.1 && layout.mediaBox.height<=layout.surround.height+.1, 'media box must contain without cropping');
      assert.ok(Math.abs(layout.mediaBox.width/layout.mediaBox.height-1113/1414)<.002, 'preserve source aspect');
      assert.ok(layout.boxMask!=='none' && layout.imageMask==='none', 'mask actual media edges, not letterbox bounds');
      item.screenshots.push({file, ...await snapshot(), layout});
    };
    const advanceStage = async stage => {
      const before = await snapshot();
      await page.evaluate(value => window.setVisualStage(value), stage);
      await page.waitForFunction(value => document.querySelector('[data-aura-visual]').dataset.auraState === value, stage);
      // Observe naturally progressing media time, without assigning currentTime.
      await page.waitForFunction(previous => {
        const video=[...document.querySelectorAll('video')].find(v=>+v.style.opacity>0);
        return video?.currentTime > previous.time + .12;
      }, before);
      const after = await snapshot();
      assert.equal(after.id,before.id, `${width}px ${stage}: visible layer must not be replaced`);
      assert.equal(after.src,before.src, `${width}px ${stage}: source must not restart`);
      assert.ok(after.time >= before.time, `${width}px ${stage}: playback must not reset to zero`);
      item.continuity.push({stage,before,after});
    };
    await capture('side');
    await page.evaluate(() => window.setVisualStage('capturing'));
    await waitClip('turn');
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => +v.style.opacity>0 && v.currentTime>.3));
    await advanceStage('waiting');
    await advanceStage('speaking');
    await capture('turn');
    await waitClip('listen'); // Natural turn end; no synthetic ended event or seek.
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => +v.style.opacity>0 && v.currentTime>.3));
    await advanceStage('waiting');
    await advanceStage('speaking');
    await capture('listen');
    if (width === 480) {
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v=>+v.style.opacity>0 && v.currentTime>11.4), null, {timeout:15000});
      await capture('listen-before-loop');
      await page.waitForFunction(() => window.__visualEvidence.decoders.some(d=>d.src.endsWith('/listen.mp4') && d.naturalLoops>0), null, {timeout:5000});
      await capture('listen-after-loop');
      item.naturalListenLoopVerified = true;
    }
    await page.evaluate(() => window.setVisualStage('idle'));
    await waitClip('return');
    await capture('return');
    await page.waitForFunction(() => document.querySelector('[data-aura-visual]').dataset.auraClip==='side', null, {timeout:15000});
    item.afterNaturalReturn = await snapshot();
    await capture('side-after-return');
    item.evidence = await page.evaluate(() => window.__visualEvidence);
    assert.equal(item.pageErrors.length,0);
    assert.equal(item.consoleErrors.length,0);
    assert.equal(item.evidence.sampleErrors.length,0);
    // Keep collecting the other viewport screenshots if presentation fails;
    // fail the complete run below rather than suppressing the recorded gap.
    item.presentationPassed = item.evidence.missingPresentation === 0;
    assert.equal(item.evidence.unexpectedClockResets.length,0);
    assert.ok(!item.evidence.events.some(e=>e.event==='error'||e.event==='character_fallback'));
    for (const decoder of item.evidence.decoders) {
      assert.ok(decoder.frames>0 && decoder.minMeanRGB>15 && decoder.maxBlackPixelFraction<.5,
        `${width}px: unexpected black/empty decoded frame`);
    }
    await context.close();
    console.log(`${width}px: real side/turn/listen/return decoded; stage clocks continuous; screenshots saved`);
  }
  assert.ok(requests.every(r=>['/','/app.js','/instrumentation.js',...assets.keys()].includes(r.pathname)), 'no task/backend endpoints');
  assert.ok(results.cases.every(item=>item.presentationPassed), 'at least one viewport had no drawable media in a RAF; see presentationGaps');
  results.passed = true;
} catch (error) {
  results.passed = false; results.failure = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve=>server.close(resolve));
  results.cleanup = {ownedBrowserClosed:true, ownedServerClosed:!server.listening};
  await writeFile(path.join(OUT,'results.json'), JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify({passed:results.passed,browser:results.browserVersion,widths:results.cases.map(c=>c.width),cleanup:results.cleanup,failure:results.failure},null,2));
}
