# Aura

Aura lives beside the real DeepSeek Harness conversation. The right sidebar
handles voice; the middle column remains your conversation and work history.
Its breathing particle orb is one replaceable visualization, not the product.

## Talk while work continues

Simple questions are answered directly. Actual work is dispatched to independent
native managed workers, which report progress and results to the foreground.
Speaking naturally stops obsolete playback and replaces only the foreground
answer; already-dispatched tasks keep running. No interruption keywords are needed.

The microphone stays open during playback. Echo-only recognition is ignored, while
differing speech stops playback. Muting or hanging up never cancels a worker.
To interrupt work, explicitly name the task. An interrupt stops that worker's
current execution, not all independent descendants or queued work.

## One runtime, one Aura

One Host-owned instance is shared across windows and sessions, bound to one
foreground conversation. Other panes show an existing-instance notice instead of
opening a second microphone or player. Close the original pane, then explicitly
reopen the other one; there is no automatic takeover. Cross-session work remains
independently managed.

Closing the pane or losing its connection releases voice resources, not workers.
Restarting resets the call button and pending playback; it never automatically
opens the microphone. Voice, model and avatar preferences are retained.

## Getting started

Open the **Aura** right-sidebar tab from the session header. Type, click the
microphone, or start a call. Enter sends; Shift+Enter inserts a newline. Replies
remain in the middle column and can be spoken as sentences arrive. Failures appear
inline instead of silently dropping input.

The first sidebar submission enables foreground mode for the session, including
middle-column input. Use `/aura off` in the middle-column command input to return
to ordinary in-session execution. Sidebar submission enables it again.
`/aura interrupt` stops only the foreground and preserves queued input. An ordinary
session already doing work cannot be converted until idle; use a new session if
needed. Successful mode changes survive resume and plugin reload.

The orb reports session/foreground activity, not aggregate task progress. An idle
foreground can have busy workers; ask for status or use the native agent view.
Reduced-motion mode avoids continuous animation, and hidden tabs pause painting.

## Requirements

DeepSeek Harness `>=0.2.2-rc.3 <0.3.0-0`, its Web UI, a current browser with microphone
permission, and a Bailian/DashScope key for voice. Credentials remain on the host;
no provider key reaches the browser. See the repository README for configuration
and verification limits.
