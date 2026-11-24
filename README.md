# Aura for DeepSeek Harness

A voice companion beside the real conversation. The right sidebar handles
listening and speech; the middle column remains the conversation and work history.
The particle orb is a replaceable form, not Aura itself.

## Conversation, speech and work have separate owners

- **Simple questions:** the foreground answers directly.
- **Actual work:** the foreground dispatches an independent native managed worker
  with the full request, context and authorization. It returns immediately, rather
  than waiting for the task. Progress uses native agent messages; completion is
  delivered back to the parent conversation. Aura speaks the parent's final short
  text summary once, only in the currently owned parent pane after an explicit
  submission there. Busy foreground/user audio takes priority. Silence, interruption,
  hangup or closing the pane discards pending task audio; a new explicit submission
  enables future summaries again. Results remain in native conversation history;
  reopening does not replay missed/old summaries or open the microphone.
- **Natural interruption:** differing recognized speech silences obsolete playback;
  the final transcript replaces only the foreground turn. Already-dispatched work
  continues. There are no interruption keywords.
- **Echo protection:** opening the microphone does not mute Aura. Recognized echoes
  of its recent speech are ignored; real partial speech stops playback. PCM frames
  are delivered once, including audio captured while recognition opens.
- **Explicit task cancellation:** ask Aura to interrupt the named worker. This stops
  that worker's current execution, not its independent descendants or all queued
  work. Muting, hanging up, and switching out of Aura mode do not cancel tasks.

Foreground execution is enforced by an agent-scoped native tool guard, not just
prompt instructions. Native agent status and messaging tools remain available;
workers retain the original capable preset. The inherited tool catalog stays
stable, but disallowed foreground execution is rejected. No global prompt is added
and ordinary sessions are unaffected.

## One Aura per runtime

The Host grants one live Aura instance across all sessions and windows. It binds
one foreground conversation; additional panes show an existing-instance notice
and cannot open another microphone or voice player. There is no automatic takeover.
Close the original pane, then explicitly reopen/retry in the other window.

Closing or losing the instance releases microphone, recognition and playback,
not dispatched workers. Host audio routes require the current instance token;
closed, timed-out and restarted connections cannot reuse old audio authority.
Calls and pending playback are live state, **not saved preferences**: after a
restart, refresh or remount the call button resets, with no automatic microphone
activation or replay. Voice/model/avatar preferences still persist.

## Using Aura

Open the **Aura** right-sidebar tab from the session header button. Type in its
composer, click the microphone, or start a call. Enter sends; Shift+Enter adds a
newline. Replies appear in the middle column and can be spoken sentence by sentence.

The first submission enables Aura foreground mode **for that session**, including
subsequent messages typed in the middle column. Native session commands:

| Command | Effect |
| --- | --- |
| `/aura on` | Enable foreground mode. Refuses to convert an ordinary session already doing work. Use an idle or new session instead. |
| `/aura off` | Restore ordinary execution in this session; workers continue. |
| `/aura interrupt` | Cancel and drain only the foreground turn, preserving queued input. |

Use `/aura off` in the middle-column command input before returning to ordinary
in-session execution. Sending through the Aura sidebar enables the mode again.
Mode is restored from successful native command records after session resume or
plugin reload. The orb reflects foreground/session activity; an idle foreground
can still have independently running workers. Ask for task status or use the
native agent view.

Microphone, speech and errors remain in the sidebar. **Silence** stops speech only.
No task-tree cancellation is implied by any voice control.

## Install

Requires DeepSeek Harness `>=0.2.2-rc.3 <0.3.0-0`, the Web UI, microphone permission,
and a Bailian/DashScope provider key for voice. In **Plugins → Add plugin**, select
this repository's local directory. Updates use the same bundle installation flow.
Refresh the existing GUI after the updated bundle is applied.

## Credentials

The provider key stays on the host, is never sent to the browser, and resolves per
request in this order:

1. Plugin configuration `asr.apiKey`.
2. DSH credential record `dsh-aura/asr`.
3. `DASHSCOPE_API_KEY` or `XOB_BAILIAN_API_KEY` in the environment.
4. `$DSH_HOME/aura-secrets.env`.

Keep credentials local and out of source control. A rotated key applies to the next
utterance without a restart. See [providers](docs/PROVIDERS.md) and
[voices](docs/VOICES.md) for provider choices.

## Development and verification

```sh
npm install
npm test
# Optional native Cordis contract test against the running Desktop installation:
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/runtime.cjs
```

