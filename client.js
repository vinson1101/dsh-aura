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
/* Declared before the loader runs: even the first beacon reads it, and a
 * factory-scope `const` would still be in its dead zone at that point. */
const AURA_VERSION = '0.15.0';

window.__ModuleLoader__.load({
  id: 'dsh-aura',
  factory(require) {
    diag('factory');
    const React = require('react');
    const h = React.createElement;

    /** Tab identity; `id` and `kind` are the same string on purpose. */
    const TAB_ID = 'dsh-aura';


    /** Set once the tab type, body and title are all registered. */
    const registrations = { ready: false };

    /**
     * Stage beacons. A slot entry that never mounts is indistinguishable from a
     * plugin that is not installed, and the renderer console cannot be read
     * from outside the app, so each stage posts to the host's diagnostic route
     * and lands in $DSH_HOME/aura-diag.jsonl.
     */
    function diag(stage, extra) {
      const line = JSON.stringify({ stage, v: AURA_VERSION, at: Date.now(), ...extra });
      try {
        /* A hot replace or a reload aborts in-flight fetches, which is exactly
         * when the evidence matters most. sendBeacon is not aborted. */
        if (navigator && typeof navigator.sendBeacon === 'function') {
          const body = new Blob([line], { type: 'application/json' });
          if (navigator.sendBeacon('/aura/diag', body)) return;
        }
      } catch {
        /* fall through to fetch */
      }
      try {
        fetch('/aura/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: line,
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
      talking: '97,222,194',
    };
    const SPIN = { idle: 0.22, running: 0.39, waiting: 0.26, done: 0.3, talking: 0.34 };

    /**
     * A form gets the canvas and the frame it sits in. The form owns its own
     * geometry: it squares the element from the frame's shorter side, so the
     * browser never stretches a square bitmap into a tall box — which is what
     * turned the sphere into an oval with pointed ends.
     *
     * The contract is `mount(canvas, readPhase) -> { refresh, dispose }`.
     */
    function mountOrb(canvas, readState) {
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

        const state = readState() || {};
        const phase = state.phase || 'idle';
        const level = Math.max(0, Math.min(1, state.level || 0));
        const tone = TONE[phase] || TONE.idle;
        const fast = phase === 'running' || phase === 'talking';
        const t = elapsed / 1000;
        /* A louder voice turns the sphere faster and swells it slightly, so the
         * shape reads as speech rather than as a fixed animation. */
        const angle = t * (SPIN[phase] || SPIN.idle) * (1 + level * 0.8);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const mid = size / 2;
        const radius = size * (0.36 + 0.008 * Math.sin(t * (fast ? 6 : 2)) + level * 0.035);

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
    /** 3200 bytes = 100 ms of PCM16 mono: the reference's "no instruction" floor. */
    const MIN_CAPTURE_BYTES = 3200;
    /** A teardown catches whatever was being said; under half a second of it is
     * a fragment, and sending fragments is how half a sentence becomes a turn. */
    const MIN_FLUSH_BYTES = 9600;

    /**
     * Endpoint detection, ported from the Zebra desktop client
     * (`desktop/desktop.py: desktop_utterance`).
     *
     * Two things there are better than a fixed threshold, and both are kept:
     *
     * - the noise floor follows the room (`floor = .8*floor + .2*level`, and
     *   the threshold is `max(450, floor * 1.65)`), so a fan or a quiet
     *   microphone does not move the endpoint;
     * - it decides on two signals: the decoder's own endpoint, and silence.
     *   The decoder half needs partial results, which the one-shot provider
     *   cannot give; `stable` and `decoder` are therefore reported but never
     *   produced until a streaming provider is wired in.
     *
     * Numbers are the reference's: 100 ms blocks, 900 ms of quiet, 4 s of
     * nothing, a 12 s cap.
     */
    const CHUNK_MS = 100;
    const CHUNK_SIZE = (SAMPLE_RATE * CHUNK_MS) / 1000;
    /** A short pause ends the turn only when the transcript looks finished. */
    const QUIET_CHUNKS = 9;
    /** Otherwise a real pause still wins, just later. */
    const LONG_QUIET_CHUNKS = 20;
    const NO_SPEECH_CHUNKS = 40;
    const MAX_CHUNKS = 120;
    const THRESHOLD_FLOOR = 450;
    const THRESHOLD_FACTOR = 1.65;
    const PEAK_DECAY = 0.975;
    const FLOOR_DECAY = 0.8;
    const NOISE_CEILING = 850;

    function createVad({ onChunk, onEnd, isComplete }) {
      let carry = new Float32Array(0);
      let chunks = 0;
      let speech = false;
      let quiet = 0;
      let floor = null;
      let peak = 0;
      let done = false;

      /** RMS on the 16-bit scale, the units the reference uses. */
      function levelOf(block) {
        let sum = 0;
        for (let index = 0; index < block.length; index += 1) {
          const value = block[index] * 0x8000;
          sum += value * value;
        }
        return Math.sqrt(sum / block.length);
      }

      /** Float block -> PCM16 for the wire; the provider wants exactly this. */
      function toPcm(block) {
        const pcm = new Int16Array(block.length);
        for (let index = 0; index < block.length; index += 1) {
          const value = Math.max(-1, Math.min(1, block[index]));
          pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
        }
        return pcm;
      }

      function end(reason) {
        if (done) return;
        done = true;
        onEnd(reason, speech, chunks * CHUNK_MS);
      }

      function take(block) {
        const level = levelOf(block);
        peak = Math.max(level, peak * PEAK_DECAY);
        if (floor === null) floor = Math.min(level, NOISE_CEILING);
        const threshold = Math.max(THRESHOLD_FLOOR, floor * THRESHOLD_FACTOR);
        if (level >= threshold) {
          speech = true;
          quiet = 0;
        } else {
          quiet += 1;
          floor = FLOOR_DECAY * floor + (1 - FLOOR_DECAY) * Math.min(level, NOISE_CEILING);
        }
        chunks += 1;
        /* Audio goes out as it arrives: the recogniser needs it now, and the
         * caller needs the level to decide whether the user is still talking. */
        onChunk(toPcm(block), level, peak);

        if (speech && quiet >= QUIET_CHUNKS) {
          /* Short pause: only finish if the recognizer already produced a
           * sentence end. A cloud partial can be seconds stale, so "the text
           * stopped changing" is not evidence that the user stopped talking. */
          if (typeof isComplete === 'function' && isComplete()) {
            end('sentence_end');
            return;
          }
          if (quiet >= LONG_QUIET_CHUNKS) {
            end('long_pause');
            return;
          }
        }
        if (!speech && chunks >= NO_SPEECH_CHUNKS) {
          end('no_speech');
          return;
        }
        if (chunks >= MAX_CHUNKS) end('limit');
      }

      return {
        push(samples) {
          if (done) return;
          let data = samples;
          if (carry.length) {
            const merged = new Float32Array(carry.length + data.length);
            merged.set(carry);
            merged.set(data, carry.length);
            data = merged;
          }
          let offset = 0;
          while (data.length - offset >= CHUNK_SIZE) {
            take(data.subarray(offset, offset + CHUNK_SIZE));
            offset += CHUNK_SIZE;
          }
          carry = data.slice(offset);
        },
        end,
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

    /** Decode base64 into bytes without spreading a huge array. */
    function fromBase64(text) {
      const binary = atob(String(text || ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    /** btoa on a large buffer throws; convert in bounded slices. */
    function toBase64(bytes) {
      let binary = '';
      const chunk = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk));
      }
      return btoa(binary);
    }

    /** The most recent assistant message text in this session, or ''. */
    function lastAssistantText(sessionId) {
      const sessions = services && services.get ? services.get('sessions') : null;
      if (!sessions || typeof sessions.binding !== 'function' || !sessionId) return '';
      const binding = sessions.binding(sessionId);
      const source = binding && binding.eventSource;
      const window_ = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
      const entries = (window_ && window_.entries) || [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const event = entries[index] && entries[index].event;
        if (!event || event.type !== 'assistant/message') continue;
        const message = event.data && event.data.message;
        const blocks = (message && message.content) || [];
        const text = blocks
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) return text;
      }
      return '';
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
      minWidth: 34,
      height: 34,
      padding: '0 8px',
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
    const BUTTON_ACTIVE = {
      borderColor: 'var(--dsw-alias-border-strong, currentColor)',
      background: 'var(--dsw-alias-bg-raised, rgba(127,127,127,.12))',
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
      /* Declared before the phase below reads it. */
      const [talking, setTalking] = React.useState(false);

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

      const phase = talking
        ? 'talking'
        : running
          ? 'running'
          : waiting
            ? 'waiting'
            : settled
              ? 'done'
              : 'idle';

      const canvasRef = React.useRef(null);
      const phaseRef = React.useRef(phase);
      phaseRef.current = phase;
      const formRef = React.useRef(null);

      React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const instance = form.mount(canvas, () => ({ phase: phaseRef.current, level: levelRef.current }));
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
      const partialRef = React.useRef({ text: '', at: 0 });
      const voiceRef = React.useRef(null);
      const levelRef = React.useRef(0);
      const speakNext = React.useRef(false);

      /** Stop playback and let the sphere settle. */
      const stopSpeaking = React.useCallback(() => {
        const playback = voiceRef.current;
        voiceRef.current = null;
        levelRef.current = 0;
        setTalking(false);
        if (!playback) return;
        try {
          playback.source.onended = null;
          playback.source.stop();
        } catch {
          /* already finished */
        }
        if (playback.frame !== undefined) window.cancelAnimationFrame(playback.frame);
        try {
          playback.audio.close();
        } catch {
          /* already closed */
        }
      }, []);

      /** Speak one reply: whole utterance, metered into the sphere. */
      const speak = React.useCallback(
        async (text) => {
          const spoken = String(text || '').trim();
          if (!spoken) return;
          stopSpeaking();
          try {
            diag('tts_request', { chars: spoken.length });
            const response = await fetch('/aura/tts', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: spoken.slice(0, 2000) }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || 'speech synthesis failed');
            diag('tts_ok', { voice: payload.voice, sampleRate: payload.sampleRate });

            const bytes = fromBase64(payload.pcm);
            const samples = Math.floor(bytes.length / 2);
            if (samples === 0) return;
            const rate = Number(payload.sampleRate) || SAMPLE_RATE;
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) return;

            const audio = new AudioCtor({ sampleRate: rate });
            /* Chromium starts a context created outside a gesture suspended;
             * start() on a suspended context plays nothing at all. */
            if (audio.state === 'suspended') {
              try {
                await audio.resume();
              } catch {
                /* report through the beacon below */
              }
            }
            const buffer = audio.createBuffer(1, samples, rate);
            const channel = buffer.getChannelData(0);
            for (let index = 0; index < samples; index += 1) {
              const low = bytes[index * 2];
              const high = bytes[index * 2 + 1];
              const value = (high << 8) | low;
              channel[index] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
            }

            const source = audio.createBufferSource();
            source.buffer = buffer;
            const analyser = audio.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            analyser.connect(audio.destination);

            const data = new Uint8Array(analyser.fftSize);
            const playback = { audio, source, frame: undefined };
            const meter = () => {
              if (voiceRef.current !== playback) return;
              analyser.getByteTimeDomainData(data);
              let sum = 0;
              for (let index = 0; index < data.length; index += 1) {
                const value = (data[index] - 128) / 128;
                sum += value * value;
              }
              levelRef.current = Math.min(1, Math.sqrt(sum / data.length) * 2.6);
              playback.frame = window.requestAnimationFrame(meter);
            };

            source.onended = () => {
              if (voiceRef.current !== playback) return;
              diag('play_end');
              stopSpeaking();
            };
            voiceRef.current = playback;
            setTalking(true);
            source.start();
            playback.frame = window.requestAnimationFrame(meter);
            diag('play_start', { state: audio.state, seconds: Number((samples / rate).toFixed(2)) });
          } catch (failure) {
            diag('tts_error', { message: String((failure && failure.message) || failure).slice(0, 200) });
            setError(String((failure && failure.message) || failure));
          }
        },
        [stopSpeaking],
      );

      React.useEffect(() => () => stopSpeaking(), [stopSpeaking]);

      /**
       * The app has no reload shortcut, so a page can run an old bundle with no
       * way out. Ask the host which version is installed and reload when it
       * differs — the alternative is what happened here: hours of changes that
       * never ran.
       */
      React.useEffect(() => {
        let stopped = false;
        let timer;
        const check = async () => {
          try {
            const response = await fetch('/aura/version', { cache: 'no-store' });
            const payload = await response.json();
            const installed = String(payload.version || '');
            if (!stopped && installed && installed !== AURA_VERSION) {
              diag('reload_for_version', { running: AURA_VERSION, installed });
              window.location.reload();
              return;
            }
          } catch {
            /* offline or the route is older than this bundle */
          }
          if (!stopped) timer = window.setTimeout(check, 5000);
        };
        timer = window.setTimeout(check, 4000);
        return () => {
          stopped = true;
          if (timer !== undefined) window.clearTimeout(timer);
        };
      }, []);

      React.useEffect(() => {
        if (wasRunning.current && !running) {
          setSettledAt(Date.now() + SETTLED_MS);
          /* A run we started ends here: read its reply and speak it. */
          if (speakNext.current) {
            speakNext.current = false;
            const reply = lastAssistantText(props.sessionId);
          diag('reply_ready', { chars: reply.length });
          if (reply) void speak(reply);
          }
        }
        wasRunning.current = running;
      }, [running, props.sessionId, speak]);

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
            speakNext.current = true;
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
        stopSpeaking();
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
      }, [props.sessionId, stopSpeaking]);

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
      /** Tear down the microphone, the live socket and the meter. */
      const stopCapture = React.useCallback(() => {
        const capture = captureRef.current;
        captureRef.current = null;
        setListening(false);
        if (!capture) return;
        diag('mic_stop');
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
        if (capture.socket) {
          try {
            capture.socket.close();
          } catch {
            /* already closed */
          }
        }
      }, []);

      React.useEffect(() => () => stopCapture(), [stopCapture]);

      /**
       * One live turn over the bridge's control frames: hello, listen start,
       * binary PCM, listen stop, stt final. Partials arrive while the user is
       * still talking, so the caption fills in and the turn can end on a
       * completed sentence instead of only on silence.
       */
      const startCapture = React.useCallback(async () => {
        captureRef.current = null;
        setError(null);
        setHeard('');
        partialRef.current = { text: '', at: 0 };
        const turn = { socket: null, release: null, started: false };

        const finishTurn = (reason) => {
          diag('turn_finish', { reason });
          try {
            turn.socket.send(JSON.stringify({ type: 'listen', state: 'stop' }));
          } catch {
            /* the socket is gone; stopCapture still happens below */
          }
        };

        try {
          const media = navigator.mediaDevices;
          if (!media || typeof media.getUserMedia !== 'function') {
            throw new Error('This browser exposes no microphone.');
          }
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtor) throw new Error('This browser exposes no Web Audio.');

          const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
          const socket = new WebSocket(`${scheme}://${location.host}/aura/asr/live`);
          turn.socket = socket;

          const finalText = new Promise((resolve) => {
            turn.release = resolve;
            socket.onmessage = (event) => {
              let message;
              try {
                message = JSON.parse(String(event.data));
              } catch {
                return;
              }
              if (message.type === 'hello') {
                socket.send(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }));
                return;
              }
              if (message.type === 'listen' && message.state === 'start') {
                turn.started = true;
                return;
              }
              if (message.type === 'stt') {
                const text = String(message.text || '');
                if (message.partial) {
                  partialRef.current = { text, at: Date.now() };
                  setHeard(text);
                  return;
                }
                turn.release({ text });
                return;
              }
              if (message.type === 'error') {
                turn.release({ error: message.message || 'the recognizer failed' });
              }
            };
            socket.onopen = () => {
              socket.send(
                JSON.stringify({
                  type: 'hello',
                  transport: 'websocket',
                  audio_params: { format: 'pcm16', sample_rate: SAMPLE_RATE, channels: 1, frame_duration: 100 },
                }),
              );
            };
            socket.onerror = () => {
              diag('live_error', { phase: 'socket' });
              turn.release({ error: 'the speech socket failed' });
            };
            setTimeout(() => turn.release({ error: 'the recognizer did not answer' }), 12000);
          });

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

          const vad = createVad({
            onChunk(pcm, level, peak) {
              if (!turn.started) return;
              try {
                if (socket.readyState === 1) socket.send(pcm.buffer);
              } catch {
                /* a dead socket ends the turn on its own */
              }
              /* No timing-based cutoff here. The Zebra reference could trust
               * partial stability because its decoder ran locally and updated
               * every 100 ms; cloud partials arrive in bursts, so a still
               * transcript proves nothing about the speaker. The level and the
               * peak stay available for future tuning. */
              void level;
              void peak;
            },
            isComplete() {
              const text = partialRef.current.text.trim();
              return /[。．.!！?？…；;]$/.test(text);
            },
            onEnd(reason, spoke, ms) {
              diag('capture_end', { reason, ms, speech: spoke });
              if (reason === 'no_speech') {
                stopCapture();
                return;
              }
              finishTurn(reason);
            },
          });

          void finalText.then(async (result) => {
            if (result.error) {
              diag('live_final_error', { error: String(result.error).slice(0, 160) });
              setError(String(result.error));
            } else {
              const text = String(result.text || '').trim();
              diag('asr', { chars: text.length, empty: text.length === 0 });
              if (text) {
                setHeard(text);
                await submitText(text);
              }
            }
            stopCapture();
          });

          node.port.onmessage = (event) => vad.push(event.data);
          captureRef.current = { stream, audio, source, node, sink, vad, socket };
          setListening(true);
          diag('mic_start', { rate: audio.sampleRate });
        } catch (failure) {
          diag('mic_error', { message: String((failure && failure.message) || failure).slice(0, 160) });
          setError(String((failure && failure.message) || failure));
          try {
            if (turn.socket) turn.socket.close();
          } catch {
            /* already closed */
          }
        }
      }, [submitText, stopCapture]);

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
          listening ? 'listening' : transcribing ? 'transcribing' : heard || `${phase} · ${AURA_VERSION}`,
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
                style: listening ? { ...BUTTON, ...BUTTON_ACTIVE } : BUTTON,
                title: `${listening ? 'Stop listening' : 'Speak'} · ${AURA_VERSION}`,
                'aria-label': listening ? 'Stop listening' : 'Start listening',
                onClick: toggleMic,
              },
              listening ? '● 在听' : '🎙 说话',
            ),
            h(
              'button',
              {
                type: 'button',
                style: BUTTON,
                title: `Play a test phrase · ${AURA_VERSION}`,
                'aria-label': 'Play a test phrase',
                onClick: () => void speak('你好，我是 Aura。现在可以听到我说话。'),
              },
              '🔊 试听',
            ),
            h(
              'button',
              {
                type: 'button',
                style: BUTTON,
                title: 'Reload the page',
                'aria-label': 'Reload the page',
                onClick: () => window.location.reload(),
              },
              '⟳',
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

