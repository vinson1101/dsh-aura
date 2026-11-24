// Independent local visual preview, NOT a screenshot or a second DSH runtime.
// Reuse the actual pane geometry/artwork styles without emulating React/DOM.
import fs from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = await fs.readFile(new URL('client.js', root), 'utf8');
const styles = {};
for (const name of ['PANE', 'STAGE', 'CHARACTER_SURROUND', 'CHARACTER_IMAGE', 'INPUT', 'BUTTON', 'FOOTER', 'ROW', 'CAPTION']) {
  const match = source.match(new RegExp(`    const ${name} = (\\{[\\s\\S]*?\\});`));
  if (!match) throw new Error('Missing style ' + name);
  styles[name] = vm.runInNewContext('(' + match[1] + ')');
}
const css = obj => Object.entries(obj).map(([key, value]) => `${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${typeof value === 'number' && value !== 0 && !['zIndex', 'opacity', 'flex'].includes(key) ? value + 'px' : value}`).join(';');
const photo = await fs.readFile(new URL('assets/previews/短发直播测试/无声倾听/短发正面直视-参考帧.png', root));
const data = 'data:image/png;base64,' + photo.toString('base64');
const actualCSS = source.match(/    const STYLE = `([\s\S]*?)`;/)[1];
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aura 短发半身 · 本地视觉预览</title>
<style>
:root{color-scheme:dark;--dsw-alias-border-base:#7776}*{box-sizing:border-box}body{margin:0;padding:20px;background:#202124;color:#eee;font:14px system-ui}aside{max-width:900px;line-height:1.6;margin-bottom:16px}button,input,textarea{font:inherit}nav{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}nav button{padding:6px 14px}#frame{width:400px;height:760px;max-width:100%;background:#26272a;overflow:hidden;resize:both;min-width:260px;min-height:400px;border-radius:10px}#pane{${css(styles.PANE)}}#surround{${css(styles.CHARACTER_SURROUND)}}#portrait{${css(styles.CHARACTER_IMAGE)}}#stage{${css(styles.STAGE)}}#footer{${css(styles.FOOTER)}}#row{${css(styles.ROW)}}textarea{${css(styles.INPUT)}}.smallbtn{${css(styles.BUTTON)}}#caption{${css(styles.CAPTION)}}
${actualCSS}
#orb{display:none;width:160px;height:160px;border:5px dotted #b4d9f7;border-radius:50%;opacity:.8}#pane:not(.aura-character) #surround{display:none}#pane:not(.aura-character) #orb{display:block}#preview-state{font-size:11px;min-height:16px}details{margin-top:20px}details img{max-width:320px}body.light{background:#eee;color:#222}body.light #frame{background:#fafafa;color:#222}
</style>
<aside><strong>独立本地视觉预览，不是当前 DSH 窗口截图。</strong><br>直接复用当前 Aura 的 pane / stage / 原图 / 输入区样式。整幅原图等比保留，原图背景边缘取色延展至整个插件面板；只在图像最外 8px 淡化接缝，不模糊发丝、不重复人脸。标题、电话、输入浮于连续画面。宿主拥有的 tab 栏不在插件可控范围，本页不冒充它。<br>这里只验证视觉交互：不会打开麦克风、不会通话、不会连接 API。实际粒子在 DSH 内，本页粒子仅占位。
<nav><button onclick="size(320,720)">窄 320 × 720</button><button onclick="size(520,760)">宽 520 × 760</button><button onclick="document.body.classList.toggle('light')">浅/深外部环境</button><label><input id="toggle" type="checkbox" checked>显示数字人</label></nav></aside>
<div id="frame"><section id="pane" class="aura-character"><div id="surround" data-aura-visual="portrait"><img id="portrait" src="${data}" width="1113" height="1414" alt="原图：短发正面半身" draggable="false"></div><div class="aura-top"><button class="aura-chip" onclick="hint('本地视觉预览 · 版本 0.35.3 + short-hair-static-v1')"><span class="aura-ava-fallback">A</span><span class="aura-chip-text">Aura</span></button></div><div id="stage"><div id="orb" aria-label="粒子占位"></div><button class="aura-call" aria-label="通话预览" onclick="hint('仅视觉预览，不拨号、不启用麦克风')">☎</button></div><div id="caption">静态倾听 · 无自动播放</div><div id="footer"><div id="row"><textarea rows="1" placeholder="Ask in this session…" aria-label="预览输入"></textarea><button class="smallbtn" onclick="hint('仅视觉预览，不启用麦克风')" aria-label="麦克风预览">♩</button><button class="smallbtn" onclick="hint('仅视觉预览，不发送会话消息')" aria-label="发送预览">↑</button></div><div class="aura-id-mono" style="white-space:normal;line-height:1.5">简单问题直接答，任务独立执行。插话或挂断不停止任务；普通模式：/aura off。</div><div id="preview-state" role="status"></div></div></section></div>
<details><summary>对照未加工原图（完整 1113 × 1414）</summary><img src="${data}" alt="未加工原图"></details>
<script>const pane=document.getElementById('pane');document.getElementById('toggle').onchange=e=>pane.classList.toggle('aura-character',e.target.checked);function size(w,h){const f=document.getElementById('frame');f.style.width=w+'px';f.style.height=h+'px'}function hint(s){document.getElementById('preview-state').textContent=s}</script></html>`;
const output = new URL('assets/previews/aura-short-hair-panel-local.html', root);
await fs.writeFile(output, html);
console.log(output.pathname, Buffer.byteLength(html), 'bytes; one self-contained file');
