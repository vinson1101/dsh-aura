# dsh-aura

A living particle orb for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One canvas, 1900 points on a golden-angle sphere, no WebGL, no 3D library, no
image assets, no network. The orb breathes at rest and turns faster while a
session runs. Its colour follows the session phase.

> **Status: v0.1 — rendering only.** The orb is alive and reads real session
> state, but it does not speak or drive anything yet. Voice, session control and
> interruption come next; see [Roadmap](#roadmap).

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

Then reload the Web UI. The orb appears at the right edge, above the composer.

## Roadmap

- [x] **v0.1 — orb.** Canvas sphere, session-phase colours, lifecycle disposal.
- [ ] **v0.2 — wiring.** Read the *current* session instead of every session, and
      expand the orb into a right panel on click.
- [ ] **v0.3 — ears.** Microphone capture with local VAD, speech-to-text, and a
      message sent into the current session.
- [ ] **v0.4 — voice.** Spoken replies with streaming TTS, sentence by sentence.
- [ ] **v0.5 — interruption.** Speaking while the agent runs cancels the turn
      (`ISession.cancel()`) and steers the new request in (`mode: 'steer'`).
- [ ] **v0.6 — face.** Expressions and gestures driven by the phase and by the
      streamed thinking chain.

Two rules carried over from the reference desktop client, because they are what
makes an assistant trustworthy rather than merely decorative:

1. **Muting stops playback; only cancel aborts the run.** They are different actions.
2. **A finished tool step is not a finished task.** The orb stays `running` until
   the turn actually settles.

## Design notes

The orb paints into `shell.overlay`, the frame-wide layer that is click-through by
default; the orb opts back into pointer events so it never blocks the app.

Phase comes from the slot's `useSessionStatus` selector hook over
`ReadonlyMap<SessionId, SessionStatus>`. Selectors return primitives — an object
would change identity on every snapshot and re-render on unrelated sessions.

## Credits

- Orb geometry, palette and motion are derived from the **Zebra** desktop
  assistant, a private project by the same author.
- Slot, locale and manifest conventions follow the DeepSeek Harness plugin docs.

## License

[MIT](LICENSE)
