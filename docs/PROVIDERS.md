# Providers this plugin uses

Taken from the Zebra stacks, not invented. The point of this file is that the
next person does not have to re-derive which model is the proven one:
`xiaozhi-openclaw-bridge` carries several providers, and only some are the ones
that actually ran.

## Speech to text — Paraformer realtime

| | |
| --- | --- |
| Provider | `bailian_paraformer_realtime` |
| Model | `paraformer-realtime-v2` |
| Transport | WebSocket `wss://dashscope.aliyuncs.com/api-ws/v1/inference` |
| Audio | raw PCM16, 16 kHz mono — no WAV or Ogg container |
| Endpointing | `max_sentence_silence: 800` |

Source: `src/xiaozhi_openclaw_bridge/asr.py` (`BailianParaformerRealtimeProvider`,
`_run_paraformer_realtime`) and `docs/PHASE7B_ASR_PROVIDER.md`, which records the
deployed selection:

```
XOB_ASR_PROVIDER=bailian_paraformer_realtime
XOB_BAILIAN_PARA_ASR_MODEL=paraformer-realtime-v2
```

**Not** `fun-asr-flash`. That provider exists in the bridge as the first
bring-up path and its own document says it is "not enabled by default".

Protocol shape, for review: `run-task` → `task-started` → binary PCM frames
(3200 bytes each) → `finish-task` → `result-generated` events until
`task-finished`. Sentences marked `sentence_end: true` concatenate into the
final transcript; a trailing partial sentence is the fallback when none is
marked.

## Text to speech — Bailian CosyVoice

| | |
| --- | --- |
| Provider | `bailian` |
| Model | `cosyvoice-v3-flash` |
| Voice | `longyan_v3` |
| Transport | `POST {base}/services/audio/tts/SpeechSynthesizer`, `X-DashScope-SSE: enable` |
| Output | PCM16 16 kHz mono, one base64 chunk per `output.audio.data` |

Source: `src/xiaozhi_openclaw_bridge/tts.py` (`BailianTtsProvider`,
`_post_bailian_sse`) and the run recorded in `docs/PHASE3_HERMES_LAN_CLI.md`:

```
XOB_TTS_PROVIDER=bailian
XOB_BAILIAN_TTS_MODEL=cosyvoice-v3-flash
XOB_BAILIAN_TTS_VOICE=longyan_v3
```

Note the code default for the voice is `longanyang`; the recorded run used
`longyan_v3`. When the voice is wired here, `longyan_v3` is the value to match
the proven run.

**Not** MiniMax. `docs/PHASE7C_TTS_PROVIDER.md` describes MiniMax as an opt-in
alternative; the sentence "keeps the already deployed MiniMax TTS" in the ASR
document is stale and misled a reader once already.

## Verified against the live service

Both providers are exercised against the real endpoints with the key in
`$DSH_HOME/aura-secrets.env`:

- `paraformer-realtime-v2`, from the Python implementation in
  `xiaozhi-openclaw-bridge` and from this plugin's Node driver, both return
  `你好，我是斑马，现在测试语音识别。` for the same synthesized clip.
- `POST /aura/asr` returns
  `{"text": "...", "provider": "bailian_paraformer_realtime"}` in about 950 ms
  for 3.4 s of audio, which includes the WebSocket round trip.

One earlier call failed with `FreeTierOnly` / "free quota has been exhausted"
while an identical call to the same model in the same minute succeeded, so that
message is treated as a transient provider state rather than an account limit.
Worth watching: the pane surfaces it verbatim, and a retry was deliberately not
added — retrying a real quota error would hide it.