The default suite includes local ffmpeg/ffprobe fixture checks and currently expects
`/opt/homebrew/bin/ffmpeg` and `/opt/homebrew/bin/ffprobe` on this Mac. It does not
run TTS, download models or perform inference. Merely running `npm install` on
another platform is not enough to reproduce those fixture checks unchanged.

The regression suite covers recognition lifecycle, fallback, PCM delivery, echo,
barge-in, speech, sidebar submission, task dispatch contracts and repeated classic-
script loading in the same page (including an upgrade from the legacy global
version declaration). Client state belongs inside the module factory, not global
lexical declarations. Module replacement belongs to the Host; Aura does not poll
for updates and automatically refresh the whole application. The optional
native test checks real Cordis registrations, tool schemas, scoped guards and
worker-scope isolation without changing the profile or using a model.

These tests do not substitute for a live microphone/speaker check or an actual
model-dispatched worker surviving an interruption. Verify those in the existing
GUI after installation. A native worker runs independently only after dispatch is
accepted; cancellation before publication can still reject dispatch.

Diagnostics from the browser post stage beacons to `/aura/diag`, stored on the host
in `$DSH_HOME/aura-diag.jsonl`. They help distinguish an unmounted sidebar from a
client crash. Do not log provider credentials.

## Forms and accessibility

The current form is a canvas particle sphere with no WebGL. Forms can be replaced
without changing conversation, voice or task ownership. Reduced-motion mode draws
without continuous animation; hidden tabs pause painting, and unmount cleans up
listeners, animation frames and microphone resources.

## Credits and license

Orb geometry and palette derive from **Zebra**, a private project by the same
author. Slot and bundle conventions follow DSH's installed plugin documentation.
[MIT](LICENSE).

## Local digital-human test

The static prototype described first is historical; the current single-task v3
behavior and short-answer acceptance are documented in the next subsection.

Open the Aura profile and enable **显示数字人** to show the approved short-haired,
front-facing half-body still. It retains the original aspect ratio and full image:
no square face atlas, cover enlargement, stretched body, animated mouth or autoplay.
The image's subject-free background colours extend across the whole plugin-owned
pane, behind its title chip, call control and composer. The Host-owned tab strip
is not restyled. Disabling the option restores the particle canvas and theme.
This is a visual layer only; call, microphone, speech and task ownership are unchanged.

The fixed `/aura/character/short-hair.png` route serves only the approved PNG,
using Connection's normal Host/Origin and browser authentication checks. No arbitrary
filesystem path or external URL is accepted. The local self-contained visual preview
is [aura-short-hair-panel-local.html](assets/previews/aura-short-hair-panel-local.html);
rebuild it with `node tools/build-static-portrait-preview.mjs`. It reuses current pane
styles, but is **not a screenshot or running DSH**: its call/mic/send controls are
inert previews, its particle is a placeholder, and it has no audio/API access.
A real GUI refresh, visual review and microphone/speaker acceptance remain separate.

