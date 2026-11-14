# Voices that actually work

Measured against the account's key with `model: cosyvoice-v3-flash` and
`/api/v1/services/audio/tts/SpeechSynthesizer`. Every id below returned audio;
the traits come from the provider's published voice list.

The `_v3` suffix matters: `longwan` is rejected with
`[cosyvoice:]Engine error [418]: Invalid voice` while `longwan_v3` works, and the
same id is not interchangeable across models (`cosyvoice-v2` accepts a different
set).

| 名称 | voice | 特质 | 备注 |
| --- | --- | --- | --- |
| 龙安洋 | `longanyang` | 阳光大男孩 | 基准音色，默认 |
| 龙颜 | `longyan_v3` | 温暖春风女 | |
| 龙小淳 | `longxiaochun_v3` | 知性积极女 | |
| 龙小夏 | `longxiaoxia_v3` | 沉稳权威女 | |
| 龙婉 | `longwan_v3` | 细腻柔声女 | |
| 龙悦 | `longyue_v3` | 温暖磁性女 | |
| 龙媛 | `longyuan_v3` | 温暖治愈女 | |
| 龙妙 | `longmiao_v3` | 抑扬顿挫女 | 有声书 |
| 龙华 | `longhua_v3` | 元气甜美女 | |
| 龙安燃 | `longanran_v3` | 活泼质感女 | 直播带货 |
| YUMI | `longyumi_v3` | 正经青年女 | |
| Bella | `loongbella_v3` | 精准干练女 | |
| 龙橙 | `longcheng_v3` | 智慧青年男 | |
| 龙泽 | `longze_v3` | 温暖元气男 | |
| 龙书 | `longshu_v3` | 沉稳青年男 | |
| 龙硕 | `longshuo_v3` | 博才干练男 | 新闻播报 |
| 龙寒 | `longhan_v3` | 温暖痴情男 | |
| 龙浩 | `longhao_v3` | 多情忧郁男 | |
| 龙飞 | `longfei_v3` | 热血磁性男 | 诗词朗诵 |
| 龙老铁 | `longlaotie_v3` | 东北直率男 | |
| 龙杰力豆 | `longjielidou_v3` | 阳光顽皮男 | 6~15 岁 |

Rejected with this account and model: `longwan`, `longcheng`, `longhua`,
`longshu`, `longshuo`, `longjing`, `longmiao`, `longyue`, `longyuan`, `longfei`,
`longjielidou`, `longtong`, `longxiang`, `longxiaochun`, `longxiaoxia`,
`longxiaocheng`, `longxiaobai`, `longxiaogang`, `longlaotie`, `longhan`,
`longanran`, `loongbella`, `louis`, `lucky`, `longze`, `longhao`, `longyumi`,
`longye`, `longting`.

## How to re-check

The list is per account and can change. Synthesise a few characters per id and
keep the ones that answer with 200 and an audio URL:

```bash
curl -s -X POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" -H 'Content-Type: application/json' \
  -H 'X-DashScope-SSE: disable' \
  -d '{"model":"cosyvoice-v3-flash","input":{"text":"你好。","voice":"longwan_v3","format":"wav","sample_rate":16000}}'
```

Note that `X-DashScope-SSE: disable` returns a `url` rather than inline base64,
and that parallel requests hit `Requests rate limit exceeded`, so probe one at a
time.
