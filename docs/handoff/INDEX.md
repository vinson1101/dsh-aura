# Handoff 索引

同一任务只维护同一文档；写前检查文档 `Owner:`，非本人须先取得明确交接。

| 任务 | Updated（Asia/Shanghai） | Owner | 当前状态 / 下一步 |
| --- | --- | --- | --- |
| [Aura 数字人单句接入](</Users/vinson/Projects/github/vinson1101/dsh-aura/docs/handoff/Aura数字人-单句与连续通话接入方案.md>) | 2026-11-24 | lead | **本轮修复与极短句验收完成**：0.35.4-visual.3在原56195 GUI运行，运动此前已确认；新增单次“你好。”job 223a8350 于175.192s ready，真实当前回答非静音出帧→正常ended，用户确认“听到了，但是很快就结束了”。音频0.88s/视频0.96s解释正常短播。21组全过（character19、single24、readiness11），冻结安装前后验证、完整快照与配置保留已证实。追加授权已耗尽，监听exit0，无重试/录屏/追加生成；后续真实生成先新授权。不是实时/长句/连续通话或卡片真实布局验收；证据及剩余边界见主文档。 |
| [Aura 前台、语音与独立任务](</Users/vinson/Projects/github/vinson1101/dsh-aura/docs/handoff/aura-native-workers.md>) | 2026-11-18 12:13 | lead（agent-5 已交还） | 0.35.3 Host 已部署；16 项离线回归 + native runtime 通过；未吞并旧脏基线、未提交。待刷新当前页核版及真麦十轮/同 child 任务存活验收。 |