Legacy peach WebP assets and `tools/render-peach.py` remain for the earlier local
experiment, but are not used by this static mode. Their generation used external
[LivePortrait](https://github.com/KlingAIResearch/LivePortrait/tree/9b294b3d0536135442ea73cb01e6cb3ca7029dd3)
model weights; no weights are bundled. A future narrow-layout full-body variant
should use user-provided full-body artwork, not crop or synthesize this half-body still.

### Single-task v3: short-answer playback accepted, not realtime

The static-mode description above and the [rejected closed-mouth recording](<assets/runtime/short-hair/inspection/live-acceptance/closed-mouth-rejected/README.md>)
are historical, not the v3 answer path. The current single-task character uses one
video element: the approved quiet ten-second frontal loop continues unchanged
through idle, listening, thinking and preparation. Its loop seam is visible; it
is not an indefinitely seamless generated take. Only **300 seconds of inactivity**
permits a return sideways; active capture, tasks, preparation and playback block
that timer. Clicking the microphone while sideways starts capture immediately and
lets the full existing turn-to-front finish independently. A completed answer
returns to frontal, not sideways. Continuous calls retain their original path.

The opt-in local [visual backend](<visual-response.js>) buffers this task's complete
current female TTS, drives the approved Wan base through the existing LatentSync
MPS environment, then muxes and fully decodes/validates the complete AV file before
publishing a scoped media URL. The browser uses that video's `playing`/`ended`
events, never separate PCM scheduling or an old response movie. Cancellation
invalidates polling, media capabilities and owned subprocesses. It does not cancel
independent native tasks merely because their playback was stopped.

Normal source rendering is **disabled by default**. The isolated local test
artifact `0.35.4-visual.3-r1` explicitly enables it on this machine; persisted
configuration, including `enabled: false`, always overrides those local defaults.
The current GUI's Aura settings report the actual Host version/enabled state and
can save the backend toggle; reopen Aura manually after saving. This is separate
from the **显示数字人** display checkbox. For a normal installation, Host plugin config
`visualResponse: { enabled: true }` opts in to this machine's existing local paths;
other machines must configure their installed `envDir`, `repoDir`, `vaeDir`,
`python`, `ffmpeg`, `ffprobe` and `workDir`. No model downloads are performed.
Choose an explicit supported female system voice and `cosyvoice-v3-flash` in Aura;
there is no automatic voice substitution. Replies over 240 characters or 25 seconds
are rejected rather than silently truncated. Only one render may run at a time.
The retained settings are CFG 1.5, seed 1247, 20 steps, DeepCache 3/branch 0.
The prior verified 21.84-second sample took about 54 minutes; this is **not realtime**
and is not timing evidence for a new reply.

The `0.35.4-visual.2` repair addresses Desktop's `dsh-app:` MP4 demux failure:
authenticated fetch supplies a bounded, complete MP4 Blob to the same video element.
Its URL/reader/timers are revoked on cancellation; HTTP browsers retain direct media
loading. A failed turn now rejects its queued answer instead of hanging. Transient
status GET failures retry the same job up to three times, never re-POSTing or
regenerating TTS. Autoplay denial retains the current AV and offers a separate
click-to-play overlay; hiding the page cannot turn an interrupted play promise into
a spurious failure. Cancellation records its first cause/stage without loosening
ownership or the heartbeat timeout.

For the visual.2 playback repair, all 21 regression commands passed (character 19/19, single-visual 18/18, settings
readiness 11/11, plus backend, native attribution, authentication, ASR/TTS and
synthetic call coverage). See the [repair regression log](<.aura-local-preview/playback-fix-20261124/regression-all-final.log>).
The frozen repair artifact passed full-tree/dependency/import/wrapper checks both
before and after installation. DSH manager applied the repair at the existing GUI;
the active package link and unchanged ASR/TTS/non-Aura profile configuration were
verified. The real Desktop Client fetched 1,357,805 bytes and decoded the frontal
MP4 (720×914, 10 seconds, media error 0). After the user foregrounded Aura,
real playing/frame beacons confirmed visible, unpaused playback and increasing
presented frames across a full 10-second loop. The user confirmed that the person
moves. This verifies the frontal playback repair, **not audible reply acceptance**.
The historical short reply was cancelled before ready; its original cause remains
unproven, so do not describe it as an autoplay failure.

The visual.3 update makes preparation prominent in the main stage, with Chinese
stage labels, actual elapsed time/step counts, and an explicit warning that text
completion is not AV completion, generation may take minutes or longer, and leaving
the conversation cancels it. Ready-to-play and buffering are not described as
speaking. Safe cleanup/socket-close diagnostics distinguish lifecycle events without
recording tokens or weakening ownership, heartbeat, or native-task independence.
This visibility update does **not** accelerate rendering; playback acceptance
requires a separate real-answer test, not the DOM/media test doubles.

An earlier authorized greeting generated 0.88 seconds of female speech, then was
cancelled at 21.426 seconds during rendering with `ownership-socket-close`, before
ready/playback. The exact close action is not established. That attempt remains
historical evidence, not a successful playback.

On 2026-11-24, one newly authorized current-answer test of “你好。” completed:
`longyan_v3` / `cosyvoice-v3-flash`, cache miss, ready at 175.192 seconds, followed
by real nonmuted Desktop playback with advancing frames and normal `ended` cleanup.
The user confirmed “听到了，但是很快就结束了”. Its 0.88-second audio and 0.96-second
video explain the short playback; this was not an early cancellation. This accepts
only that extreme short answer, **not realtime, longer answers or continuous calls**.
All 21 offline regression commands also passed before Git synchronization.
The additional one-test authorization is consumed; any further actual TTS/inference
requires renewed explicit permission. Recording remains deferred; no replacement
server was started. Detailed machine traces stay local under the gitignored
`.aura-local-preview/`; they are not uploaded with the source.
The running artifact remains a separately frozen local deployment, not a registry
release. See the current
[handoff, test steps and rollback](<docs/handoff/Aura数字人-单句与连续通话接入方案.md>).
