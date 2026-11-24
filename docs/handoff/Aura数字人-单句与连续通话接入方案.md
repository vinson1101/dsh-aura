# Hand-off: Aura 数字人单句接入

Owner: lead
Updated: 2026-11-24 Asia/Shanghai   Branch: main   Last commit: 92d0d39（本次同步前基线；最新提交见 `git log -1`）

## 本次 Git 同步范围（2026-11-24）

- 用户要求把本地代码同步到远端，并明确同意交接文档一起提交。只提交源码、测试、工具、本交接与运行白名单素材；不把本地预览目录、录音录像、inspection、模型环境、历史生成素材/参考库和根目录临时验收文本带入 Git，也不删除它们。
- 运行必需素材不能把整个 previews 目录排除：以 `package.json` 的 files 白名单为准，包含 peach 两项、short-hair 五项，以及 previews 下正面参考帧/十秒倾听/Wan十秒无声底片三项。其他草稿不代表运行依赖。
- 同步前真实复跑全部21条离线回归命令，exit0；日志在本机 `.aura-local-preview/git-sync-20261124/regression-all.log`。另做只读安全审查，未见凭证泄露、默认强制启用、auth/owner 绕过或原生任务执行回归阻断。
- 已知跨机限制：默认测试的真实ffmpeg/ffprobe fixture仍要求本机 `/opt/homebrew/bin/ffmpeg` 与 `/opt/homebrew/bin/ffprobe`，不能声称 Ubuntu 或其他机器只 `npm install && npm test` 即可复现；README已明确说明，尚未改造此路径。
- 本轮只做Git同步及README/交接状态更新，不改现有冻结制品、profile或GUI部署，不追加TTS、推理、录屏。下列绝对路径和被忽略目录中的证据仍是本机材料，不随源码上传。

## 当前 Goal（2026-11-23 v3；以下历史不能覆盖本节）

按用户最新纠正“那你做到我可以测试啊”：把连续正面的单句任务及**本次完整女声 → 既有 Wan + LatentSync → 完整已校验 AV → 播放**接到当前 GUI，而非只交源码。录屏暂缓；不开发连续通话，不新增模型、付费 API 或素材，不再用局部嘴片、闭口配音、旧回答视频。不得擅自启动昂贵的新推理。**代码通过、安装成功、Host 激活和视觉验收是不同状态。**

## 当前 Decisions / Constraints / Ruled out

- 初始、闲置、倾听、思考、准备、说完均正面；倾听→思考不换视频/不重置相位。共用单个 video 与十秒无声正面循环，接缝已接受但不宣称无缝。
- 仅闲置 300 秒允许回侧身；收音、任务执行、准备和播放均阻止回侧。侧身点麦立刻收音，既有完整转身不被短接；答复太快可排在转身结束之后。
- 整句准备完成才播放，不流式拼接嘴型；一个有声 video 时钟，`playing` 才算 speaking，`ended` 才算完成。取消须撤销进程组、轮询、待播 AV 与旧事件；原生已派发任务本身继续原生命周期。
- 固定已验证本机 MPS/float16、512、16 帧/chunk、CFG1.5、seed1247、20steps、DeepCache interval3/branch0；不调参换模型。历史 21.84 秒样例约 3236 秒（54 分钟）是参考，不是本次耗时。
- 明确选择已支持女声及 `cosyvoice-v3-flash`，不偷偷替换用户 voice/model；单请求最多 240 字、25 秒 PCM，超限明确拒绝而非截断；只允许一个活动 render。

## 当前状态：0.35.4-visual.3（2026-11-24 Asia/Shanghai）

- **已部署原56195 GUI，极短句当前回答音画与人耳声音验收通过。** 仅限本次“你好。”，不代表长句、实时或连续通话验收。主画面新增“文字已回复，音画仍在生成”，中文真实阶段/elapsed/step；明确当前待机、非实时分钟级或更久、切换/关闭/刷新取消。ready不称speaking，仅真实playing清卡，buffering单独提示。补instance cleanup/close/error/timeout安全标量诊断，不含token/URL/CloseEvent.reason，不改变owner/心跳/native独立任务或生成参数。
- **最终21组回归全过**，character19/19、single-visual24/24（新增6项生产Pane DOM/生命周期用例）、readiness11/11：[本轮完整日志](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/regression-all.log>)。root审查最终相对冻结.2增量，独立UX source review无blocking：[审查及未验证边界](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/ux-review.json>)。无浏览器控制，不冒充真实卡片截图、布局/点击/读屏验收；JSDOM媒体替身不证明解码/出声。本次有声结论另有真实页面事件与用户明确确认，见下。
- [新冻结制品](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.3-r1/artifact.json>)：54files/16,030,749bytes，sourceDigest `a257f91e555e7e924c21d6ac6f98da3189419c98708f91b31881869978fc7613`；artifactDigest `943ae42e7e9b62eaf09d59d89d447700163cc3a64d9c24546ea94275e1afdb49`。相对.2 frozen-input仅README/client/index/package四文件改变；稳定wrapper/本地ws8.23.0/全部生产import/显式false/非法shape/ASR-TTS保留在安装前后通过：[安装后验证](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/artifact-verify-postinstall.log>)。
- 已先告知profile影响并保存[80M全profile/sessions快照](</Users/vinson/.dsh/backups/20261124-101609-aura-before-visual3-preparation-visibility/manifest.txt>)；官方manager remove .2→install .3均applied、warnings[]。pnpm有与.2安装相同的通用peer warning，未豁免版本。原patch字节/非Aura package字段hash断言不变；实际Host enabled=true、Client factory/apply/registered，live header/body/title Slots均active；真实dsh-app前台待机视频解码error0/readyState4且持续出帧：[运行证据](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/runtime-check.json>)。[部署账本](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.3-r1/deployment.json>)记录hash、操作日志及边界。旧.2/r4/r3制品保留；没有重启DSH/替代server/录屏/commit/push。
- **新增单次真实测试已成功并耗尽追加授权**：[授权记录](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/renewed-authorization.json>)。原测试会话的job `223a8350-fd5f-4cb8-96ba-117e55b56ff1` 于10:53:13.617开始，当前 `longyan_v3`/`cosyvoice-v3-flash`；6.958s进入TTS、7.411s loading-models、14.863s rendering、174.307s muxing、175.147s validating、**175.192s ready**，cacheHit=false。回答143,761bytes、554×740、0.96s，真实dsh-app authenticated-blob解码readyState4/error0，hidden=false/paused=false/muted=false/volume1，mediaTime0.04→0.08→0.12；10:56:10.596实际playback-ended，没有提前关闭取消。[机器完整证据](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/authorized-short-reply.json>)保持原样，不能把机器无法判断的人耳字段改成自动确认。
- **用户在声音验收确认工具明确回复“听到了，但是很快就结束了”。** 本次仅“你好。”，PCM0.88s/视频0.96s，所以不到1秒正常播完；不是截断的新证据。[验收记录及机器证据SHA256](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/preparation-visibility-20261124/audio-acceptance.json>)单独记录人耳确认与时长，部署账本已同步。pre-deploy提示修复没有TTS；post-deploy按新授权实际跑了一次TTS/口型，无自动重试。只读监听 `bash-c2ae1f5131fe44bf` 已exit0且收集，无仍在运行的本轮监听/推理；没有追加录屏/生成。**这轮修复及极短句验收完成；后续任何真实生成须重新取得明确授权。** 约3分钟准备不等于实时，长句/连续通话/时延性能与真实准备卡片布局/hit-test/明暗主题未验收，不扩大结论。

