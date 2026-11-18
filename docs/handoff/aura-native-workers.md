# Hand-off: Aura 前台、语音与独立任务

Updated: 2026-11-18 12:13 Asia/Shanghai   Branch: main   Last commit: d704f11
Owner: lead（agent-5 经明确委托完成本轮修复并交还；上一写入者 agent-4）

## Goal
让语音播放、前台、独立 native worker 生命周期互不误伤；插话完整识别一次、立即停止旧播放，已接受任务不因没听到回执被取消或重派，任务完成摘要只播一次。0.35.3 自动回归已通过，Done 仍需用户在 Mac 真麦克风/扬声器十轮验收。

## Decisions made
- 实际工作经 `aura_task` / `startActivation` 派发即返回，只有明确取消才 `aura_interrupt_task`；scoped guard 不影响 worker。dispatch 前 reserve childId，原生 claimed/settled 与父 turn 精确关联，最终摘要走 owner WS + 既有优先级/去重队列，不直接念通知。
- Host 单 owner 通过 claim/token/heartbeat/expiry/release，ASR/TTS 校验归属。非 owner 不挂真实 Pane；不得自动抢占。
- 0.35.3 回声参考只在 PCM 已调度且 AudioContext 时钟进入播放区间才生效；取消即清，播放自然结束最多留 180ms 尾窗。不再在 TTS fetch 前累积跨轮文本，也不再用句尾六字相同否决整个新句。
- PCM 无逐词时间戳，参考粒度仍是当前播放的合成句，不声称精确到已发声的单字，也不能靠文本分辨用户与扬声器同时说完全相同的句子。浏览器 AEC 保留，真实播放-only 对照待测。
- ASR 每轮换 socket/VAD，不重建 MediaStream/AudioContext/worklet。final 等待、前台提交等待和下一轮真实 listen-start 之前都接 raw Float32；endpoint 块未消费尾样本交给下一轮。取消 400ms 关麦重开及仅留 12 个原始帧的旧路径。
- 按实际 sampleRate 缓冲最多 8 秒、原序 drain 一次；超限明确报错停采集而非丢头提交。8 秒是安全预算，不是实测握手延迟。当前 wire 固定 16kHz：若浏览器不满足请求则显式报错，不混用采样率。
- 没听到派发回执不代表未接单：前台先查同任务/child ID，不据此重新派发。本轮未改变 native worker 资源归属。

## Constraints to keep
- captureEpoch、pendingCapture、speakGeneration、owner access 与 `audio.resume()` 撤权 fencing 不可绕过；静音/挂断/owner loss 清旧待播，不补播、不自动开麦。
- 不恢复自动整页刷新，不开替代 server，不改 ASAR；classic factory 内声明版本常量，防 lexical redeclare。
- Aura 仍无跨工作区控制：`aura_task` 固定 parent cwd，不能借历史 ID 绕过授权。
- 本轮获得复现/修复/回归及可归属提交授权；不要沿用上一轮“仅文档”限制。动 profile 必须预告并成功保存含 sessions 的快照。本轮无付费 ASR/TTS/真实模型任务探测、无 push。

## Ruled out
- 等 worker 后再结束前台、完成时全局 arm、直接朗读原生通知：耦合生命周期、错归属/双播。
- 把 suffix 相同当完整回声；把 TTS 请求文本或旧轮全句作为当前播放证据。
- 简单延长 400ms、加固定 12 帧缓存：AudioWorklet 原始帧不是 100ms wire block，不能保证保留句头。
- 凭两个窗口可见断言双开麦：用户已明确没有同时开麦，不扩大排查。

