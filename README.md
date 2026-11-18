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