## .2 播放修复历史（以下不是当前部署版本）

- 用户实测 r3“人物不动、无声”，最新要求“那你修复一下”。当时源码/实际 GUI 更新到 **0.35.4-visual.2**（当前已升.3，见上节）；保留 main/92d0d39 与全部既有脏变更，无提交/推送。不把部署成功当验收完成。
- 确定故障：真实 Desktop `dsh-app:` 直接给 video 的 MP4 在首帧前 `DEMUXER_ERROR_COULD_NOT_OPEN`/媒体错误4，而同页已鉴权 HEAD200。已改为已鉴权、完整且有界 fetch → MP4 Blob → **同一个 video**；HTTP 浏览器仍直接加载。静态8MiB/回答64MiB上限、下载15s、可见解码另15s，hidden 不误报解码超时，取消/换会话撤销 fetch、reader、URL、timer 与旧回调。
- 同步修复：转身失败会拒绝排队回答，不再永远等待播放器；短暂 GET 网络/5xx 最多3次重试同一 job，不再次 POST/TTS/推理；`NotAllowedError` 保留同 AV，提供背景负层之外、可点击的“点击播放音画”按钮；visibility 主动 pause 的晚 AbortError 按 play 序号失效，不误删回答。仍只以 playing/ended 驱动 speaking/完成，没有独立 PCM 回退。
- 历史短答“我叫 Aura。”的 job 在约10.86s、loading-models 阶段取消，**从未 ready；原始取消来源未证实**，不能归因于播放。现在 Client DELETE、所有 stop 路径、Host ownership/socket/心跳/expiry/dispose 记录首个固定原因与 stage；未放宽4s心跳/12s ownership 超时，也未取消 leave 时的正确撤销。
- **最终21组测试命令全过**：character19/19、single-visual18/18、readiness11/11，另含 Host/instance/ASR/TTS、真实 ffmpeg fixture、synthetic 十轮、barge/dispatch-race/密钥扫描。[修复回归日志](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/regression-all-final.log>)。第一次整套运行仅旧 barge 源字符串断言因新增 reason 不匹配，更新断言后全过；第一次制品验证仅验证器写死旧版本，改为明确期望版本+冻结 manifest+record 一致性后通过。保留失败日志，不隐瞒。React border/borderColor warning 仍在。
- 独立 [修复制品记录](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.2-r1/artifact.json>)：54文件，sourceDigest `132a7b6dd26b6a8aec17c106555b156bbb98d0626648e5ca04d3c86431cfc096`，artifactDigest `7c4d225eabcccd0ef734ec522fadad127abf0bad1129686bed6fedd4b95ea79d`。保留稳定 index 入口+同目录 host-runtime 的本机启用 wrapper，源码默认禁用不变。安装前后全 hash/import/ws8.23.0/wrapper 显式 false/非法配置/保留 ASR-TTS 均过：[安装后验证](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/artifact-verify-postinstall.log>)。冻结后仅更新源码文档/验证器，未修改制品；其 README 是冻结时的 r3 说明，当前状态以本节和版本 manifest/账本为准。
- 真实 manager remove r4 → install 本修复，均 `application:applied`/warnings[]；未重启 DSH、未启动替代 GUI/浏览器服务器。现有 `http://127.0.0.1:56195` Client 已 apply/registered；真实 Host enabled=true。[修复部署账本](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.2-r1/deployment.json>)已落盘。活跃软链接、profile patch 原字节不变、非 Aura package 字段不变均已断言：[部署运行证据](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/runtime-check.json>)。其中激活前两条 enabled=false 来自测试 fixture，不是当前运行状态。
- **真实前台人物播放已通过，声音尚未验收**：最初 `character_asset_loaded` 1,357,805字节、authenticated-blob → `character_decoded` readyState4/error0/720×914/10s。用户将窗口切前台后明确回复“已经开始动”；现场随后有 `character_clip` 与 `character_frame`：hidden=false/paused=false/error0，mediaTime 0.04→0.08→0.12，完整10s循环后 presentedFrames 从2–4增至250–252。[前台及跨循环证据](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/foreground-check.json>)。待机 muted=true 正常，不等于回答无声；本修复尚无当前回答的实际 unmuted playing/ended/人耳确认。手势恢复仅 DOM/源码验证，真实按钮 hit-test 尚未做。
- 保护快照：[修复前81M完整 profile/sessions](</Users/vinson/.dsh/backups/20261124-091918-aura-before-visual2-playback-fix/manifest.txt>)。r3/r4 旧制品均保留；播放修复部署时无新TTS/推理；随后已授权声音测试实际调用一次TTS并进入rendering，见下节，不能再标“未新推理”。无录屏。紧急停用仍用 `plugin_manager set_bundle target=dsh-aura enabled=false`；原生任务自身生命周期不变。完整恢复快照涉及全 profile/sessions，执行前必须告知；linked 源码另行管理，不能 reset/clean 脏树。

