# Providers this plugin uses

Written after a sync from the Zebra / XiaoZhi side of the same voice work, and
after correcting two mistakes of mine: I once took a stale line in an ASR
document as the deployed TTS choice, and once took a source default as the model
that actually ran. The lesson both times is the same — a provider *name* and a
provider *default* are not evidence of what ran.

Three things are easy to conflate. Keep them apart:

| Path | Transport | What it is |
| --- | --- | --- |
| HTTP whole-utterance ASR | `POST /api/v1/services/aigc/multimodal-generation/generation` | The most recent Zebra Bridge runs used this, with `qwen-audio-3.1-asr-flash`. One complete WAV per request. |
| Paraformer realtime ASR | `wss://…/api-ws/v1/inference` | The older local-voice reuse / product candidate path, `paraformer-realtime-v2`. Duplex PCM. |
| CosyVoice HTTP SSE TTS | `POST /api/v1/services/audio/tts/SpeechSynthesizer` | Speech out, streamed as base64 chunks inside SSE events. |

## HTTP whole-utterance ASR

The **latest runs with log evidence** used `qwen-audio-3.1-asr-flash` through the
HTTP multimodal-generation endpoint. The provider *name* inside the bridge is
`bailian_fun_flash` and its logs are prefixed `fun-asr-flash`, but that prefix
does not mean the Fun-ASR model was called — the model came from
`XOB_BAILIAN_ASR_MODEL`. That naming is a trap worth remembering.

```
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
Authorization: Bearer <DASHSCOPE_API_KEY>
Content-Type: application/json
X-DashScope-SSE: disable
```

```json
{
  "model": "qwen-audio-3.1-asr-flash",
  "input": { "messages": [ { "role": "user", "content": [
    { "type": "input_audio", "input_audio": { "data": "data:audio/wav;base64,<complete WAV>" } } ] } ] },
  "parameters": { "format": "wav", "sample_rate": "16000" }
}
```

- Build one **complete WAV** before encoding; the bridge wraps its Opus frames
  into Ogg and sends `format: "ogg"`, this plugin sends PCM16 → WAV.
- Never label raw PCM or a bare Opus frame as WAV or Ogg.
- Read `output.text` or `output.sentence.text`; top-level `text` and
  `sentence.text` are also accepted.
- **An empty transcript is not an error and must not be submitted** to the agent.
- `sample_rate` is a string in `parameters`.

## Paraformer realtime ASR

`wss://dashscope.aliyuncs.com/api-ws/v1/inference`, model `paraformer-realtime-v2`:

`run-task` (UUID, `streaming: duplex`, payload `task_group: audio` / `task: asr` /
`function: recognition`, parameters `format: pcm`, `sample_rate: 16000`,
`input: {}` **sibling to `parameters`**) → wait for `task-started` → send PCM16LE
16 kHz mono in binary frames of 3200 bytes (100 ms) → `finish-task` with the same
UUID → collect `result-generated` sentence-final text until `task-finished`.
`task-failed` is an error.

Do not mix this with the HTTP path, and do not use the experimental `-message`
models.

## CosyVoice TTS

```
POST https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
Authorization: Bearer <DASHSCOPE_API_KEY>
Content-Type: application/json
X-DashScope-SSE: enable
```

Source defaults (not a claim about the deployed voice — check
`XOB_BAILIAN_TTS_MODEL`, `XOB_BAILIAN_TTS_VOICE`, `XOB_BAILIAN_TTS_SAMPLE_RATE`,
and optionally `instruction` against the authorized configuration):

```json
{ "model": "cosyvoice-v3-flash",
  "input": { "text": "收到。", "voice": "longanyang", "format": "wav", "sample_rate": 16000 } }
```

Reading the stream:

- Each SSE line is `data: <json>`; skip events with no audio.
- Base64-decode `output.audio.data` **in order** into one continuous stream.
- If the payload carries RIFF/WAVE, find the `data` chunk across chunks and strip
  the RIFF header **exactly once**. The result is continuous mono S16LE PCM.
- Never play each chunk as its own WAV, and never feed the WAV header to a PCM
  player.

`stream_audio()` yields PCM; `synthesize()` returns the concatenated PCM, not a
WAV — add a header yourself if you need a file.

The TTS provider is **not** MiniMax. Hermes may use a MiniMax model for its LLM;
that is unrelated to this voice path.

## What this plugin implements today

- HTTP whole-utterance ASR with `qwen-audio-3.1-asr-flash` — the default.
- Paraformer realtime ASR — implemented and switchable, kept because it removes
  the "wait until the utterance ends" latency once it is worth the extra moving
  parts.
- CosyVoice TTS — not implemented yet; the recipe above is what will be built,
  including the strip-the-header-once rule.

An empty transcript returns an empty string, is not an error, and is not placed
in the composer.
