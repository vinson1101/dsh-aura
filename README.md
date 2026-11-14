# dsh-aura

A presence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
something that lives beside the conversation and shows what the agent is doing,
and that you will eventually talk to.

**A form is what you see; the orb is only the first one.** Today's form is a
canvas particle sphere — 1900 points on a golden-angle sphere, no WebGL, no 3D
library, no image assets, no network. It breathes at rest and turns faster while
a session runs; its colour follows the session phase. A Live2D model, a digital
human or a plain status pill can take its place without touching the state or
the slot wiring.

> **Status: v0.5 — docked, and it drives the session.** The orb lives in a
> right-sidebar tab, reads real session state, and the pane carries a composer
> that sends into the session shown in the middle column and can cancel its run.
> Microphone capture and speech come next; see [Roadmap](#roadmap).

![The orb](icon.svg)

## What works today

| Phase | Trigger | Colour | Motion |
| --- | --- | --- | --- |
| `idle` | no session running | blue | slow turn, 2 Hz breathing |
| `running` | any session has `running: true` | violet | fast turn, 6 Hz breathing |
| `waiting` | a session has a pending user interaction | coral | slow turn |
| `done` | a run settled less than 3.5 s ago | green | slow turn |

- Hovering grows the orb; the canvas repaints at device-pixel density (capped at 2×).
- `prefers-reduced-motion: reduce` draws a single frame instead of animating, and
  still repaints when the phase changes.
- A hidden tab stops the animation loop; coming back resumes it.
- Unmounting disposes the animation frame, the `ResizeObserver` and both listeners.

## Install

Not on the plugin market yet. From a checkout of this repository:

```sh
dsh plugin add /path/to/dsh-aura
```

Then reload the Web UI. A small sphere button appears in the session header;
clicking it docks the **Aura** tab in the right sidebar, where it stays while you
work. The tab is also listed in the right bar's own picker.

## Roadmap

- [x] **v0.1 — orb.** Canvas sphere, session-phase colours, lifecycle disposal.
- [x] **v0.2 — docked.** Register a right-sidebar tab type, open it from a header
      button, and keep it resident beside the conversation.
- [x] **v0.3 — drive.** A composer that sends into the current session
      (`prompt`, queue mode) and a stop control (`cancel`).
- [x] **v0.3 — ears.** Microphone capture, energy endpointing, speech-to-text,
      and the transcript placed in the composer.
- [ ] **v0.4 — voice.** Spoken replies with streaming TTS, sentence by sentence.
- [ ] **v0.4a — streaming ears.** Cut the 800 ms wait by streaming PCM to a
      realtime provider; the endpointing contract stays the same.
- [ ] **v0.5 — interruption.** Speaking while the agent runs cancels the turn
      (`ISession.cancel()`) and steers the new request in (`mode: 'steer'`).
- [ ] **v0.6 — face.** Expressions and gestures driven by the phase and by the
      streamed thinking chain.
- [ ] **v0.7 — other forms.** Live2D, a digital human, and a text pill as
      alternative forms of the same presence, selectable per workspace.
- [ ] **v0.8 — character packs.** A directory format for one character: identity
      (name, portrait), expression and motion set, voice sample or voice id, and
      the persona prompt that goes with it. The form loads a pack; swapping a
      character means pointing at another pack, not editing code.

Two rules carried over from the reference desktop client, because they are what
makes an assistant trustworthy rather than merely decorative:

1. **Muting stops playback; only cancel aborts the run.** They are different actions.
2. **A finished tool step is not a finished task.** The orb stays `running` until
   the turn actually settles.

## Development

```sh
npm install
npm test        # mounts the pane in jsdom and fails on anything the browser would hit
```

The test exists because a static render is not enough: `renderToStaticMarkup`
never runs effects, and the first real bug in this plugin — a forms registry that
held a function where the pane called `.mount` — threw inside `useEffect`. A
static render passed while the pane rendered nothing in the app.

### Diagnostics

The pane posts four stage beacons (`factory`, `apply`, `registered`,
`mounted`, plus `crash`) to a host route that appends them to
`$DSH_HOME/aura-diag.jsonl`. A slot entry that never mounts looks exactly like a
plugin that is not installed, and the renderer console cannot be read from outside
the app, so this file is the only way to tell those two apart. The host half needs
a DSH restart to serve the route; the browser half is picked up on reload.

## Credentials

The provider key is never committed and never reaches the browser. It resolves
per request, so a rotated key applies to the next utterance without a restart:

1. the plugin row's `asr.apiKey` (a literal, for a throwaway profile)
2. the DSH credential record `dsh-aura/asr`
3. the environment (`DASHSCOPE_API_KEY`, or the bridge's `XOB_BAILIAN_API_KEY`)
4. `$DSH_HOME/aura-secrets.env`, the `.env` convention the Zebra bridge uses

The file is the recommended place for a machine-local key:

```sh
install -m 600 /dev/null "$HOME/.dsh/aura-secrets.env"
printf 'DASHSCOPE_API_KEY=...\n' >> "$HOME/.dsh/aura-secrets.env"
```

`test/secrets.test.mjs` also scans this repository for key-shaped strings and
fails the suite if one appears.

## Design notes

The presence paints into `shell.overlay`, the frame-wide layer that is
click-through by default; the orb opts back into pointer events so it never
blocks the app.

A form is `mount(canvas, readPhase) -> { refresh, dispose }`. `client.js` keeps
them in one `FORMS` map, so a new form is one entry plus its own renderer — the
phase machine, the selectors and the slot registration stay put.

Phase comes from the slot's `useSessionStatus` selector hook over
`ReadonlyMap<SessionId, SessionStatus>`. Selectors return primitives — an object
would change identity on every snapshot and re-render on unrelated sessions.

## Credits

- Orb geometry, palette and motion are derived from the **Zebra** desktop
  assistant, a private project by the same author.
- Slot, locale and manifest conventions follow the DeepSeek Harness plugin docs.

## License

[MIT](LICENSE)