### 三次短句测试记录与当前授权边界

1. 人物前台运动和完整10s循环已由真实日志及用户确认，不再重复重装/测试这一步。
2. 用户已在确认工具明确选择“已发送，允许这一次测试”，授权一次极短当前女声“你好。”真实 TTS/LatentSync 验证。但首尝试 job `a69bc701-eb17-4eb5-b46a-ae312bae7c57` 于09:53:42.855开始，5.423s即在 **preflight** 被 `ownership-socket-close` 取消；尚无TTS/PCM/模型加载。其后原对话重新取得 Aura owner，说明让用户切回来点击确认会打断测试。证据：[本次预检取消](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/short-reply-cancelled-preflight.json>)；**不能据此倒推旧r3任务的原因**。
3. 第二次 job `46e613b4-a06e-41e2-bc54-73afbc5528fa` 同样于3.964s/preflight被 `ownership-socket-close` 取消，未进入TTS：[第二次原始观测](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/short-reply-observed.json>)。用户随后澄清：**“没报错，就是回答了你好，但是没有声音”**。因此“结束”只指文字回复，不是音画完成或明确报错；不要继续追查不存在的播放器报错。只读子代理也确认 InstancePane 的 `[sessionId,retry]` 依赖稳定、running→false 仅触发 speak，不会主动关闭seat；原生会话切换会卸载未keepMounted的pane，此处不更改正常ownership规则。不能单靠socket-close倒推每次具体操作。
4. **第三次已实际消耗唯一一次 TTS 授权，但仍未播到回答**：用户明确测试会话 `session-20ed031e-8e8e-4d38-9925-f0a83dfd1206`；job `4bf83491-5e7a-4d8a-8e45-d2fc34493c93` 在10:06:48.220开始，6.782s进入TTS、7.270s加载模型、15.291s开始rendering；当前女声PCM实长0.88s。21.426s在rendering被 `ownership-socket-close` 取消，未ready/answer clip/playing/ended。用户反馈“没有听到声音，画面还是待机画面”与准备阶段一致，不是已生成成片播放无声的证据。[第三次实际观测](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/short-reply-observed-final.json>)。socket-close不能确定具体操作，不责怪用户；正确离开撤销规则不放宽。取消目录已清理，无可复用reply.wav；**不得自动再TTS/重渲染，须另获明确授权**。
5. 上述可见性/安全诊断最小修复已以0.35.4-visual.3完成回归、源码UX审查、冻结验证、完整快照及正式部署；修复本身没有让render更快。其后新增单次授权的“你好。”已完成真实AV与人耳极短句验收，详见顶部当前状态，不覆盖这里的三次历史失败。
6. 原只读监听器两轮均已exit0并收集，无后台监听或推理仍在运行：[本地监听器](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/playback-fix-20261124/watch-audio-test.mjs>)。后续有新授权才跟踪 ready→unmuted playing→不同帧→ended及人耳声音；不再要求中途切回lead确认“已发送”。录屏继续暂缓。

## r3 历史 Current state / Verified by（非当前部署）

