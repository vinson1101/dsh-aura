/**
 * dsh-aura — browser half: a presence docked in the right sidebar.
 *
 * The presence owns the state — phase now, voice later — and a form only renders
 * it. Today there is one form, a canvas particle orb, and a form is just
 * `mount(canvas, readPhase) -> { refresh, dispose }`, so a Live2D model, a
 * digital human or a text pill drops in beside it without touching the state or
 * the tab wiring. The particle sphere is one form, not the product.
 *
 * The pane also carries a composer: what you type there is sent into the session
 * shown in the middle column, and the stop control cancels that session's run.
 *
 * Geometry and palette derive from the Zebra desktop assistant's orb.
 */
window.__ModuleLoader__.load({
  id: 'dsh-aura',
  factory(require) {
    diag('factory');
    const React = require('react');
    const h = React.createElement;

    /** Tab identity; `id` and `kind` are the same string on purpose. */
    const TAB_ID = 'dsh-aura';

    const VERSION = '0.9.1';

    /** Set once the tab type, body and title are all registered. */
    const registrations = { ready: false };

    /**
     * Stage beacons. A slot entry that never mounts is indistinguishable from a
     * plugin that is not installed, and the renderer console cannot be read
     * from outside the app, so each stage posts to the host's diagnostic route
     * and lands in $DSH_HOME/aura-diag.jsonl.
     */
    function diag(stage, extra) {
      try {
        fetch('/aura/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, v: VERSION, ...extra }),
        }).catch(() => {});
      } catch {
        /* diagnostics stay silent */
      }
    }

    /* Set by `apply`; the pane reads it to reach the live session. */
    let services = null;

    /* ---- form: particle orb -------------------------------------------- */

    const COUNT = 1900;

    /* Uniform sphere: latitude steps by equal area, longitude by the golden
     * angle. The shell thickness is pseudo-random but fixed, so one array
     * drives every frame. */
    const POINTS = (() => {
      const points = new Array(COUNT);
      for (let i = 0; i < COUNT; i += 1) {
        const y = 1 - (2 * (i + 0.5)) / COUNT;
        const angle = i * Math.PI * (3 - Math.sqrt(5));
        const ring = Math.sqrt(1 - y * y);
        const thickness = 0.76 + 0.24 * Math.pow(((i * 149) % 383) / 383, 0.6);
        points[i] = [
          Math.cos(angle) * ring * thickness,
          y * thickness,
          Math.sin(angle) * ring * thickness,
          i % 19,
        ];
      }
      return points;
    })();

    const TONE = {
      idle: '110,187,250',
      running: '151,151,255',
      waiting: '242,151,138',
      done: '97,222,194',
    };
    const SPIN = { idle: 0.22, running: 0.39, waiting: 0.26, done: 0.3 };

    /**
     * A form gets the canvas and the frame it sits in. The form owns its own
     * geometry: it squares the element from the frame's shorter side, so the
     * browser never stretches a square bitmap into a tall box — which is what
     * turned the sphere into an oval with pointed ends.
     *
     * The contract is `mount(canvas, readPhase) -> { refresh, dispose }`.
     */
    function mountOrb(canvas, readPhase) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return { refresh() {}, dispose() {} };
      const frameElement = canvas.parentElement || canvas;
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const MAX_SIZE = 720;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      let pending;
      let elapsed = 0;
      let previous = 0;
      let disposed = false;

      /** Square the element and match the backing store to it, in one place. */
      function fit() {
        const box = frameElement.getBoundingClientRect();
        const size = Math.max(1, Math.round(Math.min(box.width, box.height, MAX_SIZE)));
        const pixels = Math.max(1, Math.round(size * ratio));
        const css = size + 'px';
        if (canvas.style.width !== css) {
          canvas.style.width = css;
          canvas.style.height = css;
        }
        if (canvas.width !== pixels) {
          canvas.width = pixels;
          canvas.height = pixels;
        }
        return pixels;
      }

      function draw(now) {
        pending = undefined;
        if (disposed) return;
        const quiet = motion.matches;
        if (previous && !quiet) elapsed += Math.min(50, now - previous);
        previous = now;

        const size = canvas.width;
        if (!size) return;

        const phase = readPhase() || 'idle';
        const tone = TONE[phase] || TONE.idle;
        const fast = phase === 'running';
        const t = elapsed / 1000;
        const angle = t * (SPIN[phase] || SPIN.idle);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const mid = size / 2;
        const radius = size * (0.36 + 0.008 * Math.sin(t * (fast ? 6 : 2)));

        ctx.clearRect(0, 0, size, size);
        const glow = ctx.createRadialGradient(mid, mid, 0, mid, mid, radius * 1.2);
        glow.addColorStop(0, `rgba(${tone},.21)`);
        glow.addColorStop(0.68, `rgba(${tone},.06)`);
        glow.addColorStop(1, `rgba(${tone},0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, size, size);

        const groups = Array.from({ length: 6 }, () => []);
        for (const [x, y, z, seed] of POINTS) {
          const depth = z * cos - x * sin;
          const wave = 1 + 0.035 * Math.sin(10 * y + t * 2 + seed);
          const strength = (depth + 1) * 0.5;
          groups[Math.min(5, Math.floor(strength * 6))].push([
            mid + (x * cos + z * sin) * radius * wave,
            mid + y * radius * wave,
            Math.max(0.48, size * (0.0008 + 0.0014 * strength)),
          ]);
        }
        groups.forEach((group, index) => {
          ctx.fillStyle = `rgba(${tone},${0.16 + index * 0.13})`;
          ctx.beginPath();
          for (const [x, y, r] of group) {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, 2 * Math.PI);
          }
          ctx.fill();
        });

        if (!quiet && !document.hidden) pending = window.requestAnimationFrame(draw);
      }

      function refresh() {
        if (disposed) return;
        if (pending !== undefined) window.cancelAnimationFrame(pending);
        pending = undefined;
        previous = 0;
        fit();
        draw(window.performance.now());
      }

      const resize = new ResizeObserver(() => refresh());
      resize.observe(frameElement);
      motion.addEventListener('change', refresh);
      document.addEventListener('visibilitychange', refresh);
      refresh();

      return {
        refresh,
        dispose() {
          disposed = true;
          if (pending !== undefined) window.cancelAnimationFrame(pending);
          pending = undefined;
          resize.disconnect();
          motion.removeEventListener('change', refresh);
          document.removeEventListener('visibilitychange', refresh);
        },
      };
    }

    /* ---- forms ---------------------------------------------------------- */

    /**
     * Interchangeable renderers of the same presence. Each one is
     * `mount(canvas, readPhase) -> { refresh, dispose }`; adding a form never
     * touches the state above.
     */
    const FORMS = { orb: { mount: mountOrb } };
    const FORM = 'orb';

    /* ---- presence ------------------------------------------------------- */

    /** How long a settled run keeps the presence green. */
    const SETTLED_MS = 3500;

    /* Selectors run on every status snapshot, so they return primitives: an
     * object would change identity each time and re-render the pane. */
    function anyRunning(status) {
      if (!status || typeof status.values !== 'function') return false;
      for (const row of status.values()) if (row && row.running) return true;
      return false;
    }
    function anyWaiting(status) {
      if (!status || typeof status.values !== 'function') return false;
      for (const row of status.values()) if (row && row.pendingInteraction) return true;
      return false;
    }

    /** The live session behind this pane, or null when it is not retained. */
    function bindSession(sessionId) {
      if (!services || !sessionId) return null;
      const sessions = services.get('sessions');
      if (!sessions || typeof sessions.binding !== 'function') return null;
      const binding = sessions.binding(sessionId);
      return binding && binding.session ? binding.session : null;
    }

    /* ---- capture and endpointing ----------------------------------------
     *
     * The numbers come from the Zebra voice pipeline: the bridge ends a
     * sentence after 800 ms of silence (`max_sentence_silence`), the desktop
     * client keeps a short pre-roll so the first phoneme survives, and both cap
     * one utterance so a stuck microphone cannot grow without bound.
     */
    const SAMPLE_RATE = 16000;
    const FRAME_MS = 20;
    const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS) / 1000;
    const SILENCE_MS = 800;
    const PREROLL_MS = 250;
    const MIN_SPEECH_MS = 120;
    const MAX_UTTERANCE_MS = 20000;
    const ENERGY_THRESHOLD = 0.012;

    /** Frame an arbitrary float stream into 20 ms blocks and cut utterances. */
    function createVad(onUtterance) {
      const prerollLimit = Math.round(PREROLL_MS / FRAME_MS);
      let carry = new Float32Array(0);
      let ring = [];
      let frames = [];
      let taking = false;
      let silence = 0;

      function rms(block) {
        let sum = 0;
        for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
        return Math.sqrt(sum / block.length);
      }

      function toPcm() {
        const pcm = new Int16Array(frames.length * FRAME_SIZE);
        let offset = 0;
        for (const frame of frames) {
          for (let i = 0; i < frame.length; i += 1) {
            const value = Math.max(-1, Math.min(1, frame[i]));
            pcm[offset + i] = value < 0 ? value * 0x8000 : value * 0x7fff;
          }
          offset += FRAME_SIZE;
        }
        return pcm;
      }

      function finish() {
        if (!taking) return;
        taking = false;
        const spokenMs = frames.length * FRAME_MS;
        const pcm = toPcm();
        frames = [];
        silence = 0;
        if (spokenMs >= MIN_SPEECH_MS) onUtterance(pcm);
      }

      function take(block) {
        const loud = rms(block) >= ENERGY_THRESHOLD;
        if (!taking) {
          ring.push(block);
          if (ring.length > prerollLimit) ring.shift();
          if (!loud) return;
          taking = true;
          frames = ring.slice();
          ring = [];
          silence = 0;
          return;
        }
        frames.push(block);
        if (loud) {
          silence = 0;
        } else {
          silence += FRAME_MS;
          if (silence >= SILENCE_MS) finish();
        }
        if (taking && frames.length * FRAME_MS >= MAX_UTTERANCE_MS) finish();
      }

      return {
        push(samples) {
          let data = samples;
          if (carry.length) {
            const merged = new Float32Array(carry.length + data.length);
            merged.set(carry);
            merged.set(data, carry.length);
            data = merged;
          }
          let offset = 0;
          while (data.length - offset >= FRAME_SIZE) {
            take(data.subarray(offset, offset + FRAME_SIZE));
            offset += FRAME_SIZE;
          }
          carry = data.slice(offset);
        },
        flush: finish,
        reset() {
          taking = false;
          ring = [];
          frames = [];
          silence = 0;
        },
      };
    }

    /** The worklet only forwards input blocks; all decisions stay on this side. */
    const WORKLET_SOURCE = `class AuraCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('aura-capture', AuraCapture);`;

    /** btoa on a large buffer throws; convert in bounded slices. */
    function toBase64(bytes) {
      let binary = '';
      const chunk = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
      }
      return btoa(binary);
    }

    const PANE = {
      height: '100%',
      minHeight: 0,
      display: 'grid',
      gridTemplateRows: '1fr auto auto',
      gap: 10,
      padding: 16,
      boxSizing: 'border-box',
    };
    /* The stage only centres; the form squares the canvas inside it. */
    const STAGE = {
      width: '100%',
      height: '100%',
      minHeight: 160,
      display: 'grid',
      placeItems: 'center',
      overflow: 'hidden',
    };
    /* No size here: the form writes both CSS sides and the backing store. */
    const CANVAS = { display: 'block' };
    const CAPTION = {
      font: 'inherit',
      fontSize: 11,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      opacity: 0.55,
      color: 'var(--dsw-alias-text-secondary, inherit)',
      userSelect: 'none',
      maxWidth: '100%',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };

    const FOOTER = { display: 'grid', gap: 6 };
    const ROW = { display: 'flex', gap: 6, alignItems: 'flex-end' };
    /** The composer's tallest state before it scrolls instead of growing. */
    const MAX_DRAFT_HEIGHT = 132;
    const INPUT = {
      flex: 1,
      minHeight: 34,
      maxHeight: 132,
      resize: 'none',
      padding: '7px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-base, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      lineHeight: 1.4,
      boxSizing: 'border-box',
    };
    const BUTTON = {
      flex: '0 0 auto',
      width: 34,
      height: 34,
      display: 'grid',
      placeItems: 'center',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-base, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 14,
      cursor: 'pointer',
    };
    const ERROR = {
      fontSize: 11,
      color: 'var(--dsw-alias-text-danger, #e5484d)',
      wordBreak: 'break-word',
    };

    /**
     * A crash in a slot entry blanks that entry silently, so the pane owns a
     * boundary that renders the failure in place. Without one, a broken render
     * looks exactly like "the plugin is not there" — which is its own bug.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failure: null };
      }
      static getDerivedStateFromError(failure) {
        return { failure };
      }
      componentDidCatch(failure, info) {
        console.error('dsh-aura: pane crashed', failure, info);
        diag('crash', {
          message: String((failure && failure.message) || failure),
          stack: String((failure && failure.stack) || '').slice(0, 1200),
        });
      }
      render() {
        const failure = this.state.failure;
        if (!failure) return this.props.children;
        const text = (failure && (failure.stack || failure.message)) || String(failure);
        return h(
          'pre',
          {
            style: {
              margin: 0,
              padding: 12,
              minHeight: 120,
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--dsw-alias-text-danger, #e5484d)',
              overflow: 'auto',
            },
          },
          text,
        );
      }
    }

    /** The tab body: one presence plus a composer that drives this session. */
    function Pane(props) {
      const form = FORMS[FORM] || FORMS.orb;
      const useStatus = props.useSessionStatus || (() => undefined);
      const running = useStatus(anyRunning) === true;
      const waiting = useStatus(anyWaiting) === true;

      const wasRunning = React.useRef(false);
      const [settledAt, setSettledAt] = React.useState(0);
      const [settled, setSettled] = React.useState(false);

      React.useEffect(() => {
        if (wasRunning.current && !running) setSettledAt(Date.now() + SETTLED_MS);
        wasRunning.current = running;
      }, [running]);

      React.useEffect(() => {
        if (!settledAt) {
          setSettled(false);
          return undefined;
        }
        setSettled(true);
        const timer = window.setTimeout(() => {
          setSettledAt(0);
          setSettled(false);
        }, Math.max(0, settledAt - Date.now()));
        return () => window.clearTimeout(timer);
      }, [settledAt]);

      const phase = running ? 'running' : waiting ? 'waiting' : settled ? 'done' : 'idle';

      const canvasRef = React.useRef(null);
      const phaseRef = React.useRef(phase);
      phaseRef.current = phase;
      const formRef = React.useRef(null);

      React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const instance = form.mount(canvas, () => phaseRef.current);
        formRef.current = instance;
        window.requestAnimationFrame(() => {
          diag('mounted', {
            pxW: canvas.clientWidth,
            pxH: canvas.clientHeight,
            bufW: canvas.width,
            bufH: canvas.height,
            phase: phaseRef.current,
            parentH: canvas.parentElement ? canvas.parentElement.clientHeight : -1,
          });
        });
        return () => {
          formRef.current = null;
          instance.dispose();
        };
      }, []);

      React.useEffect(() => {
        if (formRef.current) formRef.current.refresh();
      }, [phase]);

      const [draft, setDraft] = React.useState('');
      const draftRef = React.useRef(null);

      /* A one-row textarea clips the second line instead of growing, which is
       * what pushed the last words under the box edge. Measure after every
       * change and let the row take the height, up to MAX_DRAFT_HEIGHT. */
      React.useEffect(() => {
        const element = draftRef.current;
        if (!element) return;
        element.style.height = 'auto';
        const height = Math.min(element.scrollHeight, MAX_DRAFT_HEIGHT);
        element.style.height = height + 'px';
        element.style.overflowY = element.scrollHeight > MAX_DRAFT_HEIGHT ? 'auto' : 'hidden';
      }, [draft]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [listening, setListening] = React.useState(false);
      const [transcribing, setTranscribing] = React.useState(false);
      const [heard, setHeard] = React.useState('');
      const captureRef = React.useRef(null);

      /** Send one message into the session this pane belongs to. */
      const submitText = React.useCallback(
        async (text) => {
          const trimmed = String(text || '').trim();
          if (!trimmed) return false;
          const session = bindSession(props.sessionId);
          if (!session) {
            setError('No live session for this pane.');
            return false;
          }
          setBusy(true);
          setError(null);
          try {
            const result = await session.prompt([{ type: 'text', text: trimmed }], 'queue');
            if (result && result.ok === false) {
              setError((result.error && result.error.message) || 'The session refused the message.');
              return false;
            }
            return true;
          } catch (failure) {
            setError(String((failure && failure.message) || failure));
            return false;
          } finally {
            setBusy(false);
          }
        },
        [props.sessionId],
      );

      const send = React.useCallback(async () => {
        if (!draft.trim() || busy) return;
        if (await submitText(draft)) setDraft('');
      }, [draft, busy, submitText]);

      const stop = React.useCallback(async () => {
        const session = bindSession(props.sessionId);
        if (!session) {
          setError('No live session for this pane.');
          return;
        }
        setError(null);
        try {
          const result = await session.cancel();
          if (result && result.ok === false) {
            setError((result.error && result.error.message) || 'The session refused the stop.');
          }
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        }
      }, [props.sessionId]);

      const onKeyDown = React.useCallback(
        (event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        },
        [send],
      );

      /** Release the microphone and every node the capture created. */
      const stopCapture = React.useCallback(() => {
        const capture = captureRef.current;
        captureRef.current = null;
        setListening(false);
        if (!capture) return;
        try {
          capture.vad.flush();
        } catch {
          /* nothing to flush */
        }
        try {
          capture.node.port.onmessage = null;
          capture.source.disconnect();
          capture.node.disconnect();
        } catch {
          /* already torn down */
        }
        try {
          capture.audio.close();
        } catch {
          /* already closed */
        }
        for (const track of capture.stream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* already stopped */
          }
        }
      }, []);

      React.useEffect(() => () => stopCapture(), [stopCapture]);

      /**
       * One utterance: recognize it, then send it. This is the turn-taking
       * mode — the microphone closes once the message is away, so the pane is
       * never left listening after a send.
       */
      const transcribe = React.useCallback(
        async (pcm) => {
          setTranscribing(true);
          try {
            const response = await fetch('/aura/asr', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                pcm: toBase64(new Uint8Array(pcm.buffer)),
                sampleRate: SAMPLE_RATE,
                channels: 1,
              }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || 'speech to text failed');
            const text = String(payload.text || '').trim();
            /* Silence is an outcome, not a failure: nothing is submitted. */
            if (text) {
              setHeard(text);
              await submitText(text);
            }
          } catch (failure) {
            setError(String((failure && failure.message) || failure));
          } finally {
            setTranscribing(false);
            /* Either way the turn is over, so the microphone closes here. */
            stopCapture();
          }
        },
        [stopCapture, submitText],
      );

      const startCapture = React.useCallback(async () => {
        captureRef.current = null;
        setError(null);
        setHeard('');
        try {
          const media = navigator.mediaDevices;
          if (!media || typeof media.getUserMedia !== 'function') {
            throw new Error('This browser exposes no microphone.');
          }
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtor) throw new Error('This browser exposes no Web Audio.');
          const stream = await media.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          });
          const audio = new AudioCtor({ sampleRate: SAMPLE_RATE });
          const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
          try {
            await audio.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          const source = audio.createMediaStreamSource(stream);
          const node = new AudioWorkletNode(audio, 'aura-capture');
          const sink = audio.createGain();
          sink.gain.value = 0;
          source.connect(node);
          node.connect(sink);
          sink.connect(audio.destination);
          const vad = createVad((pcm) => {
            void transcribe(pcm);
          });
          node.port.onmessage = (event) => vad.push(event.data);
          captureRef.current = { stream, audio, source, node, sink, vad };
          setListening(true);
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        }
      }, [transcribe]);

      const toggleMic = React.useCallback(() => {
        if (captureRef.current) stopCapture();
        else void startCapture();
      }, [startCapture, stopCapture]);

      return h(
        'div',
        { style: PANE, 'data-aura-phase': phase },
        h(
          'div',
          { style: STAGE, role: 'img', 'aria-label': `Aura ${phase}` },
          h('canvas', { ref: canvasRef, style: CANVAS }),
        ),
        h(
          'div',
          { style: CAPTION, title: heard || undefined },
          listening ? 'listening' : transcribing ? 'transcribing' : heard || phase,
        ),
        h(
          'div',
          { style: FOOTER },
          h(
            'div',
            { style: ROW },
            h('textarea', {
              ref: draftRef,
              style: INPUT,
              value: draft,
              rows: 1,
              placeholder: 'Ask in this session…',
              'aria-label': 'Message this session',
              onChange: (event) => setDraft(event.target.value),
              onKeyDown,
            }),
            h(
              'button',
              {
                type: 'button',
                style: BUTTON,
                title: listening ? 'Stop listening' : 'Start listening',
                'aria-label': listening ? 'Stop listening' : 'Start listening',
                onClick: toggleMic,
              },
              listening ? '●' : '○',
            ),
            h(
              'button',
              {
                type: 'button',
                style: BUTTON,
                title: 'Send',
                'aria-label': 'Send',
                disabled: busy || draft.trim() === '',
                onClick: send,
              },
              '↵',
            ),
            running
              ? h(
                  'button',
                  { type: 'button', style: BUTTON, title: 'Stop', 'aria-label': 'Stop', onClick: stop },
                  '■',
                )
              : null,
          ),
          error ? h('div', { style: ERROR }, error) : null,
        ),
      );
    }

    /** Slot entry: the boundary keeps a crash visible instead of blank. */
    const AuraPane = (props) => h(Boundary, null, h(Pane, props));

    /** The tab chip's title. */
    function TabTitle() {
      return h('span', null, 'Aura');
    }

    /* ---- wiring --------------------------------------------------------- */

    const Orbit = () =>
      h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 3.2, fill: 'currentColor' }),
        h('circle', {
          cx: 8,
          cy: 8,
          r: 6.4,
          fill: 'none',
          stroke: 'currentColor',
          strokeOpacity: 0.45,
          strokeWidth: 1,
        }),
      );

    return {
      inject: ['slots'],
      apply(ctx) {
        diag('apply');
        services = ctx;
        /* Filled by the tab registration so the header button can open it. */
        let open = null;

        ctx.inject(['sidebarRightTabs'], (scope) => {
          const disposers = [];
          const keep = (disposer) => {
            if (typeof disposer === 'function') disposers.push(disposer);
          };
          try {
            const tabs = scope.sidebarRightTabs;
            if (!tabs || typeof tabs.register !== 'function') return;
            const sidebarRight = scope.get('sidebarRight');
            if (sidebarRight && typeof sidebarRight.openTab === 'function') {
              open = () => sidebarRight.openTab(TAB_ID);
            }
            keep(
              tabs.register({
                id: TAB_ID,
                kind: TAB_ID,
                title: () => 'Aura',
                guide: [
                  {
                    id: TAB_ID,
                    order: 40,
                    title: () => 'Aura',
                    description: () => 'The agent’s current activity as a particle sphere.',
                    icon: Orbit,
                  },
                ],
              }),
            );
            keep(
              scope.slots.inject('sidebar.right.pane.tab', () =>
                scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, AuraPane),
              ),
            );
            keep(
              scope.slots.inject('sidebar.right.pane.tab.title', () =>
                scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, TabTitle),
              ),
            );
            registrations.ready = true;
              diag('registered', { tabs: true, body: true, title: true, open: typeof open === 'function' });
          } catch {
            for (const disposer of disposers) disposer();
            return;
          }
          return () => {
            open = null;
            for (const disposer of disposers) disposer();
          };
        });

        /* One click from the session header, so the tab is findable without
         * digging through the right bar's guide list. */
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: TAB_ID, order: 30 },
            function AuraButton() {
              return h(
                'button',
                {
                  type: 'button',
                  title: 'Aura',
                  'aria-label': 'Aura',
                  onClick: () => {
                    if (open) open();
                  },
                  style: {
                    display: 'grid',
                    placeItems: 'center',
                    width: 28,
                    height: 28,
                    padding: 0,
                    border: 'none',
                    borderRadius: 8,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                  },
                },
                h(Orbit, null),
              );
            },
          ),
        );
      },
    };
  },
});