## Current state
- Done / source：package、lock、Client 均 0.35.3；HEAD 仍 `d704f11406b0e233c0d290bfb182a6f58ea331a4`（0.35.0）。开始时已有 9 个 tracked 脏文件及 task-speech 等未跟踪实现；本轮未吞并或提交这些旧改动。
- Verified / offline：本轮最终 `npm test` 全部 16 个执行项通过，含 38 个 raw320 帧在 readiness 前保留、十轮同一 worklet/一次 getUserMedia/零中途 track.stop 的 jsdom 集成；播放时钟/旧轮/后缀/取消/尾窗/队列边界测试通过。没有把它算作 Mac 真人十轮。
- Verified / native contract：`ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/runtime.cjs` 在安装 DSH 0.2.2-rc.3 上通过（真实 Cordis 注册、schema、scoped guard/cleanup），但 startActivation 仍是 stub，不是实际模型任务验收。新增 dispatch race 只在离线 seam 模拟 acceptance 前、acceptance 后/回执前、回执后三种边界：同 child、dispatch=1、completion=1、无 worker interrupt/dispose。
- Verified / packaging：上述测试后 `git diff --check`、`npm pack --dry-run` 整条 exit 0，包为 0.35.3；只有既有 React border/borderColor warning 未处理。
- Verified / Host：先保存 [含 sessions 快照](</Users/vinson/.dsh/backups/20261118-121027-aura-0.35.3-barge-in/sessions.tar.gz>)（31,751,072 bytes），再仅对精确 `include:dsh-aura` disable/enable，均 `application: applied`、warnings 空。[既有 GUI 版本接口](<http://127.0.0.1:52147/aura/version>) 返回 0.35.3；未重启 DSH/取消 worker。
- Unverified / 当前用户页：诊断文件第 1995–1999 行在受控 reload **之前**已有 0.35.3 factory/apply/registered；来源未核实，不能据此认定 reload 后当前用户页已更新。reload 后未见新 beacon。Client Inspect 曾超时；无 dev:web watcher，不承诺自动刷新。用户需刷新现有页看标题 0.35.3。
- 本轮未 commit：单纯拆 index hunks 不足，0.35.3 当前测试基于未提交 0.35.2 owner/task-speech 等前置实现，尚未把“仅本轮改动 + HEAD”完整树独立测试，不能提交未经验证的混合树。保留独立 attributed patch，不 stage 旧改动，后续由 lead/用户处理旧基线提交顺序。

## Next steps
1. 用户刷新既有 `http://127.0.0.1:52147`，确认 Aura 0.35.3，点击“开始通话”；先让它数到十，在 3–4 时插话“停一下，记住这是第 N 次”，看首字完整、旧声停止、只提交一次，累计十轮。
2. 真麦/扬声器补测上一轮相同词句污染、单纯播放不说话对照；语音活动到停声延迟尚无真人测量，不能报“立即”的毫秒验收值。
3. 派一个无副作用、稍后完成的任务：分别在已接单但回执未播完、已听完回执后插话，核对同 child ID、不重派、worker 最终只完成一次，摘要只播一次。纯 before-acceptance 允许取消启动但不得谎报已派发。
4. 把真人结果更新此文档；失败先结合 text-free trace 找 ready/样本/echo/stop 边界，不扩大权限。决定旧脏基线处理顺序后，再完整树验证并 commit。

## Watch out for
- `window.__auraVoiceTrace` 为内存 ring，最多 160 行，不持久化、不含 PCM/转录文本。记录 `play_span`、`echo_decision`（partial/echo/字符数）、`asr_ready`（waitMs/degraded）、`buffer_flush`（rate/next/delivered/dropped/held/maxMs）、`turn_handoff`（sampleSeq/frames）、`capture_stop`（reason）。`next`/`delivered` 为入队样本统计，`sampleSeq` 是采集 graph 全局样本计数；不是模型 token 或真实声学 onset。
- 180ms 尾窗可能仍遇真实物理回响/同句冲突；没有 ASR/TTS 词对齐或原生 acoustic AEC 证据，保留真人待验收。
- 已在更新前运行的 worker 未登记 task-speech；关闭期间错过的摘要不补播，文字仍留原生 session。
- 本地未提交文档不会随跨机器 git pull 出现；下一写入者先确认 Owner。

## Pointers
- [client.js](</Users/vinson/Projects/github/vinson1101/dsh-aura/client.js>)：playback reference、sample queue、voiceTrace、连续 capture handoff；[tasks.js](</Users/vinson/Projects/github/vinson1101/dsh-aura/tasks.js>)：前台 guard、reserve/dispatch、回执未播不重派。
- [mic tests](</Users/vinson/Projects/github/vinson1101/dsh-aura/test/mic.test.mjs>)、[barge tests](</Users/vinson/Projects/github/vinson1101/dsh-aura/test/barge.test.mjs>)、[dispatch race](</Users/vinson/Projects/github/vinson1101/dsh-aura/test/dispatch-race.test.mjs>)、[reply tests](</Users/vinson/Projects/github/vinson1101/dsh-aura/test/reply.test.mjs>)、[runtime test](</Users/vinson/Projects/github/vinson1101/dsh-aura/test/runtime.cjs>)。
- 保留 [task-speech.js](</Users/vinson/Projects/github/vinson1101/dsh-aura/task-speech.js>) 和 [instance.js](</Users/vinson/Projects/github/vinson1101/dsh-aura/instance.js>) 原有去重/归属逻辑。本轮 attribution 基线保存在 `/tmp/aura-agent5-baseline/`；初始完整 tracked diff 为 `/tmp/aura-agent5-baseline.patch`。
- 上一轮实现证据：worker session `efae8f74-ff4d-4fd4-aefb-3a78130264a7` seq 773/775/797（测试/pack）、810/815/821（0.35.2 重载）；root session `session-d3e4e83b-fa16-4717-b675-ecbc330dc965` seq 3591（用户确认没有同时开麦）。