- 根目录已实施：[客户端](</Users/vinson/Projects/github/vinson1101/dsh-aura/client.js>)、[Host 路由](</Users/vinson/Projects/github/vinson1101/dsh-aura/index.js>)、[可取消本地后端](</Users/vinson/Projects/github/vinson1101/dsh-aura/visual-response.js>)、[固定参数 wrapper](</Users/vinson/Projects/github/vinson1101/dsh-aura/tools/latentsync-response.py>)。非 character / 连续 chat 沿用普通 TTS；未整合历史局部嘴片实验。
- [任务摘要](</Users/vinson/Projects/github/vinson1101/dsh-aura/task-speech.js>)携带实际 native `taskIds[]`，仅一个 child 时才设 `taskId`。客户端按归属清理全部匹配 pending，晚 receipt 不复活，未完成的其他任务不被清空。
- 接口：`POST /aura/visual`（完整 text/voice/model/taskId/sessionId）→202；`GET/DELETE /aura/visual?id=UUID`。须 DSH 浏览器鉴权和当前 `x-aura-instance`；媒体 URL 为当前实例可撤销 capability，支持 HEAD/Range，不暴露任意磁盘路径。
- 后端先校验本机代码、模型、底片；再完整缓冲当前 PCM，执行本地 LatentSync，仅映射生成视频和当前 WAV，检查音视频时长/帧数并 ffmpeg 全解码后才 ready。记录 reply/PCM/source/wrapper/engine/media hash、stage、elapsed 和实际扩散进度。缓存身份含实际 extra/DeepCache 与 python 补丁源码；不缓存旧 task 身份。
- 原生 TTL 为**结束后** 30 分钟，排除活动 render；进程超时 90 分钟。取消等真正 close 才释放 render 容量。缓存最多四项是单 activation 的内存索引上限，旧磁盘 cache 可跨 activation 留存，不宣称重启后磁盘也只有四项。
- 本机真实 preflight 已通过（约5.19秒）：读取实际模型/底片/代码 hash，import-only MPS 与版本探测成功；在 TTS 边界主动以 expected sentinel 停止，**零真实 TTS、零推理**。[预检证据](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/latentsync-single-20261123/preflight-check-20261123.json>)的 `outcome.state=failed` 是该刻意阻断，不是生成失败或 ready 产物。
- **最终全量21组测试命令 exit0**：character 11/11、single-visual 16/16、新增设置 readiness 11/11，另含 Host/instance/TTS/backend、synthetic 单句/连续十轮、任务语音、barge/dispatch-race/密钥扫描。[最新回归日志](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/latentsync-single-20261123/deployment-regression.log>) SHA256 `14f6a3193d61088643088c314256a0dd95e4f1526c29b0b132ae5dc7b26eeaa1`；既有 React 样式 warning 未修。新增 [配置路由](</Users/vinson/Projects/github/vinson1101/dsh-aura/visual-settings.js>) 通过正式 Config Editor 保留 ASR/TTS 与其他原始配置，处理 owner 撤销/中止；前端分离“显示数字人”和后端实际状态，保存重启前关闭 WS 也不伪报成功，要求手动重开。
- 当前仍 main/92d0d39，源码版本 **0.35.4-visual.1**；旧脏变更保留，无提交/推送。不是 clean committed release：从冻结字节构造明确的本机测试制品，没在脏树运行 build/pack/install。完整冻结输入、base/delta、ws8.23.0 与 MIT license、转换脚本和逐文件 hash 都在 [r3 制品记录](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.1-r3/artifact.json>)；旧候选和 r2 保留但已停用。r3 将原 index 字节完整保存在同目录 host-runtime，index 作为本机 wrapper，保留原 export 入口名以兼容 DSH 的链接迁移路由；没有往旧源码放 forwarder，没有改 DSH。
- r3 source digest `812501302c35284b611fc8e36086097ed3d2f1962833c0e0e2bae4b6eaf4ebe3`；artifact digest `a73d4d860d7c6a31e2f4e91e23afe587e9a7480b4d70d124feaafed18fffed73`（54文件）。[只读验证](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/latentsync-single-20261123/artifact-verification-r3.json>)确认全树/冻结输入、原 Host 字节保持、隔离 ws、完整生产 import graph、wrapper 显式 false 优先/拒绝非法对象/保留 ASR-TTS。安装后复核 hash 未变。[制品实际 Host fixture](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/latentsync-single-20261123/artifact-host-smoke-r3-final.log>)确认真实 wrapper/apply 的 GET config 返回 enabled=true/正确版本，及资源鉴权/Range/owner/无效请求门禁；没发送合法生成 POST，隔离 DSH_HOME，不污染真实启动证据。fixture 无 Config Editor，所以 editable=false 不代表实际 Host 不可编辑。
- **当前实际状态：r3 正式管理器安装与启用 application:applied，可在原 GUI 操作测试。** Host 在 `2026-11-24 00:27:25 Asia/Shanghai` 记录 `visual_backend/0.35.4-visual.1/enabled:true`，当前 Client 随后 `apply/registered`（tabs/body/title/open 全 true），Inspect 确认会话头 Aura 按钮已 active。Host 仍 PID38467、原 GUI `http://127.0.0.1:56195`，没有重启 App、启动替代服务器或新推理。Inspect Config 的 absent 指无 Config schema，不是此前的 inactive。激活/注册不等于视频已实际渲染或真麦通过。最新 [部署账本](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.1-r3/deployment.json>)保存实际证据、配置、依赖、缺失验收及回滚。
- 部署事故已解决：首次覆盖被 manager 按 already-installed 拒绝；按其指示 remove→install r2，pnpm 成功但激活报旧 root/local-entry.js ENOENT。查明 Node 不刷新软链接 realpath，DSH router 只在 native resolve 成功后 relocate，因此新入口名先失败。r3 保留旧根存在的 index.js 入口，native 路径解析后由现有 router 转向新根再执行；remove r2 applied→install r3 applied。初次 r3 fixture 有测试副本 manifest 相对 URL 错误，修正副本后通过，未改制品。具体错误与操作日志保存在账本。

## 当前测试与复现（不是发布流程）

保留已安装依赖，用 bundled Node 直接执行 [manifest](</Users/vinson/Projects/github/vinson1101/dsh-aura/package.json>) 中的完整 test script，避免 package manager 自动安装：

```bash
export PATH=/Users/vinson/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH
node --input-type=module -e "import {spawn} from 'node:child_process';import {readFileSync} from 'node:fs';const s=JSON.parse(readFileSync('package.json','utf8')).scripts.test;const p=spawn('bash',['-c',s],{stdio:'inherit'});p.on('exit',c=>process.exit(c??1));"
node --check client.js && node --check index.js && node --check visual-response.js
git diff --check
```

