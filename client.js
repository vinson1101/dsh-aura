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
const AURA_VERSION = '0.29.0';

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
    /**
     * Ask the host which version is installed and reload when it differs.
     *
     * Module scope on purpose: a crash inside the pane took the earlier
     * watcher with it and left a broken page with no way to recover.
     */
    let watching = false;
    function watchForNewVersion() {
      if (watching || typeof window === 'undefined') return;
      /* A test page has no host to ask, and an endless timer would stop the
       * process from ever exiting. */
      if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '')) return;
      watching = true;
      const tick = async () => {
        try {
          const response = await fetch('/aura/version', { cache: 'no-store' });
          const payload = await response.json();
          const installed = payload && payload.version;
          if (installed && installed !== AURA_VERSION) {
            /* Reload once per target version. The host serves the client bundle
             * it read at startup, so if the reload comes back on the same
             * version the bundle cannot be newer no matter how often we try —
             * that is a plugin reload on the host side, not a page refresh. */
            const KEY = 'dsh-aura.reloaded-for';
            let attempted = '';
            try {
              attempted = window.sessionStorage.getItem(KEY) || '';
            } catch {
              /* private mode */
            }
            if (attempted === installed) {
              diag('reload_blocked', { running: AURA_VERSION, installed });
              window.dispatchEvent(
                new window.CustomEvent('aura:stale-bundle', { detail: { running: AURA_VERSION, installed } }),
              );
              window.setTimeout(tick, 30000);
              return;
            }
            try {
              window.sessionStorage.setItem(KEY, installed);
            } catch {
              /* private mode: at most one attempt anyway */
            }
            diag('reload_for_version', { running: AURA_VERSION, installed });
            window.location.reload();
            return;
          }
          try {
            window.sessionStorage.removeItem('dsh-aura.reloaded-for');
          } catch {
            /* ignore */
          }
        } catch {
          /* the host is restarting; try again next tick */
        }
        window.setTimeout(tick, 5000);
      };
      window.setTimeout(tick, 4000);
    }

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

    /* One tone per state, and each state also moves differently: colour alone
     * is not readable at this size. */
    const TONE = {
      idle: '110,187,250',      // blue, breathing slowly
      listening: '94,226,236',  // cyan, holding still
      running: '151,151,255',   // violet, working
      waiting: '242,151,138',   // coral, needs a person
      done: '97,222,194',       // teal, settled
      talking: '97,222,194',    // teal, speaking
      error: '239,110,116',     // red, trembling
    };
    const SPIN = {
      idle: 0.22,
      listening: 0.06,
      running: 0.39,
      waiting: 0.26,
      done: 0.3,
      talking: 0.34,
      error: 0.55,
    };
    /* How tight the cloud holds itself: listening pulls in, talking opens up. */
    const TIGHT = { listening: 0.9, talking: 1.04, error: 0.96, running: 1.02 };

    /**
     * Turn written text into something worth hearing.
     *
     * A reply is written for the eye: it carries code fences, inline code, paths,
     * table pipes and emphasis marks. Read aloud those become English identifiers
     * in the middle of a Chinese sentence. Prose is kept, markup is dropped, and a
     * segment that is mostly code is not spoken at all.
     */
    function speechText(text) {
      let prose = String(text || '');
      prose = prose.replace(/```[\s\S]*?```/g, ' ');
      prose = prose.replace(/`[^`]*`/g, ' ');
      prose = prose.replace(/https?:\/\/\S+/g, ' ');
      prose = prose.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ');
      /* A table row read aloud is noise: drop the whole line. */
      prose = prose.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ');
      /* Table rows, headings, list bullets and block quotes. */
      prose = prose.replace(/^[ \t]*[|>#]+[ \t]*/gm, '');
      prose = prose.replace(/^[ \t]*[-*+][ \t]+/gm, '');
      prose = prose.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
      prose = prose.replace(/[*_~]{1,3}/g, '');
      prose = prose.replace(/[ \t]+/g, ' ');
      prose = prose.replace(/\n{2,}/g, '。');
      prose = prose.replace(/\n/g, '，');
      prose = prose.trim();
      if (!prose) return '';
      const han = (prose.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (prose.match(/[A-Za-z]/g) || []).length;
      /* Mostly letters and punctuation, almost no Chinese: an identifier list, a
       * path, a version line. Speaking it is worse than silence. */
      if (han < 2 && latin > 6) return '';
      /* Digits, punctuation and spaces only: a version, a count, a separator. */
      if (han === 0 && latin === 0) return '';
      return prose;
    }

    /**
     * A form gets the canvas and the frame it sits in. The form owns its own
     * geometry: it squares the element from the frame's shorter side, so the
     * browser never stretches a square bitmap into a tall box — which is what
     * turned the sphere into an oval with pointed ends.
     *
     * The contract is `mount(canvas, readPhase) -> { refresh, dispose }`.
     */
    /**
     * Root-mean-square of one captured frame, on a 0..1 scale.
     *
     * The worklet posts Float32 samples, so reading them as 16-bit would scale
     * every value down to zero and make "is somebody talking" answer no,
     * forever. Both shapes are accepted because the type of a postMessage port
     * is not something this file should assume twice.
     */
    function levelOfFrame(frame) {
      if (!frame) return 0;
      const length = frame.length || 0;
      if (length === 0) return 0;
      if (typeof frame[0] === 'number' && Math.abs(frame[0]) <= 1.5) {
        let sum = 0;
        for (let index = 0; index < length; index += 1) {
          const value = frame[index];
          sum += value * value;
        }
        return Math.sqrt(sum / length);
      }
      const samples = frame instanceof Int16Array ? frame : new Int16Array(frame.buffer || frame);
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index] / 32768;
        sum += value * value;
      }
      return Math.sqrt(sum / samples.length);
    }

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
        const tight = TIGHT[phase] || 1;
        /* Listening is nearly still and does not answer the microphone, so the
         * pause reads as "your turn" rather than as more animation. */
        const listening = phase === 'listening';
        const thinking = phase === 'running' || phase === 'waiting';
        const trembling = phase === 'error';
        const wobble = trembling ? (Math.random() - 0.5) * size * 0.012 : 0;
        /* A louder voice turns the sphere faster and swells it slightly, so the
         * shape reads as speech rather than as a fixed animation. */
        const angle = t * (SPIN[phase] || SPIN.idle) * (1 + level * 0.8);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const mid = size / 2;
        /* Listening breathes slowly, thinking flickers, speaking answers the
         * voice, and an error trembles. Same particles, different behaviour. */
        const breathRate = listening ? 0.9 : thinking ? 1.6 : fast ? 4.2 : 1.4;
        const breathDepth = listening ? 0.004 : thinking ? 0.006 : fast ? 0.012 : 0.007;
        const radius =
          size *
          tight *
          (0.36 + breathDepth * Math.sin(t * breathRate) + level * 0.035);

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
          /* Thinking shows only part of the cloud at any moment: the particles
           * seem to search rather than sit still. */
          const twinkle = thinking ? 0.55 + 0.45 * Math.sin(t * 2.4 + seed * 7) : 1;
          if (thinking && twinkle < 0.62) continue;
          const strength = (depth + 1) * 0.5 * twinkle;
          groups[Math.min(5, Math.floor(strength * 6))].push([
            mid + (x * cos + z * sin) * radius * wave + wobble,
            mid + y * radius * wave + wobble,
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
    /** Streaming grows nothing per chunk, so a long dictation is allowed. */
    const MAX_CHUNKS = 600;
    const THRESHOLD_FLOOR = 450;
    const THRESHOLD_FACTOR = 1.65;
    const PEAK_DECAY = 0.975;
    const FLOOR_DECAY = 0.8;
    const NOISE_CEILING = 850;

    function createVad({ onChunk, onEnd, isComplete, noSpeechChunks = NO_SPEECH_CHUNKS }) {
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
        if (!speech && chunks >= noSpeechChunks) {
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

    /** Known-good CosyVoice ids from the Zebra voice path; others can be typed. */
    /* v3.5-flash is cheaper per character ($0.116 vs $0.14335 per 10k) but it
     * rejects every system voice id with an engine 418: it only speaks with a
     * cloned or designed voice, whose id looks like cosyvoice-v3.5-flash-xxxx. */
    const MODELS = [
      { id: 'cosyvoice-v3-flash', name: '3.0', note: '系统音色' },
      { id: 'cosyvoice-v3.5-flash', name: '3.5', note: '需复刻音色' },
    ];

    /* Every voice below was probed against cosyvoice-v3-flash with this
     * account and returned audio; the traits come from the provider's voice
     * list. Anything not on this list was rejected with "Invalid voice". */
    const VOICES = [
      { id: 'longanyang', name: '龙安洋', trait: '阳光大男孩', note: '基准音色' },
      { id: 'longyan_v3', name: '龙颜', trait: '温暖春风女' },
      { id: 'longxiaochun_v3', name: '龙小淳', trait: '知性积极女' },
      { id: 'longxiaoxia_v3', name: '龙小夏', trait: '沉稳权威女' },
      { id: 'longwan_v3', name: '龙婉', trait: '细腻柔声女' },
      { id: 'longyue_v3', name: '龙悦', trait: '温暖磁性女' },
      { id: 'longyuan_v3', name: '龙媛', trait: '温暖治愈女' },
      { id: 'longmiao_v3', name: '龙妙', trait: '抑扬顿挫女' },
      { id: 'longhua_v3', name: '龙华', trait: '元气甜美女' },
      { id: 'longanran_v3', name: '龙安燃', trait: '活泼质感女' },
      { id: 'longyumi_v3', name: 'YUMI', trait: '正经青年女' },
      { id: 'loongbella_v3', name: 'Bella', trait: '精准干练女' },
      { id: 'longcheng_v3', name: '龙橙', trait: '智慧青年男' },
      { id: 'longze_v3', name: '龙泽', trait: '温暖元气男' },
      { id: 'longshu_v3', name: '龙书', trait: '沉稳青年男' },
      { id: 'longshuo_v3', name: '龙硕', trait: '博才干练男' },
      { id: 'longhan_v3', name: '龙寒', trait: '温暖痴情男' },
      { id: 'longhao_v3', name: '龙浩', trait: '多情忧郁男' },
      { id: 'longfei_v3', name: '龙飞', trait: '热血磁性男' },
      { id: 'longlaotie_v3', name: '龙老铁', trait: '东北直率男' },
      { id: 'longjielidou_v3', name: '龙杰力豆', trait: '阳光顽皮男' },
    ];
    /* Two ways to talk. `talk` is turn-taking: open the microphone, speak,
     * it answers, the microphone is closed. `chat` is continuous: the
     * microphone stays open, and speaking while it is answering interrupts. */
    const MODES = [
      { id: 'talk', name: '对话', note: '一句一答' },
      { id: 'chat', name: '聊天', note: '常听，可随时插话' },
    ];

    const PREF_KEY = 'dsh-aura.prefs';

    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREF_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return {
          voice: typeof parsed.voice === 'string' ? parsed.voice : VOICES[0].id,
          model: MODELS.some((item) => item.id === parsed.model) ? parsed.model : MODELS[0].id,
          mode: MODES.some((item) => item.id === parsed.mode) ? parsed.mode : MODES[0].id,
          avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
        };
      } catch {
        return { voice: VOICES[0].id, avatar: '', model: MODELS[0].id, mode: MODES[0].id };
      }
    }

    function writePrefs(next) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(next));
      } catch {
        /* private mode: the choice simply does not persist */
      }
    }

    let cachedOrigin;
    /**
     * The console is served from `dsh-app://app/` inside the desktop app, so
     * `location.host` is not the host. Ask the host for its origin once and
     * build socket URLs from that.
     */
    async function hostOrigin() {
      if (cachedOrigin) return cachedOrigin;
      try {
        const response = await fetch('/aura/version', { cache: 'no-store' });
        const payload = await response.json();
        if (typeof payload.origin === 'string' && payload.origin) {
          cachedOrigin = payload.origin;
          return cachedOrigin;
        }
      } catch {
        /* fall through to the page origin */
      }
      if (typeof location !== 'undefined' && /^https?:/.test(location.origin)) {
        cachedOrigin = location.origin;
        return cachedOrigin;
      }
      return '';
    }

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
      gridTemplateRows: 'auto 1fr auto auto',
      gap: 10,
      padding: 16,
      boxSizing: 'border-box',
      position: 'relative',
      containerType: 'inline-size',
    };
    /* The stage only centres; the form squares the canvas inside it. */
    const HEADER = {
      display: 'flex',
      justifyContent: 'flex-end',
      alignItems: 'center',
      minHeight: 16,
    };
    const VERSION_LABEL = {
      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      fontSize: 10,
      letterSpacing: '0.04em',
      opacity: 0.38,
      color: 'var(--dsw-alias-text-secondary, inherit)',
      userSelect: 'text',
    };
    /* Deliberately quiet: it sits beside the version, not in the composer row. */
    const RELOAD = {
      display: 'grid',
      placeItems: 'center',
      width: 18,
      height: 16,
      marginLeft: 4,
      padding: 0,
      border: 'none',
      borderRadius: 4,
      background: 'transparent',
      color: 'var(--dsw-alias-text-secondary, inherit)',
      opacity: 0.45,
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
    };
    const STYLE = `
      .aura-top { display: flex; align-items: center; justify-content: flex-end; gap: 4px;
        min-height: 46px; min-width: 0; max-width: 100%; }
      .aura-chip { display: inline-flex; align-items: center; gap: 10px; padding: 3px 12px 3px 3px;
        border: 1px solid rgba(160, 170, 190, .16); border-radius: 999px;
        background: rgba(120, 132, 152, .12); backdrop-filter: blur(10px);
        color: inherit;
        font: inherit; font-size: 20px; font-weight: 500; letter-spacing: -.01em;
        max-width: 100%; min-width: 0; overflow: hidden;
        cursor: pointer; transition: background .15s ease, border-color .15s ease; }
      .aura-chip:hover { background: rgba(127,127,127,.14); border-color: rgba(127,127,127,.22); }
      .aura-chip[aria-expanded='true'] { background: rgba(127,127,127,.16); border-color: rgba(127,127,127,.28); }
      .aura-ava { width: 38px; height: 38px; border-radius: 999px; object-fit: cover; display: block;
        background: linear-gradient(140deg, #2b6cb0, #1f3a5f); }
      .aura-ava-fallback { width: 38px; height: 38px; border-radius: 999px; display: grid; place-items: center;
        font-size: 16px; font-weight: 600; color: #cfe4ff; background: linear-gradient(140deg, #2b6cb0, #1f3a5f); }
      /* Starts below the chip, never on top of it: the control that opens the
       * card must stay clickable while it is open. */
      /* The theme already owns the popover surface and its glass treatment;
       * inventing a translucency here fought the wallpaper and the theme. */
      /* Self-contained glass: the plugin decides its own translucency, so it
       * looks the same in a bare profile as in a decorated one. The theme
       * colour is used only as the tint; the alpha is ours. */
      /* Same ingredients as the chip above it: a neutral colour, an alpha, and
       * a blur. The theme's surface tokens are opaque, which is why the card
       * stayed dark while the chip looked like glass. */
      .aura-card { position: absolute; top: 58px; right: 8px; width: 276px;
      max-width: calc(100% - 16px); padding: 14px;
      max-height: calc(100% - 66px); overflow-y: auto; overscroll-behavior: contain;
      display: grid; gap: 12px; border-radius: 14px;
      border: 1px solid rgba(160, 170, 190, .22);
      background: rgba(120, 132, 152, .18);
      backdrop-filter: blur(22px) saturate(160%);
      -webkit-backdrop-filter: blur(22px) saturate(160%);
      box-shadow: 0 20px 48px rgba(0, 0, 0, .36), inset 0 1px 0 rgba(255, 255, 255, .12);
      z-index: 6; }
      .aura-id { display: flex; align-items: center; gap: 10px; }
      .aura-close { margin-left: auto; width: 24px; height: 24px; border-radius: 999px; border: none;
        background: transparent; color: inherit; font: inherit; font-size: 14px; line-height: 1;
        opacity: .45; cursor: pointer; }
      .aura-close:hover { opacity: 1; background: rgba(127,127,127,.16); }
      .aura-id img, .aura-id .aura-ava-fallback { width: 42px; height: 42px; font-size: 17px; }
      .aura-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .aura-name { font-size: 15px; font-weight: 600; letter-spacing: .01em;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .aura-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); opacity: .8; margin-top: 2px; }
      .aura-rule { height: 1px; background: rgba(255,255,255,.1); margin: 0 -4px; }
      .aura-cap { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, inherit); opacity: .7; margin-bottom: 6px; }
      .aura-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; }
      .aura-row:hover { background: rgba(255,255,255,.07); }
      .aura-dot { width: 8px; height: 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,.55); flex: 0 0 auto; }
      .aura-row[data-on='true'] .aura-dot { border-color: #7ec8ff; background: #7ec8ff; box-shadow: 0 0 8px #7ec8ff88; }
      .aura-label { flex: 1; min-width: 0; font-size: 13px; line-height: 1.35; }
      .aura-id-mono { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9px; opacity: .34; display: block; }
      .aura-trait { font-size: 10px; margin-left: 6px; color: var(--dsw-alias-label-tertiary, inherit); opacity: .75; }
      .aura-tag { font-size: 9px; margin-left: 6px; padding: 1px 5px; border-radius: 5px;
        background: rgba(127,127,127,.2); opacity: .8; }
      .aura-models { display: flex; gap: 6px; margin: 2px 0 8px; }
      .aura-model { height: 26px; min-width: 44px; padding: 0 10px; border-radius: 8px;
        border: 1px solid rgba(255,255,255,.16); background: transparent; color: inherit;
        font: inherit; font-size: 12px; cursor: pointer; opacity: .7; }
      .aura-model[data-on='true'] { opacity: 1; border-color: rgba(255,255,255,.4);
        background: rgba(255,255,255,.12); }
      /* Beside the orb, not in a settings panel: a call is an action. */
      .aura-call { position: absolute; right: 4px; bottom: 4px; width: 52px; height: 52px;
        display: grid; place-items: center; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(160,170,190,.28); background: rgba(120,132,152,.22);
        color: inherit; backdrop-filter: blur(10px);
        transition: background .15s ease, border-color .15s ease, transform .15s ease; }
      .aura-call:hover { background: rgba(120,132,152,.34); transform: scale(1.04); }
      .aura-call[data-active='true'] { background: #e5484d; border-color: transparent; color: #fff;
        animation: aura-record 1.5s ease-out infinite; }
      .aura-call[data-active='true']:hover { background: #d93d42; }
      @media (prefers-reduced-motion: reduce) { .aura-call[data-active='true'] { animation: none; } }
      .aura-voices { max-height: 216px; overflow-y: auto; overscroll-behavior: contain;
        margin: 0 -6px; padding: 0 6px; }
      .aura-act { height: 22px; padding: 0 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,.16);
        background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
        opacity: .55; transition: opacity .15s ease, background .15s ease; white-space: nowrap; }
      .aura-row:hover .aura-act, .aura-act:focus-visible { opacity: 1; }
      .aura-act:hover { background: rgba(127,127,127,.18); }
      .aura-act:disabled { opacity: .25; cursor: default; }
      .aura-field { flex: 1; min-width: 0; height: 28px; padding: 0 9px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
        background: var(--dsw-alias-bg-layer-2, transparent); color: inherit; font: inherit; font-size: 11px; }
      .aura-field:focus { outline: none; border-color: rgba(126,200,255,.65); }
      .aura-foot { display: flex; align-items: center; justify-content: space-between; font-size: 11px; opacity: .6; }
      .aura-foot button { height: 22px; padding: 0 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.3);
        background: transparent; color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
      .aura-foot button:hover { background: rgba(127,127,127,.16); }
      /* Recording is red, and it breathes, the way a recorder light does. */
      .aura-foot button[data-listening='true'] {
        background: #e5484d; border-color: transparent; color: #fff;
        animation: aura-record 1.5s ease-out infinite !important;
      }
      .aura-foot button[data-listening='true']:hover { background: #d93d42; }
      @keyframes aura-record {
        0% { box-shadow: 0 0 0 0 rgba(229, 72, 77, .55); }
        70% { box-shadow: 0 0 0 9px rgba(229, 72, 77, 0); }
        100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .aura-foot button[data-listening='true'] { animation: none; }
      }
      /* Below these widths the parts stop fitting side by side. Drop the words
       * that repeat what the glyph already says, and keep every control. */
      /* The pane is 300px at its narrowest and 680px at its widest, so the
       * tiers sit inside that range rather than below it. */

      @container (max-width: 240px) {
        .aura-chip-text { display: none; }
        .aura-stack { flex-wrap: wrap; }
        .aura-stack .aura-field { flex: 1 1 100%; }
        .aura-stack .aura-act { margin-left: auto; }
      }
      /* Narrow card: a field and its button no longer fit side by side, and the
       * mono detail line is the first thing to give way. */
      @container (max-width: 340px) {
        /* No room for a floating card: it becomes the pane's surface. */
        .aura-card { left: 0; right: 0; width: auto; max-width: none;
          border-radius: 0 0 14px 14px; padding: 12px; }
        .aura-stack { flex-wrap: nowrap; }
        .aura-stack .aura-field { flex: 1 1 0%; min-width: 0; }
        .aura-stack .aura-act { margin-left: 0; flex: 0 0 auto; }
        .aura-card { padding: 10px; gap: 8px; }
        .aura-id-mono { display: none; }
        .aura-stack { flex-wrap: wrap; }
        .aura-stack .aura-field { flex: 1 1 100%; }
        .aura-stack .aura-act { margin-left: auto; }
        .aura-row { padding: 4px; }
      }
      @container (max-width: 200px) {
        .aura-ava, .aura-ava-fallback { width: 34px; height: 34px; font-size: 15px; }
        .aura-top { min-height: 42px; }
        .aura-card { top: 56px; max-height: calc(100% - 64px); padding: 10px; }
      }
    `;

    const PROFILE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '2px 6px 2px 2px',
      border: 'none',
      borderRadius: 999,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    };
    const AVATAR = {
      width: 20,
      height: 20,
      borderRadius: 999,
      objectFit: 'cover',
      display: 'block',
      background: 'var(--dsw-alias-bg-raised, rgba(127,127,127,.18))',
    };
    const AVATAR_FALLBACK = {
      ...AVATAR,
      display: 'grid',
      placeItems: 'center',
      fontSize: 11,
      fontWeight: 600,
      opacity: 0.8,
    };
    const PANEL_CARD = {
      position: 'absolute',
      top: 30,
      right: 10,
      width: 260,
      padding: 10,
      display: 'grid',
      gap: 8,
      borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-base, rgba(127,127,127,.35))',
      background: 'var(--dsw-alias-bg-base, #16181d)',
      boxShadow: '0 8px 24px rgba(0,0,0,.28)',
      zIndex: 5,
    };
    const PANEL_ROW = { display: 'flex', alignItems: 'center', gap: 6 };
    const PANEL_LABEL = {
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      opacity: 0.5,
    };
    const SMALL_INPUT = {
      flex: 1,
      minWidth: 0,
      height: 24,
      padding: '0 6px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-base, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 11,
    };
    const SMALL_BUTTON = {
      height: 24,
      padding: '0 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-base, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 11,
      cursor: 'pointer',
    };
    const STAGE = {
      width: '100%',
      height: '100%',
      minHeight: 160,
      display: 'grid',
      placeItems: 'center',
      position: 'relative',
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
    /* No wrapping: a wrapped button is a clipped button in this pane. The input
     * shrinks instead, which is what minWidth: 0 on the field allows. */
    const ROW = { display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'nowrap' };
    /** The composer's tallest state before it scrolls instead of growing. */
    const MAX_DRAFT_HEIGHT = 132;
    const INPUT = {
      flex: '1 1 0%',
      minWidth: 44,
      minHeight: 38,
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
    /* Derived from the reference card: the label is about 53% of the control
     * height, the icon about 45%, and the corner radius about 30%. */
    const BUTTON = {
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minWidth: 42,
      height: 42,
      padding: 0,
      display: 'grid',
      placeItems: 'center',
      borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-base, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 15,
      lineHeight: 1,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    };
    /* Recording red. Inline, because the button's own background is inline and
     * an inline declaration wins over the stylesheet. */
    const BUTTON_ACTIVE = {
      borderColor: 'transparent',
      background: '#e5484d',
      color: '#fff',
      boxShadow: '0 0 0 0 rgba(229, 72, 77, .55)',
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
          'div',
          { style: { display: 'grid', gap: 8, padding: 12 } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => window.location.reload(),
              style: {
                justifySelf: 'start',
                height: 28,
                padding: '0 12px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,.24)',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
              },
            },
            'Reload Aura',
          ),
          h(
            'pre',
            {
              style: {
                margin: 0,
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
          ),
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
      /* Mirrors the live status, because submitting happens outside the effect. */
      const runningRef = React.useRef(false);
      const [settledAt, setSettledAt] = React.useState(0);
      const [settled, setSettled] = React.useState(false);
      /* Declared before the phase below reads it. */
      const [listening, setListening] = React.useState(false);
      const [error, setError] = React.useState(null);
      /* A continuous session is always "listening" at rest, so the phase needs
       * the mode before the preference state is declared. */
      const modeRef = React.useRef('talk');
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

      /* Order matters: the microphone is the most immediate thing happening,
       * then the voice, then the turn, then a pending question. */
      const phase = listening
        ? 'listening'
        : (modeRef.current === 'chat' && !talking && !running && !error)
          ? 'listening'
        : talking
          ? 'talking'
          : error
            ? 'error'
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
      const [transcribing, setTranscribing] = React.useState(false);
      const [heard, setHeard] = React.useState('');
      const [prefs, setPrefs] = React.useState(readPrefs);
      modeRef.current = prefs.mode || 'talk';
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [customVoice, setCustomVoice] = React.useState('');
      const paneRef = React.useRef(null);
      const prefsRef = React.useRef(prefs);
      prefsRef.current = prefs;
      const cardRef = React.useRef(null);

      /* A popover that can only be closed by hitting what it does not cover is
       * a trap. Close on a pointer press anywhere outside it, and on Escape. */
      React.useEffect(() => {
        if (!panelOpen) return undefined;
        /* The glass look is decided by the browser, not by this source file: a
         * var() that fails to substitute and a backdrop filter that the
         * compositor drops both look like "nothing changed". Report the
         * computed values so the next question is answered by data. */
        window.setTimeout(() => {
          /* Every card on the page, not just this one: a stale instance from an
           * earlier bundle would explain a style that does not match the source. */
          const cards = Array.from(document.querySelectorAll('.aura-card'));
          const sheets = Array.from(document.styleSheets).length;
          const rules = (() => {
            let total = 0;
            for (const sheet of Array.from(document.styleSheets)) {
              try {
                total += sheet.cssRules.length;
              } catch {
                /* cross-origin sheet */
              }
            }
            return total;
          })();
          /* Who actually paints this element? Walk the live stylesheets and
           * keep the rules that match it and set a background. */
          const winners = [];
          const target = cards[0];
          if (target) {
            for (const sheet of Array.from(document.styleSheets)) {
              let list;
              try {
                list = sheet.cssRules;
              } catch {
                continue;
              }
              for (const rule of Array.from(list || [])) {
                const selector = rule.selectorText;
                const style = rule.style;
                if (!selector || !style || !style.backgroundColor) continue;
                try {
                  if (!target.matches(selector)) continue;
                } catch {
                  continue;
                }
                winners.push({
                  selector: selector.slice(0, 120),
                  color: style.backgroundColor,
                  important: style.getPropertyPriority('background-color') === 'important',
                });
              }
            }
          }

          diag('card_style', {
            paneWidth: paneRef.current ? paneRef.current.clientWidth : -1,
            cards: cards.length,
            sheets,
            rules,
            winners: winners.slice(-6),
            samples: cards.slice(0, 3).map((node) => {
              const style = window.getComputedStyle(node);
              return {
                background: style.backgroundColor,
                backdrop: style.backdropFilter || style.webkitBackdropFilter || '',
                connected: node.isConnected,
              };
            }),
          });
        }, 150);
        const onPointerDown = (event) => {
          const card = cardRef.current;
          if (card && !card.contains(event.target)) setPanelOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setPanelOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [panelOpen]);
      const captureRef = React.useRef(null);

      const choose = React.useCallback((next) => {
        const merged = { ...prefsRef.current, ...next };
        prefsRef.current = merged;
        setPrefs(merged);
        writePrefs(merged);
        /* Deliberately does not close: picking a voice to compare a few of them
         * should not dismiss the panel under the pointer. */
      }, []);

      /** Keep the avatar small: it is stored in localStorage, not on the host. */
      const pickAvatar = React.useCallback(
        (file) => {
          if (!file || !file.type.startsWith('image/')) return;
          const reader = new FileReader();
          reader.onload = () => {
            const image = new Image();
            image.onload = () => {
              try {
                const side = 128;
                const canvas = document.createElement('canvas');
                canvas.width = side;
                canvas.height = side;
                const context = canvas.getContext('2d');
                const scale = Math.max(side / image.width, side / image.height);
                const width = image.width * scale;
                const height = image.height * scale;
                context.drawImage(image, (side - width) / 2, (side - height) / 2, width, height);
                choose({ avatar: canvas.toDataURL('image/png') });
              } catch {
                /* an unreadable image just keeps the old avatar */
              }
            };
            image.src = String(reader.result || '');
          };
          reader.readAsDataURL(file);
        },
        [choose],
      );
      const partialRef = React.useRef({ text: '', at: 0 });
      const voiceRef = React.useRef(null);
      /* capture.py: ControlGate. While the speaker is producing sound, the
       * microphone hears it: drop those frames instead of transcribing an echo,
       * and keep dropping for a moment after it stops, because the tail is
       * still buffered in the input. */
      const gateRef = React.useRef({ active: false, until: 0 });
      const gated = () => {
        const gate = gateRef.current;
        return gate.active || Date.now() < gate.until;
      };
      /* Barge-in needs the frames the gate is dropping, so they are measured
       * here: a voice over the speaker for ~300 ms means "stop talking". */
      /* Measured on this machine: the speaker leaking back sits around 0.05,
       * real speech around 0.16-0.4. The threshold belongs between them. */
      const BARGE_LEVEL = 0.09;
      /* Six frames — about 600 ms — is a word, not a click or a cupboard. */
      const BARGE_FRAMES = 6;
      /* Playback needs a moment to settle before it can be talked over. */
      const BARGE_GUARD_MS = 400;
      /* Both maxima are reported: an open gate shows what the microphone
       * actually hears, a closed one shows what echo cancellation leaves. */
      const bargeRef = React.useRef({
        streak: 0,
        frames: [],
        floor: null,
        probe: 0,
        probeAt: 0,
        all: 0,
        gatedMax: 0,
      });
      const levelRef = React.useRef(0);
      /* Survives a reload: shipping a new bundle reloads the page mid-run, and
       * the reply of that run must still be spoken by the new instance. */
      const SPEAK_KEY = 'dsh-aura.speak-next';
      const readArmed = () => {
        try {
          return window.sessionStorage.getItem(SPEAK_KEY) === '1';
        } catch {
          return false;
        }
      };
      const armSpeak = (armed) => {
        speakNext.current = armed;
        try {
          if (armed) window.sessionStorage.setItem(SPEAK_KEY, '1');
          else window.sessionStorage.removeItem(SPEAK_KEY);
        } catch {
          /* private mode still works within this page */
        }
      };
      const speakNext = React.useRef(readArmed());
      const speakArmedRef = speakNext;
      /* The window still shows the previous reply for a moment after a run
       * ends, so the text from before this turn is captured and the new one is
       * whatever differs from it. */
      const replyBefore = React.useRef('');

      /** Stop playback and let the sphere settle. */
      const stopSpeaking = React.useCallback((options = {}) => {
        const cancel = options.abort !== false;
        /* Only a real cancellation invalidates the request in flight. Bumping
         * the generation on a natural end made the *next* sentence decide it
         * was stale and cancel itself, which is why the voice kept dying one
         * sentence in. */
        if (cancel) {
          speakGeneration.current += 1;
          const abort = speechAbort.current;
          speechAbort.current = null;
          if (abort) {
            try {
              abort.abort();
            } catch {
              /* already settled */
            }
          }
        }
        const playback = voiceRef.current;
        voiceRef.current = null;
        levelRef.current = 0;
        setTalking(false);
        gateRef.current.active = false;
        gateRef.current.until = Date.now() + 300;
        if (!playback) return;
        for (const source of playback.sources || []) {
          try {
            source.onended = null;
            source.stop();
          } catch {
            /* already finished */
          }
        }
        if (playback.frame !== undefined) window.cancelAnimationFrame(playback.frame);
        try {
          playback.audio.close();
        } catch {
          /* already closed */
        }
      }, []);

      /** Speak one reply: whole utterance, metered into the sphere. */
      /* speak() is async, so three segments queued in a row could each find no
       * player yet and build their own: three contexts, three overlapping
       * voices. Serialise them, and stamp each with a generation so a stopped
       * turn's queued work is discarded rather than played. */
      const speakQueue = React.useRef(Promise.resolve());
      const speakGeneration = React.useRef(0);
      /* Set when the user stops the voice — by interrupting, by pressing stop,
       * or by hanging up. Streaming keeps producing sentences, and without this
       * every one of them restarts the voice a second later, which is what
       * "I cannot interrupt it" actually was. */
      /* Silence belongs to a run, not to the conversation: the turn that was
       * interrupted stops speaking, and the next turn speaks normally. */
      const runSeqRef = React.useRef(0);
      const gaggedRef = React.useRef(-1);
      const speechGagged = () => gaggedRef.current === runSeqRef.current;
      /* turns.py: cancelling a turn has to reach the work in flight, not just
       * the player. This aborts the synth request that is still streaming. */
      const speechAbort = React.useRef(null);

      const speakNow = React.useCallback(
        async (text, voice, generation) => {
          const spoken = speechText(text);
          if (!spoken) {
            diag('speak_skipped', { chars: String(text || '').length });
            return;
          }
          if (generation !== speakGeneration.current) return;
          if (speechGagged()) {
            diag('speak_gagged', { chars: spoken.length, run: runSeqRef.current });
            return;
          }
          try {
            diag('tts_request', { chars: spoken.length });
            const controller = new AbortController();
            speechAbort.current = controller;
            const response = await fetch('/aura/tts', {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                text: spoken.slice(0, 2000),
                voice: voice || prefsRef.current.voice,
                model: prefsRef.current.model || MODELS[0].id,
              }),
            });
            if (!response.ok) {
              const failure = await response.json().catch(() => ({}));
              throw new Error(failure.error || 'speech synthesis failed');
            }

            if (generation !== speakGeneration.current) return;
            const rate = Number(response.headers.get('x-aura-sample-rate')) || SAMPLE_RATE;
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) throw new Error('This browser exposes no Web Audio.');
            const existing = voiceRef.current;
            /* Sentences are queued: reuse the player so the next one starts
             * where the last ended instead of cutting it off. */
            const audio = existing ? existing.audio : new AudioCtor({ sampleRate: rate });
            if (audio.state === 'suspended') {
              try {
                await audio.resume();
              } catch {
                /* reported by the beacon below */
              }
            }

            const analyser = existing ? existing.analyser : audio.createAnalyser();
            if (!existing) {
              analyser.fftSize = 512;
              analyser.connect(audio.destination);
            }

            const playback = existing || { audio, analyser, sources: [], frame: undefined, at: 0, pending: 0, finishTimer: undefined };
            const data = new Uint8Array(analyser.fftSize);
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

            /* Play each slice as it lands: the first audio starts as soon as the
             * provider produces it, instead of after the whole reply exists. */
            const schedule = (samples) => {
              if (samples.length === 0 || voiceRef.current !== playback) return;
              const buffer = audio.createBuffer(1, samples.length, rate);
              buffer.copyToChannel(samples, 0);
              const source = audio.createBufferSource();
              source.buffer = buffer;
              source.connect(analyser);
              playback.sources.push(source);
              source.onended = () => {
                playback.sources = playback.sources.filter((item) => item !== source);
                if (voiceRef.current !== playback) return;
                /* The clock can lag a cursor that later sentences moved, which
                 * is how a finished utterance used to stay "speaking" forever.
                 * Decide on an empty queue instead, after a grace period in
                 * which a new sentence may still be appended. */
                if (playback.sources.length > 0 || playback.pending > 0) return;
                window.clearTimeout(playback.finishTimer);
                playback.finishTimer = window.setTimeout(() => {
                  if (voiceRef.current !== playback) return;
                  if (playback.sources.length > 0 || playback.pending > 0) return;
                  diag('play_end');
                  /* Everything was played: this is not a cancellation. */
                  stopSpeaking({ abort: false });
                }, 400);
              };
              source.start(Math.max(playback.at, audio.currentTime));
              playback.at = Math.max(playback.at, audio.currentTime) + samples.length / rate;
            };

            voiceRef.current = playback;
            bargeRef.current.startedAt = Date.now();
            bargeRef.current.streak = 0;
            bargeRef.current.echo = null;
            bargeRef.current.interruptedAt = -1;
            playback.pending += 1;
            window.clearTimeout(playback.finishTimer);
            gateRef.current.active = true;
            setTalking(true);
            if (!existing) playback.frame = window.requestAnimationFrame(meter);
            if (!existing) diag('play_start', { state: audio.state, rate });

            const reader = response.body.getReader();
            let carry = new Uint8Array(0);
            let chunks = 0;
            for (;;) {
              if (speechGagged() || generation !== speakGeneration.current) {
                try {
                  await reader.cancel();
                } catch {
                  /* already closed */
                }
                break;
              }
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              const merged = new Uint8Array(carry.length + value.length);
              merged.set(carry);
              merged.set(value, carry.length);
              const usable = merged.length - (merged.length % 2);
              const samples = new Float32Array(usable / 2);
              for (let index = 0; index < samples.length; index += 1) {
                const low = merged[index * 2];
                const high = merged[index * 2 + 1];
                const sample = (high << 8) | low;
                samples[index] = (sample >= 0x8000 ? sample - 0x10000 : sample) / 32768;
              }
              carry = merged.slice(usable);
              chunks += 1;
              schedule(samples);
            }
            playback.pending = Math.max(0, playback.pending - 1);
            diag('tts_ok', { chunks, pending: playback.pending });
          } catch (failure) {
            const cancelled = failure && (failure.name === 'AbortError' || /aborted/i.test(String(failure.message)));
            if (cancelled) {
              diag('tts_cancelled');
              stopSpeaking({ abort: false });
              return;
            }
            diag('tts_error', { message: String((failure && failure.message) || failure).slice(0, 200) });
            setError(String((failure && failure.message) || failure));
            stopSpeaking({ abort: false });
          }
        },
        [stopSpeaking],
      );

      const speak = React.useCallback(
        (text, voice) => {
          const generation = speakGeneration.current;
          speakQueue.current = speakQueue.current
            .then(() => speakNow(text, voice, generation))
            .catch(() => {});
          return speakQueue.current;
        },
        [speakNow],
      );

      React.useEffect(() => () => stopSpeaking(), [stopSpeaking]);

      /* ---- speaking while the answer is still arriving ------------------- */

      const speechBuffer = React.useRef('');
      const spokeAny = React.useRef(false);

      /** First sentence end, or a hard cut at the segment length. */
      const boundaryIn = (text) => {
        for (let index = 0; index < text.length; index += 1) {
          if ('。！？!?；;\n'.includes(text[index])) return index;
          if (index + 1 >= 60) return index;
        }
        return -1;
      };

      /**
       * Feed one live text delta in and speak whatever segments it completes.
       * The bridge does the same in streaming.py: SpeakableSegments.
       */
      const appendSpeech = React.useCallback(
        (text) => {
          if (!speakNext.current || !text) return;
          speechBuffer.current += text;
          for (;;) {
            const boundary = boundaryIn(speechBuffer.current);
            if (boundary < 0) return;
            const segment = speechBuffer.current.slice(0, boundary + 1).trim();
            speechBuffer.current = speechBuffer.current.slice(boundary + 1);
            if (!segment) continue;
            spokeAny.current = true;
            void speak(segment);
          }
        },
        [speak],
      );

      /* Subscribe to the live tokens while a run we started is in flight. */
      React.useEffect(() => {
        if (!running) return undefined;
        const sessions = services && services.get ? services.get('sessions') : null;
        const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(props.sessionId) : null;
        const source = binding && binding.eventSource;
        if (!source || typeof source.subscribe !== 'function') return undefined;

        let seen = -1;
        const onSnapshot = () => {
          const snapshot = typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
          const entries = (snapshot && snapshot.entries) || [];
          for (const entry of entries) {
            const event = entry && entry.event;
            if (!event || event.type !== 'assistant/live-chunk') continue;
            const seq = typeof event.seq === 'number' ? event.seq : 0;
            if (seen === -1) {
              /* Skip everything that predates this subscription. */
              seen = Math.max(seen, seq);
              continue;
            }
            if (seq <= seen) continue;
            seen = seq;
            const chunk = event.data && event.data.chunk;
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              appendSpeech(chunk.text);
            }
          }
          if (seen === -1) seen = 0;
        };
        const unsubscribe = source.subscribe(onSnapshot);
        onSnapshot();
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [running, appendSpeech, props.sessionId]);

      /**
       * The app has no reload shortcut, so a page can run an old bundle with no
       * way out. Ask the host which version is installed and reload when it
       * differs — the alternative is what happened here: hours of changes that
       * never ran.
       */
      /* The version probe lives at module scope now: see watchForNewVersion. */
      React.useEffect(() => {
        diag('run_watch', { running, was: wasRunning.current, wants: speakNext.current });
        if (running && !wasRunning.current) {
          runSeqRef.current += 1;
          gaggedRef.current = -1;
        }
        if (!running && gaggedRef.current !== -1 && !speakArmedRef.current) {
          /* The turn that was silenced has ended and nothing is armed: the
           * conversation continues normally from here. */
          gaggedRef.current = -1;
        }
        runningRef.current = running;
        if (wasRunning.current && !running) {
          setSettledAt(Date.now() + SETTLED_MS);
          /* A run we started ends here: read its reply and speak it. */
          if (speechGagged() && speakNext.current) {
            armSpeak(false);
            speechBuffer.current = '';
            spokeAny.current = false;
            diag('reply_silenced', { run: runSeqRef.current });
            wasRunning.current = running;
            return;
          }
          if (speakNext.current) {
            armSpeak(false);
            /* Whatever the stream left unfinished is the last sentence. */
            const tail = speechBuffer.current.trim();
            speechBuffer.current = '';
            if (tail) {
              spokeAny.current = true;
              void speak(tail);
            }
            if (spokeAny.current) {
              spokeAny.current = false;
              diag('reply_streamed', { ok: true });
              wasRunning.current = running;
              return;
            }
            /* Nothing streamed: fall back to the finished message. Poll
             * briefly, because the new message can land a moment after the run
             * flips to idle, and speaking the previous reply is worse. */
            const baseline = replyBefore.current;
            const watched = props.sessionId;
            let attempts = 0;
            const take = () => {
              const text = lastAssistantText(watched);
              const fresh = Boolean(text) && text !== baseline;
              diag('reply_ready', { chars: text.length, fresh, attempt: attempts });
              if (fresh) {
                replyBefore.current = text;
                void speak(text);
                return;
              }
              attempts += 1;
              if (attempts < 10) window.setTimeout(take, 200);
            };
            window.setTimeout(take, 120);
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
            /* While a turn is running, a voice input is an interruption, not a
             * message to read after it. */
            /* Interrupting replaces the conversation at once: the new words
             * are the new input, not something queued behind the old turn.
             * Keeping a background task alive across that is the host's
             * business, not this pane's. */
            /* Speaking always stops the voice. Waiting for a barge-in
             * decision here is what let the old answer keep playing under the
             * new turn. */
            if (runningRef.current) gaggedRef.current = runSeqRef.current;
            stopSpeaking();
            const mode = runningRef.current ? 'steer' : 'queue';
            diag('submit_mode', { mode });
            const result = await session.prompt([{ type: 'text', text: trimmed }], mode);
            if (result && result.ok === false) {
              setError((result.error && result.error.message) || 'The session refused the message.');
              return false;
            }
            replyBefore.current = lastAssistantText(props.sessionId);
            /* A new message is a request to be heard again; only the run that
             * was interrupted stays silent. */
            gaggedRef.current = -1;
            armSpeak(true);
            diag('speak_armed', { chars: trimmed.length, before: replyBefore.current.length });
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
      const startCaptureRef = React.useRef(null);

      const startCapture = React.useCallback(async () => {
        captureRef.current = null;
        setError(null);
        setHeard('');
        partialRef.current = { text: '', at: 0 };
        /* Talking over the answer is a request to stop hearing it. */
        if (voiceRef.current) {
          stopSpeaking();
          gateRef.current.until = 0;
        }
        const turn = { socket: null, release: null, started: false };

        const finishTurn = (reason) => {
          diag('turn_finish', { reason });
          /* The clock starts here: waiting for the transcript after "stop" is
           * what can hang, not the length of the utterance. */
          window.setTimeout(() => {
            if (turn.release) turn.release({ error: 'the recognizer did not answer' });
          }, 10000);
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

          const origin = await hostOrigin();
          if (!origin) throw new Error('Cannot reach the host to open the speech socket.');
          const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/aura/asr/live`);
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
            /* On a call the microphone stays open until spoken to; the 4 s
             * "nobody said anything" rule belongs to turn-taking. */
            noSpeechChunks: prefsRef.current.mode === 'chat' ? 600 : NO_SPEECH_CHUNKS,
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
              diag('asr', { chars: text.length, empty: text.length === 0, preview: text.slice(0, 40) });
              if (text) {
                setHeard(text);
                await submitText(text);
              }
            }
            stopCapture();
            /* Continuous mode: after the answer there is no "press to speak"
             * again; the microphone returns by itself. */
            if (prefsRef.current.mode === 'chat') {
              window.setTimeout(() => {
                if (!captureRef.current) void startCaptureRef.current();
              }, 400);
            }
          });

          /* The socket needs a round trip before it accepts audio, and the user
           * may already be speaking: hold the first frames instead of dropping
           * them, and flush the moment the turn starts. */
          let handshakeFrames = [];
          const flushHandshake = () => {
            if (handshakeFrames.length === 0) return;
            const held = handshakeFrames;
            handshakeFrames = [];
            for (const frame of held) vad.push(frame);
          };

          node.port.onmessage = (event) => {
            if (!turn.started) {
              handshakeFrames.push(event.data);
              if (handshakeFrames.length > 12) handshakeFrames.shift();
              return;
            }
            flushHandshake();
            if (gated()) {
              /* Keep the last second of audio so an interruption is
               * transcribed from its beginning, not from its middle. */
              const recent = bargeRef.current.frames;
              recent.push(event.data);
              if (recent.length > 10) recent.shift();
              const state = bargeRef.current;
              const level = levelOfFrame(event.data);

              /* The first frames of playback measure the speaker leaking back
               * into the microphone; that becomes the reference a real voice
               * has to beat. */
              /* Average, not maximum: the leak follows the voice, and its peak is
               * as loud as a person. The mean sits well below speech, which is
               * what makes speech detectable at all. */
              state.echo = state.echo === null || state.echo === undefined
                ? level
                : state.echo * 0.9 + level * 0.1;
              state.all = Math.max(state.all, level);
              /* The threshold follows the room: an air conditioner or a fan is
               * not an interruption, a voice over it is. */
              /* A noise floor tracks the room, not the person: learning from
               * speech is what once pushed the threshold to 0.45 and made
               * interrupting impossible. Quiet follows down quickly; anything
               * above the current floor is ignored. */
              if (state.floor === null) state.floor = level;
              else if (level < state.floor) state.floor = state.floor * 0.7 + level * 0.3;
              else state.floor = state.floor * 0.995 + level * 0.005;
              /* Room tone, its own speaker, and an absolute floor: the noisiest
               * of the three decides what counts as a voice. */
              const threshold = Math.max(BARGE_LEVEL, state.floor * 4, (state.echo || 0) * 1.5);
              /* Nothing below the loudest leak plus a margin can be a voice. */
              const settled = Date.now() - (state.startedAt || 0) > BARGE_GUARD_MS;
              state.streak = settled && level > threshold ? state.streak + 1 : 0;
              if (level > state.probe) state.probe = level;
              state.gatedMax = Math.max(state.gatedMax || 0, level);
              if (Date.now() - state.probeAt > 3000) {
                diag('mic_level', {
                  gated: Number((state.gatedMax || 0).toFixed(3)),
                  floor: Number(state.floor.toFixed(3)),
                  echo: Number((state.echo || 0).toFixed(3)),
                  threshold: Number(threshold.toFixed(3)),
                  guard: Date.now() - (state.startedAt || 0) < BARGE_GUARD_MS,
                });
                state.gatedMax = 0;
                state.probeAt = Date.now();
              }
              /* Once per burst: after a trigger the microphone has to fall
               * quiet for a while before the same utterance can interrupt
               * again. */
              const cooled =
                state.lastBargeAt === undefined || Date.now() - state.lastBargeAt > 1200;
              const already = !cooled;
              if (state.streak >= BARGE_FRAMES && !already) {
                state.lastBargeAt = Date.now();
                diag('barge_in', {
                  level: Number(level.toFixed(3)),
                  floor: Number(state.floor.toFixed(3)),
                  threshold: Number(threshold.toFixed(3)),
                });
                bargeRef.current.streak = 0;
                gateRef.current.active = false;
                gateRef.current.until = 0;
                gaggedRef.current = runSeqRef.current;
                stopSpeaking();
                /* The buffered frames are the speaker leaking back, not the
                 * person: feeding them to the recognizer is what made later
                 * transcripts contain the assistant voice. Discard them and
                 * accept that the first syllable may be cut. */
                /* Keep a short pre-roll: the first syllable usually starts
                 * just before the level crosses the threshold, and 400 ms is
                 * short enough not to carry much of the speaker with it. */
                for (const frame of recent.slice(-4)) vad.push(frame);
                recent.length = 0;
              }
              return;
            }
            bargeRef.current.frames.length = 0;
            bargeRef.current.streak = 0;
            bargeRef.current.all = Math.max(bargeRef.current.all || 0, levelOfFrame(event.data));
            vad.push(event.data);
          };
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
      startCaptureRef.current = startCapture;

      const toggleMic = React.useCallback(() => {
        if (captureRef.current) stopCapture();
        else void startCapture();
      }, [startCapture, stopCapture]);

      /**
       * A call is a mode you enter, not a setting you flip: it turns the
       * session continuous (the microphone comes back by itself) and it ends
       * when you hang up, which returns to turn-taking.
       */
      const callActive = (prefs.mode || 'talk') === 'chat';
      const toggleCall = React.useCallback(() => {
        if (callActive) {
          choose({ mode: 'talk' });
          if (captureRef.current) stopCapture();
          gaggedRef.current = runSeqRef.current;
          stopSpeaking();
        } else {
          choose({ mode: 'chat' });
          if (!captureRef.current) void startCapture();
        }
      }, [callActive, choose, startCapture, stopCapture, stopSpeaking]);

      return h(
        'div',
        { style: PANE, 'data-aura-phase': phase, ref: paneRef },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'aura-top' },
          h(
            'button',
            {
              type: 'button',
              className: 'aura-chip',
              title: 'Aura',
              'aria-label': 'Aura profile',
              'aria-expanded': String(panelOpen),
              onClick: () => setPanelOpen((open) => !open),
            },
            prefs.avatar
              ? h('img', { className: 'aura-ava', src: prefs.avatar, alt: '' })
              : h('span', { className: 'aura-ava-fallback' }, 'A'),
            h('span', { className: 'aura-chip-text' }, 'Aura'),
          ),
        ),
        panelOpen
          ? h(
              'div',
              { className: 'aura-card', ref: cardRef, role: 'group', 'aria-label': 'Aura settings' },
              h(
                'div',
                { className: 'aura-id' },
                prefs.avatar
                  ? h('img', { src: prefs.avatar, alt: '' })
                  : h('span', { className: 'aura-ava-fallback' }, 'A'),
                h(
                  'div',
                  null,
                  h('div', { className: 'aura-name' }, 'Aura'),
                  h('div', { className: 'aura-sub' }, `v${AURA_VERSION} · ${phase}`),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'aura-close',
                    title: 'Close',
                    'aria-label': 'Close Aura profile',
                    onClick: () => setPanelOpen(false),
                  },
                  '✕',
                ),
              ),
              h('div', { className: 'aura-rule' }),
              h(
                'div',
                null,
                h('div', { className: 'aura-cap' }, '模型'),
                h(
                  'div',
                  { className: 'aura-models' },
                  ...MODELS.map((entry) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: entry.id,
                        className: 'aura-model',
                        'data-on': String((prefs.model || MODELS[0].id) === entry.id),
                        title: `${entry.id} · ${entry.note}`,
                        onClick: () => choose({ model: entry.id }),
                      },
                      entry.name,
                    ),
                  ),
                ),
                h('div', { className: 'aura-cap' }, '声音'),
                h('div', { className: 'aura-voices' },
                ...VOICES.map((voice) =>
                  h(
                    'div',
                    {
                      className: 'aura-row',
                      key: voice.id,
                      'data-on': String(prefs.voice === voice.id),
                      onClick: () => choose({ voice: voice.id }),
                    },
                    h('span', { className: 'aura-dot' }),
                    h(
                      'span',
                      { className: 'aura-label' },
                      voice.name,
                      voice.note ? h('span', { className: 'aura-tag' }, voice.note) : null,
                      h('span', { className: 'aura-trait' }, voice.trait),
                      h('span', { className: 'aura-id-mono' }, voice.id),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'aura-act',
                        title: `Preview ${voice.id}`,
                        'aria-label': `Preview ${voice.id}`,
                        onClick: (event) => {
                          event.stopPropagation();
                          void speak('你好，我是 Aura。现在可以听到我说话。', voice.id);
                        },
                      },
                      '试听',
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'aura-row aura-stack' },
                  h('span', { className: 'aura-dot', style: { opacity: 0 } }),
                  h('input', {
                    className: 'aura-field',
                    value: customVoice,
                    placeholder: '自定义 voice id',
                    'aria-label': 'Custom voice id',
                    onChange: (event) => setCustomVoice(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && /^[A-Za-z0-9_.-]{1,64}$/.test(customVoice.trim())) {
                        choose({ voice: customVoice.trim() });
                      }
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'aura-act',
                      disabled: !/^[A-Za-z0-9_.-]{1,64}$/.test(customVoice.trim()),
                      onClick: () => choose({ voice: customVoice.trim() }),
                    },
                    '使用',
                  ),
                ),
              ),
              ),
              h('div', { className: 'aura-rule' }),
              h(
                'div',
                null,
                h('div', { className: 'aura-cap' }, '头像'),
                h(
                  'div',
                  { className: 'aura-row aura-stack' },
                  h('span', { className: 'aura-dot', style: { opacity: 0 } }),
                  h('label', { className: 'aura-label', style: { cursor: 'pointer' } },
                    '上传图片',
                    h('span', { className: 'aura-id-mono' }, '自动裁成 128×128，只存本机'),
                    h('input', {
                      type: 'file',
                      accept: 'image/*',
                      'aria-label': 'Upload an avatar',
                      style: { display: 'none' },
                      onChange: (event) => {
                        const file = event.target.files && event.target.files[0];
                        if (file) pickAvatar(file);
                      },
                    }),
                  ),
                  prefs.avatar
                    ? h(
                        'button',
                        { type: 'button', className: 'aura-act', onClick: () => choose({ avatar: '' }) },
                        '清除',
                      )
                    : null,
                ),
              ),
              h('div', { className: 'aura-rule' }),
              h(
                'div',
                { className: 'aura-foot' },
                h('span', null, `v${AURA_VERSION}`),
                h(
                  'button',
                  {
                    type: 'button',
                    title: 'Force reload',
                    'aria-label': 'Force reload',
                    onClick: () => window.location.reload(),
                  },
                  '⟳ 刷新',
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: STAGE, role: 'img', 'aria-label': `Aura ${phase}` },
          h('canvas', { ref: canvasRef, style: CANVAS }),
          h(
            'button',
            {
              type: 'button',
              className: 'aura-call',
              'data-active': String(callActive),
              title: callActive ? '挂断' : '通话',
              'aria-label': callActive ? 'End call' : 'Start call',
              'aria-pressed': String(callActive),
              onClick: toggleCall,
            },
            callActive ? h(HangupIcon, null) : h(PhoneIcon, null),
          ),
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
                className: 'aura-icon-btn aura-mic',
                'data-listening': String(listening),
              style: listening ? { ...BUTTON, ...BUTTON_ACTIVE } : BUTTON,
                title: `${listening ? 'Stop listening' : 'Speak'} · ${AURA_VERSION}`,
                'aria-label': listening ? 'Stop listening' : 'Start listening',
                onClick: toggleMic,
              },
              listening ? h(StopIcon, null) : h(MicIcon, null),
            ),
            h(
              'button',
              {
                type: 'button',
                className: "aura-icon-btn",
                style: BUTTON,
                title: 'Send',
                'aria-label': 'Send',
                disabled: busy || draft.trim() === '',
                onClick: send,
              },
              h(SendIcon, null),
            ),
            (running || talking)
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'aura-icon-btn',
                    style: BUTTON,
                    title: '静音',
                    'aria-label': 'Silence',
                    onClick: () => {
                      /* Stop the voice. Whether the work is cancelled is a
                       * separate decision, so it is not made here. */
                      gaggedRef.current = runSeqRef.current;
                      stopSpeaking();
                    },
                  },
                  h(HaltIcon, null),
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
      return h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'baseline' } },
        'Aura',
        h('span', { style: VERSION_LABEL }, AURA_VERSION),
      );
    }

    /** A microphone drawn here, so its size is not up to an emoji font. */
    const MicIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
        h('path', { d: 'M5 11a7 7 0 0 0 14 0' }),
        h('line', { x1: 12, y1: 18, x2: 12, y2: 21 }),
      );

    /** Start a call: an ordinary handset. */
    const PhoneIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 22,
          height: 22,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z',
        }),
      );

    /** End a call: the same handset, hung up. */
    const HangupIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 22,
          height: 22,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', transform: 'rotate(135deg)' },
        },
        h('path', {
          d: 'M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z',
        }),
      );

    /** Send: an arrow, drawn like the other two instead of a keyboard glyph. */
    const SendIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d: 'M12 19V5' }),
        h('path', { d: 'm5 12 7-7 7 7' }),
      );

    /** The listening state: a filled square, the usual "stop" shape. */
    const StopIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 3, fill: 'currentColor' }),
      );

    /** Stop the running turn: a square in a ring, so it never reads as the
     * microphone's bare recording square. */
    const HaltIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 17,
          height: 17,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('circle', { cx: 12, cy: 12, r: 8.5, opacity: 0.55 }),
        h('rect', { x: 8.6, y: 8.6, width: 6.8, height: 6.8, rx: 1.6, fill: 'currentColor', stroke: 'none' }),
      );

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
        /* Before anything can throw: the recovery probe must not depend on the
         * pane rendering successfully. */
        watchForNewVersion();
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

