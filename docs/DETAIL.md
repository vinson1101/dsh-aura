# Aura

A breathing particle sphere pinned to the right edge of the DeepSeek Harness Web
UI. It is pure canvas: 1900 points on a golden-angle sphere, six depth bands, a
radial glow, and a rotation you can read at a glance.

## What it does

The orb mirrors the session phase it reads from the Web UI:

- **Blue (`idle`)** — nothing is running. Slow turn, slow breathing.
- **Violet (`running`)** — at least one session is working. The sphere spins almost
  twice as fast and breathes three times as fast, so a glance tells you the agent
  is busy.
- **Coral (`waiting`)** — a session is blocked on you: a question or an approval.
- **Green (`done`)** — a run settled in the last 3.5 seconds, then it falls back to
  blue.

Hovering grows the orb. Dragging, clicking through, or occluding the UI is not
possible: the orb sits in the frame-wide overlay layer, which is click-through
except for the orb itself.

## Behaviour worth knowing

- **Reduced motion.** With `prefers-reduced-motion: reduce` the orb draws one frame
  and stops animating, but still repaints whenever the phase changes, so the colour
  stays truthful.
- **Hidden tab.** The animation loop stops while the page is hidden and resumes when
  it returns.
- **Disposal.** Unloading the plugin cancels the frame, disconnects the resize
  observer and removes both listeners, so nothing keeps painting a detached canvas.

## Not in this version

- The orb does not listen, speak, or send messages. It only reports state.
- It reflects **any** running session, not the one selected in the middle panel.
- There is no settings page; the layout is fixed.

## Requirements

DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0` on the Web UI. A browser with canvas 2D
and `ResizeObserver` — every current browser qualifies.