这些是 jsdom/合成音频/假时钟/假模型边界测试；其中真实 ffmpeg 合成色块 mux/完整解码只验证媒体管线，不证明新嘴型。连续十轮也是 synthetic，不能冒充 Mac 真麦验收。已有 React border/borderColor warning 保留。

## r3 历史验收计划（当前以顶部修复下一步为准）

1. **部署门禁已通过，不再重装或修改功能源码；下一步是用户操作验收。** 正式 bundle 不存在兼容豁免，DSH0.2.2-rc.5 满足 `>=0.2.2-rc.3 <0.3.0-0`。门禁时磁盘40%已用、528GiB可用，阈值85%。当前 GUI 已收到新版注册；若面板保留旧态，关闭后重开 Aura，必要时仅刷新原页面，不启动另一服务器。
2. 正常源码后端仍默认关闭；**r3 本机测试 wrapper 明确默认 enabled=true 并锁定既有环境路径**，原 profile 仍仅 ASR/TTS，无 visualResponse，未手改 profile。合法显式持久配置（包括 enabled=false）优先；不把本机 wrapper 当通用发布默认。详见 [本机入口](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.1-r3/package/index.js>) 与 [本机默认配置](</Users/vinson/Projects/local/aura-releases/0.35.4-visual.1-r3/package/local-visual-config.json>)。原 GUI→会话头 Aura 圆环按钮→设置：确认 Host `0.35.4-visual.1`/本地回复生成已启用（不代表环境检测成功），勾选“显示数字人”，明确选择女声“龙颜”或“龙婉”及 CosyVoice3.0 Flash（界面3.0）。不要开启连续通话。若变更后端开关会重启 Aura，须手动重开；不要静默替换男声/3.5。
3. 只跑一次新的有实际内容的只读任务，当前女声约15–25秒，记录 native task/session、完整回复、PCM/模型配置/成片hash、状态、总等待和 playing/ended。同轮注入/真实输入必须区分；300秒假时钟测试不能称真实墙钟等待。缺模型/取消也须 staged 复核。
4. 在现有 GUI 刷新后验收宽/窄窗、循环接缝、侧转/手势/背景切换。已知十秒循环接缝、倾听叉腰与讲话放手、背景/过渡重影风险仍保留，不把 fixture 或历史22秒样例当本次回复。录屏须等用户恢复要求，保留真实等待；剪掉等待必须披露。

## 当前 rollback / 证据边界

- 开工脏基线：[hash 清单](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/latentsync-single-20261123/baseline.json>)、[原脏 diff](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/latentsync-single-20261123/preexisting.diff>)以及同目录 baseline 副本。源码回退须按这些副本逐文件比对，只撤销本轮增量；**不能 `git reset --hard` / `git clean` 吞掉旧素材与任务证据**。这不是干净发布包，不能只 git pull 跨机器复现。
- 管理器操作前已保存最新57M、含 sessions 的 [快照记录](</Users/vinson/.dsh/backups/20261123-234858-aura-before-v3-testable-20261123/manifest.txt>)。本次管理器已更新 profile 的包链接与 bundle 选择；ASR/TTS patch 原值未变。**快照不含 linked 源码，不能单独还原旧代码；重新 link 当前脏根目录也不是回到旧实现。**
- 紧急停用：正式 `plugin_manager set_bundle target=dsh-aura enabled=false`，仅停 Aura，原生独立任务保留自身生命周期。激活恢复后也可只在 Aura 设置禁用本地回复生成，保存后手动重开。
- 若需要完整 profile 回滚，先说明全 profile/sessions 恢复影响，再执行以下命令（尚未执行）；旧源码按上面的 baseline 单独重建再正式安装，不能 reset/clean。

```bash
~/.local/bin/dsh-snapshot restore 20261123-234858-aura-before-v3-testable-20261123 --yes
```

- 未启动替代 GUI/专用浏览器，未启动录制或新推理，未停止5090服务。后端默认禁用时不会因普通 `/aura/tts` 隐式触发渲染。
- 曾误触 `pnpm test` 的自动依赖安装，已取消并恢复原 jsdom/react/react-dom/ws 目录；lockfile 未变。后续直接跑上方 Node 命令，不重试 package-manager 安装。

---

## 历史记录（2026-11-20；以下局部嘴片方案已被当前v3取代）

## 当时 Goal / 验收边界

用户已授权只做单句 talk 的最基本【说话】，暂停转身、待机、互动、连续 chat。**已在隔离 Aura 跑出两条不同真实新任务的可辨认局部嘴动，不再是闭口配音；自然拟真与音素精同步未通过认证。** 下方 2026-11-19 记录为历史，不得据其“未开发”状态覆盖本节。

## Decisions made / Constraints / Ruled out

- 唯一头肩/背景为认可正面 PNG，不动整脸或全帧。155×79 局部嘴片仅从已有认可样片抽取闭/开/展/圆；本地 Foundation 拼音映射，未新增模型、付费服务或素材生成。
- 单句显示数字人时请求同一次 Aura TTS 的字符 timestamp 与精确 PCM，完整缓冲后由原 WebAudio graph clock 排程；原 voice/model 不变。只有约80ms字符时间，b/p/m 55ms闭口为启发式，不是音素测量。
- 未标注字间区间保留前词法目标、无字归属；精确同次 PCM 的10ms窗、≤−46dBFS、连续≥140ms只用于保守闭口，不选择开/展/圆。不等分字符、不猜 sentence reset offsets；坏对齐、未验证多 sentence-index 明确拒绝。
- 禁止用旧整段回答视频配新声音、振幅选嘴形、机械拉伸、整脸模型、重新换模型测速。chat 的原流式链路不改；保留已有脏基线、素材和失败证据，无提交推送部署。

