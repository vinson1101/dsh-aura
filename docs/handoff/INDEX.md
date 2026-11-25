# Handoff 索引

同一任务只维护同一文档；写前检查文档 `Owner:`，非本人须先取得明确交接。

| 任务 | Updated（Asia/Shanghai） | Owner | 当前状态 / 下一步 |
| --- | --- | --- | --- |
| [Aura 数字人单句接入](<./Aura数字人-单句与连续通话接入方案.md>) | 2026-11-24 | lead | **修复、极短句验收及源码同步完成**：0.35.4-visual.3维持原56195 GUI部署；“你好。”175.192s ready、音频0.88s/视频0.96s，真实非静音播放至ended且用户确认听到。21组离线回归全过；40文件已推送main，提交2811390，本地/远端HEAD一致。319项本地草稿/参考材料/验收文本未上传；默认ffmpeg测试路径尚不跨机。本次交接补记两文档未提交。等待用户下一指令，录屏暂缓，任何新TTS/推理先重获授权；不宣称实时、长句或连续通话通过。 |
| [Aura 前台、语音与独立任务](</Users/vinson/Projects/github/vinson1101/dsh-aura/docs/handoff/aura-native-workers.md>) | 2026-11-18 12:13 | lead（agent-5 已交还） | 0.35.3 Host 已部署；16 项离线回归 + native runtime 通过；未吞并旧脏基线、未提交。待刷新当前页核版及真麦十轮/同 child 任务存活验收。 |