## Current state / Verified by

- 两条实际最终回复：`宝宝把泡泡吹大了，妈妈说我们慢慢来。`（合成麦克风→真实ASR→任务）；`爸爸把白马牵回家了，妈妈说宝宝别怕。`（Aura输入框→真实任务，非ASR）。[泡泡产物](</Users/vinson/Projects/github/vinson1101/dsh-aura/泡泡.txt>) / [大马产物](</Users/vinson/Projects/github/vinson1101/dsh-aura/大马验收.txt>)已独立读回，与最终播报一致。
- [任务2原速近景](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/evidence/task-2/task-2-mouth-original-speed.mp4>) / [任务3原速近景](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/evidence/task-3/task-3-mouth-original-speed.mp4>)：实际原生标签页AV捕获裁切，原声未替换、未变速、未插帧；完整原始录制保留。两条原声4.64s/3.76s；客户端TTS完整缓冲等待939.9ms/853.2ms，另约100ms排程，不等于任务总耗时。任务2 ASR final→最终TTS response 18.186s；任务3提交时点未单独打点。
- 原始录像音轨对精确TTS PCM的互相关峰值0.99775/0.98103；录制PCM原点比graph-clock估计晚119.44/70.125ms。只证明同源与链路差，未认证精准lip-sync，未retime掩盖。
- 137个原生帧审查：开/圆/闭可辨，任务3含展；v1把所有gap当静音的频繁复位明显改善，停顿/末尾实际闭口可见。仍有声母启闭式短回落、软齿/厚唇线/局部质感差；不宣称无抽动、无重影或无halo。约15fps实采，55ms声母闭口不能逐次由视频证实；target变化日志不是每帧像素，平滑也非瞬时收敛。
- `npm --prefix .aura-local-preview/local-mouth-v1/runtime test` exit0，含原chat连续十轮；`node --test .../alignment/*.test.mjs .../material/tests/*.test.mjs` **54/54**，0fail；语法检查及`git diff --check`通过。既有React border/borderColor warning保留。[完整隔离回归](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/regression-v2.log>) / [最终54项](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/final-alignment-material.tap>)。
- 真实git仍main/92d0d39；根生产运行时10文件哈希与开工基线一致，认可底片/样片/6381产物哈希不变。实际改动只在隔离副本、任务产物及本交接/索引；原56195及原profile配置未改。

## Next steps / Watch out

1. 本轮基本说话收口，不自动恢复转身、待机、互动或chat；不把此结果发布为自然拟真数字人。专用浏览器与62498测试实例均已停止并核验端口释放；原56195仍在监听，不动它。
2. 用户复看两段原速录像后若再授权提升自然度，再处理局部素材分辨率/过渡及输出时钟差；当前没有宿主/ASR/TTS授权硬阻碍，不重启Ditto/LivePortrait等整脸测速。
3. 实验全部位于被忽略的本地隔离目录，尚未打包或git提交；**不能仅git pull跨机器复现**。需要迁移时另行审查打包，不把本机目录当已部署包。

## Pointers

- [当前证据总说明、文本、秒点、等待与限制](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/evidence/README.md>)；[对齐真实数据审查](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/alignment/real-task-review.md>)。
- 当前规范实现：[隔离客户端](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/runtime/client.js>)、[同次TTS适配](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/runtime/aligned-tts.js>)、[planner](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/alignment/viseme-plan.mjs>)、[仅闭口gate](</Users/vinson/Projects/github/vinson1101/dsh-aura/.aura-local-preview/local-mouth-v1/alignment/pcm-silence.mjs>)。旧生成fragment/patch脚本不是规范代码，不应盲目重跑覆盖runtime。
- runtime的assets/locale是指向根项目的symlink，**不得通过其写素材**。实验本地外部素材没有纳入插件发布文件表，属于刻意不部署。
- 任务2原捕获1280×900、任务3为2560×1800；裁切必须按每段真实编码尺寸而不是固定DPR2。首次任务2派生裁切错误已修，原始视频未动。raw报告预期文件名缺项/任务1失败超时均保留，由独立核验补证，不改写成功故事。

---

## 历史记录（2026-11-19；以下不是当前状态）

## Goal / 当前验收结论

只做单句 talk：在真实 Aura 点麦、识别一条新任务、真实完成、用本次实际回复声音驱动认可人物讲话，最后回侧身；连续 chat 不改。**尚未达标：当前 respond.mp4 是闭口头肩动作，不是讲话，用户明确否决。单测通过不等于视觉验收通过。** 不可用旧回答视频或旧声音冒充本次回答，不可机械拉伸脸部。

## Current state

- 已实现：双层首帧预载、侧身→转身→倾听/等待→回应→回程；实际 PCM 时钟/能量驱动闭口回应片段起停，120ms 静音后物理 pause；会话/代次/隐藏/取消隔离。此回应只算中间验证，不是嘴部驱动。
- 已验证真实任务：[回应验收.txt](</Users/vinson/Projects/github/vinson1101/dsh-aura/回应验收.txt>) 内容 `6381`；实际结果播报文本为“文件已保存。六、三、八、一。”，不是预录语音。输入是 Tingting 合成 WAV 经 Chromium fake microphone 的原生 getUserMedia→真实 ASR，不是人类现场讲话。
- 最佳新录屏（57.109 秒、有声、未剪辑转码；**嘴部未通过**）：[MP4](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/aura-single-live.mp4>)；[原始 WebM](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/aura-single-live.webm>)；[原始报告](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/report.json>)。
- 最近真实验证：`node --check client.js && node --check index.js && npm test && git diff --check` exit 0；24 项 character 测试、6 素材鉴权/Range/打包、连续十轮回归通过。仍有已有 React border/borderColor 警告。[测试日志](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/test-results.txt>)。
- 实测只在获准的隔离原生 DSH `http://127.0.0.1:62498`；原桌面 `56195` 与原 profile 未修改。保留先前脏基线；未提交、推送或部署。

## 本地嘴部驱动：已实测，两条现成链路均不够快

不能因为 bundled Python 缺 torch 就说本机没有驱动。现有[Python 环境](</private/tmp/aura-peach-lab/py312/bin/python>)具备 torch 2.8.0、cv2 4.10.0、onnxruntime 1.32.0、MPS；完整 LivePortrait 与 Ditto/HuBERT 权重都存在，已真正运行：

- Ditto CPU：真实音频→HuBERT→motion→完整渲染，1 秒音频 25 帧，run **38.697 秒 / 0.646fps**；首帧距 run 4.564 秒；含初始化总墙钟 41.942 秒。成功生成可辨认嘴部动作，但远慢于实时。[原始性能](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/local-mouth-benchmark/ditto/metrics.json>)。
- LivePortrait 完整五权重 MPS+CPU fallback：缓存源特征，1 预热+3 计时帧，平均 **656.96ms/帧 / 1.522fps**。明确警告 `aten::grid_sampler_3d` 不支持 MPS、回退 CPU。该测试只有神经 lip-ratio 图像渲染，没有音频输入；不能冒称完整 PCM 嘴型。[性能及警告原文](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/local-mouth-benchmark/liveportrait-mps/metrics.json>)。

25fps 预算为40ms/帧。结论仅限这两条当前配置，不是证明整台 Mac 或其他实现绝不可能实时。未下载、安装或付费调用新模型，未继续无限调参。测速声音来自本次真实结果录像的 1 秒片段，不是流式 PCM 接入，不是新全流程验收。按用户允许的退路，保留最佳未达标录屏并交付具体限制；**真正嘴部驱动尚未接入生产播放器，没有修复后重录成功录像。**

完整[证据说明与索引](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/README.md>)、[单次原生派发/创建/读回事件](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/native-task-excerpt.json>)、[明确 passed:false 的核验](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/verification.json>)已封存。

## Constraints / Ruled out

- 不下载或付费调用新素材/模型，不改 profile、连续通话，不提交推送。只用现有素材和本地能力。
- 禁止把 respond 闭口点头、只改标签或只跑视觉单测当作讲话；禁止固定旧回答片段配任意新声音。
- 不复用 `/private/tmp/aura-peach-lab/ditto-trial/short_approved_trial.py` 的旧视频驱动或 optical-flow/remap 机械变形。
- 当前没有宿主/ASR/TTS/授权阻碍；缺口是嘴部驱动尚未接入，已测两条完整渲染路径不够快。不可包装成授权问题。
- 用户最新指示：停止 Ditto、LivePortrait 和其他实时整脸/整帧推理测速；不换模型、不花费、不生成新视频。测试进程已结束，专用浏览器与隔离预览已停止，原 GUI 不受影响。

## 最新只读可行性结论

- **已有音频时钟，没有现成发音对齐。** [客户端排程](</Users/vinson/Projects/github/vinson1101/dsh-aura/client.js#L1927-L1934>)有 PCM 缓冲段 start/end、采样率、会话/代次，可复用作展示时钟；不是字/音素/viseme 时间戳。[TTS 解析](</Users/vinson/Projects/github/vinson1101/dsh-aura/tts.js#L219-L248>)只提取音频，未请求或保留发音标注；[宿主](</Users/vinson/Projects/github/vinson1101/dsh-aura/index.js#L534-L559>)只向浏览器发 audio/L16。不能据此断言供应商没有该能力，只能说当前链路没有可直接复用的标注。
- **样片已定位，但足够嘴形尚未证实。** [认可回答样片](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/previews/短发直播测试/首尾衔接预演/回答样片统一棚景.mp4>)确为[预演 answer 按钮引用](</Users/vinson/Projects/github/vinson1101/dsh-aura/assets/previews/Aura素材与通话预演.html#L15-L25>)。素材目录里未找到这条样片的现成嘴形标签、逐帧头姿/配准、遮罩或发音对齐表；历史通话时间记录只是事件级时间。此次没有新做抽帧或覆盖率盘点，不能宣称‘嘴形已经够用’，也不能反过来断言样片本身一定不够。
- 结论：**素材复用可作为待核查路线，当前尚不具备直接实现的已验证前提。** 闭口/双唇、展唇、圆唇等类别的实际覆盖、与身体底片每帧角度/光照的一致性、可平滑过渡的相邻姿态均未证实；仅交叉淡化不能保证无双唇重影。音量只能用于静音门控，不能充当嘴形选择器。

## Next steps（未经再次要求不得自动开发）

1. 本轮收口；保留未达标录屏与真实任务证据，不继续测速或生成视频。
2. 后续只先离线盘点认可样片的嘴形覆盖、头姿/光照匹配与局部稳定性，并核实可用的本次语音发音/时间对齐来源。二者未明确前不接运行时，不用幅度开合、随机嘴片或机械拉伸填空。
3. 满足素材和对齐前提后再讨论：本次语音选择/平滑局部嘴形、身体独立连续。当前未开发。

---

以下保留原设计约束；其中连续通话和长待机互动均为后续计划，**本轮没有接入**。

## 一个面板，两种结束条件

沿用「显示数字人」、底部麦克风和电话按钮。数字人播放器只订阅本面板所属会话的输入、任务和声音事件。Aura 继续负责收音、派单、播报、回声过滤和取消。所有预制动作静音，唯一的通话声音来自 Aura。

| 事件 | 单句任务（talk） | 连续通话（chat） |
|---|---|---|
| 打开面板 | 显示侧身半身定妆照 | 拨号前同左 |
| 点麦或拨号 | 立即收一句，同时从侧身回看镜头 | 立即开启连续采集；首次接通只转身一次，可选短招呼，用户先开口就让位 |
| 用户正在说话 | 保持注视，适度前倾或轻点一次头 | 相同；静默时减少动作，麦克风开放本身不代表有人讲话 |
| 收到有效终稿 | 向当前 DSH 会话提交一次并结束本次采集；等待时保持安静 | 提交本轮，同时继续监听，追问沿用当前正面姿态 |
| 简答或后台结果可播 | 跟随本会话实际播出的回复；长任务受理后可回到侧身休息，结果到达再唤起播报 | 跟随当前可播回复，后台摘要按 Aura 现有归属、过期与去重规则排队 |
| 说完 | 自然收口，回到侧身，等待用户再次点麦 | 自然收口，回到正面倾听 |
| 停止、打断或挂断 | 无声、识别失败或取消时回到待机；重新点麦以最新输入为准 | 已确认的非回声插话立刻停旧音、弃旧口型，回倾听。挂断释放本次音画资源并回侧身；已派发任务继续按原生命周期执行 |

## 画面的接法

- 在 InstancePane 现有数字人图的位置增加可释放的播放器，粒子模式沿用原入口。两个播放层交替预载，下一段首帧可显示才撤掉上一帧。视频资源复用现有宿主鉴权，按素材白名单提供，将实际用到的片段列入插件发布文件清单。测试网页和完整演示片仅供对照。
- 初始与归位共用[原始侧身定妆照](../../assets/characters/短发人物定妆/半身定妆-脸型妆容与短发.png)。侧身→正面用「拨号回看」；反向过渡第一版可用现有已校正回程。正面→倾听→等回复尽量保持当前播放位置。等待段可保持同姿态的呼吸与眼神，避免每个事件都从头点一次头。背景、脸的显示尺度、眼线及领口位置在统一画幅下对齐。
- 待机采用“一动一静”或“一动两静”。沿用预演参数作为起点：长待机约 35–65 秒才有一次插播机会，挥手至少间隔两分钟。手动互动可选挥手、被逗开心、俏皮探镜头，播一次回到**当时有效**的通话状态。新输入、开始播报、打断或挂断优先；互动不抢实际对话。波动较大的全身挥手优先用于全身画幅。窗口不可见、切换粒子或离开会话时清除定时器。
- 套用[现有筛选素材](../../assets/previews/短发直播测试/首尾衔接预演/)；Wan 的露齿笑仍是用途待定的备选。H3 逗笑保留表演参考，偏圆脸型不得用作下一轮人物基准。

## 讲话同步与降级

客户端已有 talk/chat、submitText、流式 PCM 排程、stopSpeaking 和 speakGeneration。将语音片段的计划起止时间、PCM、会话标识和播报代次同时交给画面层。音频播放时钟为准：setTalking(true) 早于首批 PCM 到达，仅凭它开口会抢先。自然收尾按最后一个已播音频区间收口；现有队列的完成宽限时间可以继续用于判断整轮结束。句内静音自然闭口，下一块到达再继续。

早期第一阶段仅接入真实单句流程，用稳定正面陪伴画面配 Aura 原声；用户已明确这不算讲话验收。旧的第二阶段整帧模型候选已被最新收口要求取代，不再试新模型或推理测速。当前只核查认可样片的局部嘴形复用与实际回复对齐是否具备前提，不能直接启用运行时拼贴。任何既有固定讲话样片只能作素材与表现参考，不可用旧声音/旧整段回答冒充本次回复。

已确认打断时，复用 stopSpeaking 的代次失效机制。取消该代次待播动作和口型，后续异步返回须核对会话与代次。视觉过渡不能拖住停声或下一轮收音。切换模式、关闭面板和切换会话遵守同样的清理边界。

## 在真实 DSH 窗口验收

1. 单句先测两次：一次临时提问，一次可核查的单句任务（例如在任务专用临时目录生成一份三项清单）。录下点麦、收句、关闭采集、受理、真实结果返回与播报；检查清单实际生成一次、播报一次，结束回侧身。另测无输入以及任务执行期间切换面板。
2. 单句通过后测连续通话。录一段 30–45 秒原速屏幕与声音，包含接通、说话、停顿、回答中打断、追问、再回答、挂断。对齐实际首音/首个口型、停声/收口时间；检查上一轮画面不会回来、挂断后已受理任务仍能结束。
3. 人物验收以原定妆照为准。同角度按眼距对齐，检查面颊宽度、下颌收束、眼鼻唇比例、刘海发尾、肤色和下巴到领口的相对距离。重点抽查开头第 1–2 秒、动作峰值、返回静止以及不同素材切点；原速看是否显胖、拉长脖子、泛白或跳背景。任一明显偏差即退回最近认可的定格或片段。
4. 窄窗、宽窗各检查一次。保留电话、麦克风、输入区与粒子切换。记录真实回复首音与视觉准备耗时，比较开关数字人前后的通话响应。结果以宿主实测为准。

实现位置：[面板与播放排程](../../client.js)、[受保护的素材路由](../../index.js)、[任务结果去重](../../task-speech.js)、[打包文件](../../package.json)。
