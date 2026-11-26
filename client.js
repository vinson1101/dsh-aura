/**
 * dsh-aura — browser half: a presence docked in the right sidebar.
 *
 * The presence owns the state — phase now, voice later — and a form only renders
 * it. A form implements
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
    // Each replacement needs its own scope. A top-level const breaks the next
    // classic-script load with a global lexical redeclaration error.
    const AURA_VERSION = '0.35.4-visual.6';
    diag('factory');
    /* A reload replaces this module but not the running audio graph: stop the
     * capture the previous instance left holding the microphone. */
    try {
      const stale = window.__auraCapture;
      if (stale) {
        diag('mic_stale', { id: stale.id || 0 });
        if (stale.stream) for (const track of stale.stream.getTracks()) track.stop();
        if (stale.audio && typeof stale.audio.close === 'function') stale.audio.close();
      }
    } catch {
      /* nothing to clean up */
    }
    window.__auraCapture = null;
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
      /* Keep numeric answers, but skip standalone dotted versions and separators. */
      if (han === 0 && latin === 0 && (!/\p{Nd}/u.test(prose) || /^\d+(?:\.\d+){2,}$/.test(prose))) return '';
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
    /** The one live capture, with a number so the beacons can be paired. */
    const liveCapture = { current: null, seq: 0, opening: false };

    /** Letters and digits only: punctuation and spaces differ between rounds. */
    function bare(text) {
      return String(text || '').replace(/[^\p{L}\p{N}]/gu, '');
    }

    /**
     * Does this transcript come from our own speech?
     *
     * A partial of our own voice is a fragment of what we are saying, so it is
     * contained in it. A person's words are not — that is the whole test.
     */
    function fromOurVoice(transcript, spoken) {
      const heard = bare(transcript);
      const said = bare(spoken);
      if (!heard) return true;
      if (!said) return false;
      // Even a one-character prefix can be echo. Wait for words that differ
      // rather than interrupting ourselves on the first short partial.
      return said.includes(heard); // A common suffix alone never vetoes a new sentence.
    }

    // Playback-clock references, not synthesis requests. No text is retained
    // across cancellation; natural decay lasts at most 180 ms. PCM has no word
    // alignment, so the reference granularity is one currently playing utterance.
    function createPlaybackReference() {
      let spans = [];
      return {
        add(audio, start, end, text, turn) {
          spans = spans.filter(s => s.audio === audio && s.end + 0.18 >= audio.currentTime);
          const last = spans[spans.length - 1];
          if (last && last.audio === audio && last.text === text && last.turn === turn && start <= last.end + 0.01) last.end = end;
          else spans.push({ audio, start, end, text, turn });
          spans = spans.slice(-8);
        },
        read() {
          spans = spans.filter(s => s.audio.state !== 'closed' && s.audio.currentTime <= s.end + 0.18);
          return spans.filter(s => s.audio.state === 'running' && s.audio.currentTime >= s.start)
            .map(s => s.text).join(' ');
        },
        clear() { spans = []; },
      };
    }

    // Raw mono Float32 samples, at AudioContext.sampleRate (not wire blocks).
    // Eight seconds is a bounded safety budget, NOT a measured network latency.
    // Overflow is fatal/visible, never silently submit a truncated sentence.
    function createSampleQueue(rate, maxMs = 8000) {
      const limit = Math.ceil(rate * maxMs / 1000);
      let frames = [], samples = 0, next = 0, delivered = 0, dropped = 0;
      return {
        push(data) {
          const start = next; next += data.length;
          if (samples + data.length > limit) { dropped += data.length; return false; }
          frames.push({ start, data: data.slice() }); samples += data.length;
          return true;
        },
        drain(feed) {
          const held = frames; frames = []; samples = 0;
          for (const frame of held) { feed(frame.data); delivered += frame.data.length; }
        },
        stats() { return { rate, next, delivered, dropped, held: samples, maxMs }; },
      };
    }

    // Bounded, text-free local evidence. Never sends microphone PCM or captions.
    function voiceTrace(stage, fields = {}) {
      const rows = window.__auraVoiceTrace || (window.__auraVoiceTrace = []);
      rows.push({ stage, at: Date.now(), ...fields });
      if (rows.length > 160) rows.shift();
    }

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
    // Digital-human mode uses one static image, not the legacy face atlas canvas.
    const FORMS = { orb: { mount: mountOrb } };

    /* ---- presence ------------------------------------------------------- */

    /** How long a settled run keeps the presence green. */
    const SETTLED_MS = 3500;

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
     * Single-reply waits for speech separately from the audio block clock.
     */
    const CHUNK_MS = 100;
    const CHUNK_SIZE = (SAMPLE_RATE * CHUNK_MS) / 1000;
    /** A short pause ends the turn only when the transcript looks finished. */
    const QUIET_CHUNKS = 9;
    /** Otherwise a real pause still wins, just later. */
    const LONG_QUIET_CHUNKS = 20;
    const SINGLE_NO_SPEECH_MS = 30000;
    /** How long a loud sound must last before it counts as somebody speaking. */
    const ONSET_CHUNKS = 3;
    /** Streaming grows nothing per chunk, so a long dictation is allowed. */
    const MAX_CHUNKS = 600;
    const THRESHOLD_FLOOR = 450;
    const THRESHOLD_FACTOR = 1.65;
    const PEAK_DECAY = 0.975;
    const FLOOR_DECAY = 0.8;
    const NOISE_CEILING = 850;

    function createVad({ onChunk, onEnd, onSpeech, isComplete, noSpeechChunks }) {
      let carry = new Float32Array(0);
      let chunks = 0;
      let speech = false;
      /** Consecutive chunks above the threshold, before speech is declared. */
      let voiced = 0;
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

      function end(reason, elapsedMs = chunks * CHUNK_MS) {
        if (done) return;
        done = true;
        onEnd(reason, speech, elapsedMs);
      }

      function take(block) {
        const level = levelOf(block);
        peak = Math.max(level, peak * PEAK_DECAY);
        if (floor === null) floor = Math.min(level, NOISE_CEILING);
        const threshold = Math.max(THRESHOLD_FLOOR, floor * THRESHOLD_FACTOR);
        if (level >= threshold) {
          voiced += 1;
          /* A knock is loud for one chunk; a word is loud for several. */
          if (!speech && voiced >= ONSET_CHUNKS) {
            speech = true;
            onSpeech();
          }
          quiet = 0;
        } else {
          voiced = 0;
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
        get speech() { return speech; },
        push(samples) {
          if (done) return samples;
          let data = samples;
          if (carry.length) {
            const merged = new Float32Array(carry.length + data.length);
            merged.set(carry);
            merged.set(data, carry.length);
            data = merged;
          }
          let offset = 0;
          while (!done && data.length - offset >= CHUNK_SIZE) {
            take(data.subarray(offset, offset + CHUNK_SIZE));
            offset += CHUNK_SIZE;
          }
          carry = data.slice(offset);
          if (done) { const tail = carry; carry = new Float32Array(0); return tail; }
          return null;
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
          // A call is live resource state, never a persisted preference.
          // Ignore legacy mode:'chat': no microphone survives a remount/restart.
          mode: 'talk',
          character: parsed.character === true,
          avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
        };
      } catch {
        return { voice: VOICES[0].id, avatar: '', model: MODELS[0].id, mode: MODES[0].id };
      }
    }

    function writePrefs(next) {
      try {
        const { mode, ...preferences } = next;
        window.localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
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
    function lastAssistantText(sessionId, withEvent = false, acceptedDispatchCalls) {
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
        if (acceptedDispatchCalls) {
          if (event.data?.interrupted) continue;
          const calls = blocks.filter(block => block?.type === 'tool-call');
          // A durable Aura dispatch confirmation can share a message with the tool call.
          if (calls.length && (!Number.isInteger(event.data?.turn)
            || !calls.every(block => block.name === 'aura_task')
            || !calls.some(block => acceptedDispatchCalls.get(block.id) === event.data.turn))) continue;
        }
        const text = blocks
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) return withEvent ? { text, event } : text;
      }
      return '';
    }

    const PANE = {
      height: '100%',
      minHeight: 0,
      display: 'grid',
      gridTemplateRows: 'auto minmax(0, 1fr) auto auto',
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
      /* Only this pane changes its palette; removing the class restores orb/theme. */
      .aura-character { isolation: isolate; color: #f5f4f6;
        --dsw-alias-text-primary: #f5f4f6; --dsw-alias-text-secondary: #e4e1e6;
        --dsw-alias-bg-layer-2: rgba(25,23,29,.28); }
      .aura-character textarea { background: rgba(25,23,29,.28) !important; color: #f5f4f6 !important; }
      .aura-character textarea::placeholder { color: #ddd8e0; }
      .aura-character .aura-id-mono { opacity: .8; text-shadow: 0 1px 3px #222; }
      .aura-status { min-width: 0; line-height: 1.4; overflow-wrap: anywhere; }
      .aura-preparation-detail { font-variant-numeric: tabular-nums; }
      /* Beside the orb, not in a settings panel: a call is an action. */
      .aura-actions { position: absolute; right: 4px; bottom: 4px; display: grid; gap: 6px; justify-items: end; }
      .aura-actions-menu { position: absolute; right: 60px; bottom: 0; display: grid; gap: 4px;
        width: min(162px, calc(100cqw - 82px)); max-height: min(255px, 100cqh); overflow: auto;
        padding: 6px; box-sizing: border-box; z-index: 3; border-radius: 10px;
        border: 1px solid rgba(160,170,190,.28); background: var(--dsw-alias-bg-base, #25232a);
        color: var(--dsw-alias-text-primary, inherit); }
      .aura-character .aura-actions-menu { background: #25232a; color: #f5f4f6; }
      .aura-actions-menu .aura-act { display: grid; height: auto; min-height: 28px; text-align: left; padding: 4px 6px; }
      .aura-actions-menu .aura-act:disabled { opacity: .72; }
      .aura-actions-menu small { font-size: 10px; white-space: normal; }
      .aura-call { width: 52px; height: 52px;
        display: grid; place-items: center; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(160,170,190,.28); background: rgba(120,132,152,.22);
        color: inherit; backdrop-filter: blur(10px);
        transition: background .15s ease, border-color .15s ease, transform .15s ease; }
      .aura-call:hover { background: rgba(120,132,152,.34); transform: scale(1.04); }
      .aura-interactions { width: 52px; min-height: 28px; font: inherit; font-size: 12px; }
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
    const PREPARATION_STAGES = {
      preflight: '检查本地环境', tts: '生成当前女声', 'loading-models': '加载口型模型',
      uploading: '发送当前语音', queued: '等待 QuickTalk', downloading: '接收本次音画',
      rendering: '生成口型音画', muxing: '合并本次音画', validating: '校验完整音画',
      ready: '音画就绪等待播放', '等待音画播放器就绪': '音画就绪等待播放（等待播放器就绪）',
    };
    const STAGE = {
      width: '100%',
      height: '100%',
      minHeight: 0,
      minWidth: 0,
      display: 'grid',
      placeItems: 'center',
      position: 'relative',
      overflow: 'hidden',
    };
    /* No size here: the form writes both CSS sides and the backing store. */
    const CANVAS = { display: 'block' };
    // Sampled from the approved PNG's empty top/left/right background only.
    // No enlarged/blurred copy (and thus no second face) behind the subject.
    const CHARACTER_SURROUND = {
      position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: -1,
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      minHeight: 0, overflow: 'hidden',
      background: 'linear-gradient(110deg, rgb(64,62,67), rgb(65,62,67) 50%, rgb(68,66,71))',
    };
    const CHARACTER_IMAGE = {
      display: 'block', width: 'auto', height: 'auto',
      maxWidth: '100%', maxHeight: '100%', minWidth: 0, minHeight: 0,
      flex: '0 0 auto', objectFit: 'contain', objectPosition: 'center top',
      // Only the outside 8px blends into sampled colour; never blur hair/face.
      maskImage: 'linear-gradient(to right, transparent, #000 8px, #000 calc(100% - 8px), transparent), linear-gradient(transparent, #000 8px, #000 calc(100% - 8px), transparent)',
      maskComposite: 'intersect',
    };
    const MANUAL_ACTIONS = [['side', '转侧身'], ['lean', '探镜头'], ['heart', '比爱心'], ['wave', '招手'], ['smile', '微笑']];
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

    /** The Host, not a page-global flag, owns the one runtime-wide Aura seat. */
    function InstancePane(props) {
      const [state, setState] = React.useState({ kind: 'opening' });
      const [retry, setRetry] = React.useState(0);
      React.useEffect(() => {
        let disposed = false, socket = null, terminal = false;
        let lastSeen = Date.now(), timeoutMs = 12000, configurationPending = false;
        const listeners = new Set(), summaryListeners = new Set();
        // Deliberately exclude transport URLs, credentials and CloseEvent.reason.
        const instanceState = () => ({ sessionId: typeof props.sessionId === 'string' ? props.sessionId : '',
          readyState: Number.isInteger(socket?.readyState) ? socket.readyState : null,
          hidden: document.hidden === true });
        const access = {
          onSummary(fn) { summaryListeners.add(fn); return () => summaryListeners.delete(fn); },
          token: '', revoked: true,
          active: () => !disposed && !access.revoked && Date.now() - lastSeen < timeoutMs,
          subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
          revoke() { access.revoked = true; for (const fn of listeners) fn(); },
          // Config persistence restarts this plugin. Keep its result outside
          // Pane, which may unmount before the POST acknowledgement arrives.
          configurationPending() { configurationPending = true; },
          configurationSaved() {
            if (disposed) return;
            configurationPending = false; terminal = true;
            access.revoke();
            setState({ kind: 'restart', message: '本地回复生成配置已保存。Aura 已重启，请重新打开 Aura；新状态将在打开设置后读取。' });
            socket?.close();
          },
          configurationFailed(message) {
            configurationPending = false;
            if (!disposed && terminal) setState({ kind: 'error', message: `配置保存未确认：${message}。请重新打开 Aura 后核实状态。` });
          },
        };
        const fail = message => {
          if (configurationPending) message = '配置保存期间 Aura 连接已断开，保存结果尚未确认。请重新打开 Aura 后核实本地回复生成状态。';
          access.revoke();
          if (!disposed && !terminal) { terminal = true; setState({ kind: 'error', message }); }
        };
        setState({ kind: 'opening' });
        void (async () => {
          try {
            if (!props.sessionId) throw new Error('请先选择一个会话。');
            const origin = await hostOrigin();
            if (disposed) return;
            if (!origin) throw new Error('无法连接 Aura Host。');
            socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/aura/instance?sessionId=${encodeURIComponent(props.sessionId)}`);
            socket.onmessage = event => {
              if (disposed || terminal) return;
              let message;
              try { message = JSON.parse(String(event.data)); } catch { return; }
              if (message.type === 'busy') {
                terminal = true;
                access.revoke();
                diag('instance_busy', { sessionId: props.sessionId, owner: message.sessionId });
                setState({ kind: 'busy', sessionId: message.sessionId });
              } else if (message.type === 'owned') {
                access.token = message.token;
                access.revoked = false;
                lastSeen = Date.now();
                timeoutMs = message.timeoutMs || 12000;
                diag('instance_owned', { sessionId: props.sessionId });
                setState({ kind: 'owned', access });
              } else if (message.type === 'heartbeat') lastSeen = Date.now();
              else if (message.type === 'task-summary' && message.sessionId === props.sessionId && access.active()) {
                for (const fn of summaryListeners) fn(message);
              }
            };
            socket.onerror = () => {
              diag('instance_error', instanceState());
              fail('Aura 连接失败，请重新打开。');
            };
            socket.onclose = event => {
              diag('instance_close', { ...instanceState(),
                code: Number.isInteger(event?.code) ? event.code : null,
                wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null });
              fail('Aura 连接已断开，通话已结束。后台任务仍独立运行。');
            };
          } catch (error) {
            diag('instance_error', instanceState());
            fail(String(error?.message || error));
          }
        })();
        const timer = window.setInterval(() => {
          if (disposed || terminal) return;
          if (Date.now() - lastSeen >= timeoutMs) {
            diag('instance_timeout', instanceState());
            fail('Aura 连接超时，通话已结束。请重新打开。');
            socket?.close();
          } else if (socket?.readyState === 1) socket.send('heartbeat');
        }, 1000);
        return () => {
          diag('instance_cleanup', instanceState());
          disposed = true;
          access.revoke();
          window.clearInterval(timer);
          if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
        };
      }, [props.sessionId, retry]);
      if (state.kind === 'owned') return h(Pane, { ...props, access: state.access });
      return h('div', { style: PANE, role: 'status', 'data-aura-instance': state.kind },
        h('h3', null, 'Aura'),
        h('p', null, state.kind === 'opening' ? '正在连接 Aura…' : state.kind === 'busy'
          ? '此 runtime 已有一个 Aura 实例。请使用原面板；关闭原面板后，可在这里重新打开。'
          : state.message),
        state.kind !== 'opening' && h('button', { type: 'button', onClick: () => setRetry(n => n + 1) }, '重新打开'),
        h('p', null, '一个 runtime，一个 Aura。跨会话任务独立执行。'));
    }

    /** One render job per complete reply. The POST receipt is always observed,
     * even after cancellation, so an accepted-but-late job is DELETEd as well. */
    function createVisualPreparation({ access, request = fetch, clock = window, onStatus, diagnostic = () => {},
      supportsStream = mime => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime) }) {
      let serial = 0, current = null;
      const remove = (job, reason = 'inactive-access') => {
        if (!job.id || job.deleted) return;
        job.deleted = true;
        diagnostic('visual_cancel', { jobId: job.id, reason: job.cancelReason || reason });
        void request(`/aura/visual?id=${encodeURIComponent(job.id)}`, {
          method: 'DELETE', headers: { 'x-aura-instance': access.token }, keepalive: true,
        }).catch(() => {});
      };
      const cancel = (reason = 'explicit-cancel') => {
        serial++;
        const job = current; current = null;
        if (!job) return;
        job.cancelReason = reason;
        job.controller.abort();
        clock.clearTimeout(job.timer);
        job.wake?.(); job.wake = null;
        remove(job);
      };
      return {
        cancel,
        async prepare(body) {
          cancel('replaced');
          if (!access.active()) return null;
          const ticket = serial;
          const job = { controller: new AbortController(), id: null, timer: 0, deleted: false, phase: 'post' };
          let pollFailures = 0;
          current = job;
          const active = () => current === job && ticket === serial && access.active();
          const status = value => { if (active()) onStatus(value); };
          try {
            status({ state: 'preparing', stage: '提交当前回复', elapsedSeconds: 0 });
            // Do not abort this small allocation request: observe its id and
            // revoke a late receipt instead of orphaning expensive inference.
            let response = await request('/aura/visual', {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-aura-instance': access.token },
              body: JSON.stringify(body),
            });
            let value = await response.json();
            job.id = value.id;
            if (!active()) { remove(job); return null; }
            for (;;) {
              if (!response.ok) throw new Error(value.error || '数字人准备请求失败');
              status(value);
              if (value.streamUrl && value.streamMime && supportsStream(value.streamMime)
                && ['preparing', 'ready'].includes(value.state)) return value;
              if (value.state === 'ready') {
                if (!value.mediaUrl) throw new Error('数字人结果缺少音画地址');
                return { ...value, streamUrl: undefined, streamMime: undefined };
              }
              if (value.state === 'failed' || value.state === 'cancelled') throw new Error(value.error || `数字人任务 ${value.state}`);
              if (value.state !== 'preparing' || !job.id) throw new Error('数字人准备状态无效');
              await new Promise(resolve => {
                job.wake = resolve;
                job.timer = clock.setTimeout(() => { job.wake = null; resolve(); }, 250);
              });
              if (!active()) { remove(job); return null; }
              job.phase = 'poll';
              try {
                const next = await request(`/aura/visual?id=${encodeURIComponent(job.id)}`, {
                  headers: { 'x-aura-instance': access.token }, signal: job.controller.signal, cache: 'no-store',
                });
                if (next.status >= 500 && next.status <= 599) throw Object.assign(new Error('数字人状态连接暂时中断'), { transient: true });
                const nextValue = await next.json();
                response = next; value = nextValue; pollFailures = 0;
              } catch (error) {
                if (active() && (error?.name === 'TypeError' || error?.transient) && ++pollFailures <= 3) {
                  diagnostic('visual_poll_retry', { jobId: job.id, attempt: pollFailures });
                  status({ ...value, stage: '连接暂时中断，正在重连当前任务' });
                  continue; // Re-poll the SAME job; never repeat allocation/TTS/inference.
                }
                throw error;
              }
              if (!active()) { remove(job); return null; }
            }
          } catch (error) {
            remove(job, `${job.phase}-error`);
            if (!active() || error?.name === 'AbortError') return null;
            throw error;
          }
        },
      };
    }

    /** Silent front and idle layers preserve the last frame while the next clip decodes. */
    function SingleCharacter({ stage, sessionId, control, onInteractionError }) {
      const surround = React.useRef(null);
      const still = React.useRef(null);
      const media = React.useRef(null);
      const idleMedia = React.useRef(null);
      const replyMedia = React.useRef(null);
      const player = React.useRef(null);
      const [needsPlay, setNeedsPlay] = React.useState(false);
      const desired = React.useRef(stage);
      desired.current = stage;
      React.useEffect(() => {
        let disposed = false, serial = 0, kind = '', idleTimer = 0, loadTimer = 0;
        let assetAbort = null, frameCallback = 0, downloadTimer = 0;
        let returnTimer = 0, fadeTimer = 0, fading = null;
        let playCurrent = null, watchReadiness = null, playSerial = 0;
        let answer = null, lastStage = desired.current, activated = false;
        let lastIdle = '', lastWave = -Infinity;
        let assets = null, catalogRequest, pendingManual = null;
        const catalog = new AbortController();
        const node = surround.current, image = still.current;
        const standby = media.current, idleVideo = idleMedia.current, replyVideo = replyMedia.current;
        const urls = new Map();
        let video = standby, visible = null;
        const mediaState = () => ({ readyState: video.readyState, networkState: video.networkState,
          mediaError: video.error?.code || 0, mediaMessage: String(video.error?.message || '').slice(0, 180),
          paused: video.paused, time: video.currentTime, duration: video.duration,
          muted: video.muted, volume: video.volume, width: video.videoWidth, height: video.videoHeight,
          hidden: document.hidden });
        diag('character_support', { sessionId, protocol: window.location.protocol,
          h264: video.canPlayType?.('video/mp4; codecs="avc1.64001F"'),
          vp9: video.canPlayType?.('video/webm; codecs="vp9"') });
        const idle = () => activated && !['initial', 'opening', 'listening', 'speaking'].includes(desired.current) && !answer;
        const clearIdle = () => { window.clearTimeout(idleTimer); idleTimer = 0; };
        const resetMedia = target => {
          if (target.hasAttribute('src')) { target.pause(); target.removeAttribute('src'); target.load(); }
          target.muted = true; target.style.opacity = '0';
          if (urls.has(target)) { URL.revokeObjectURL(urls.get(target)); urls.delete(target); }
        };
        const stopPending = () => {
          window.clearTimeout(returnTimer); returnTimer = 0;
          window.clearTimeout(fadeTimer); fadeTimer = 0;
          if (fading) { fading.style.transition = ''; resetMedia(fading); fading = null; }
          window.clearTimeout(loadTimer); window.clearTimeout(downloadTimer);
          downloadTimer = 0; playCurrent = null; watchReadiness = null;
          assetAbort?.abort(); assetAbort = null;
          if (frameCallback) video.cancelVideoFrameCallback?.(frameCallback);
          frameCallback = 0;
          video.onloadedmetadata = video.onloadeddata = video.oncanplaythrough = video.onplaying = video.onwaiting = video.onpause = video.onended = video.onerror = null;
          if (!disposed) setNeedsPlay(false);
        };
        const unload = () => {
          stopPending();
          for (const target of [standby, idleVideo, replyVideo]) resetMedia(target);
          visible = null;
          image.style.visibility = 'visible';
        };
        const playable = runtime => runtime?.enabled === true && runtime.audio === 'silent'
          && /^\/aura\/character\/[a-z0-9-]+\.mp4$/.test(runtime.src);
        const loadCatalog = () => {
          catalogRequest ??= fetch('/aura/character/catalog.json', { signal: catalog.signal, credentials: 'same-origin' })
            .then(response => {
              if (!response.ok) throw new Error('素材目录暂不可用');
              return response.json();
            }).then(manifest => {
              if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) return null;
              return manifest.assets.filter(clip => typeof clip?.id === 'string' && clip.id !== 'front' && clip.id !== 'answer'
                && Array.isArray(clip.runtime?.roles));
            }).catch(() => null);
          return catalogRequest;
        };
        const canPreview = () => !disposed && !document.hidden && !answer && !['opening', 'listening', 'speaking'].includes(desired.current);
        const armIdle = () => {
          clearIdle();
          if (disposed || !idle() || visible !== standby || kind !== 'front' || document.hidden) return;
          if (assets === null) {
            void loadCatalog().then(rows => {
              assets = rows || [];
              armIdle();
            });
            return;
          }
          const idleClips = assets.filter(({ runtime }) => playable(runtime) && runtime.roles.includes('idle-interaction')
            && runtime.poseFamily === 'frontal-half' && runtime.backgroundFamily === 'aura-studio');
          if (idleClips.length) idleTimer = window.setTimeout(() => {
            idleTimer = 0;
            if (disposed || !idle() || document.hidden) return;
            const eligible = idleClips.filter(clip => !clip.runtime.wave || window.performance.now() - lastWave >= 120000);
            const alternatives = eligible.filter(clip => clip.id !== lastIdle);
            const pool = alternatives.length ? alternatives : eligible;
            if (!pool.length) { armIdle(); return; }
            show(pool[Math.floor(Math.random() * pool.length)].id);
          }, 35000 + Math.floor(Math.random() * 30001));
        };
        const finishAnswer = error => {
          const old = answer; answer = null;
          if (old) { if (error) old.reject(error); else old.resolve(); }
        };
        const showStill = next => {
          serial++; unload(); kind = next; video = standby;
          const source = next === 'side' ? '/aura/character/side.png' : '/aura/character/short-hair.png';
          if (image.getAttribute('src') !== source) image.src = source;
          node.dataset.auraClip = kind;
          node.dataset.auraAudio = 'quiet';
          armIdle();
        };
        const show = (next, reply = null, manual = false, fadeReply = false) => {
          if (disposed) return;
          clearIdle();
          const ticket = ++serial;
          const interaction = assets?.find(clip => clip.id === next);
          const target = next === 'answer' ? replyVideo : interaction ? idleVideo : standby;
          const resumeFront = target === standby && standby.getAttribute('src');
          stopPending();
          if (video === replyVideo || (video === idleVideo && !interaction)) {
            video.muted = true; video.pause();
          }
          for (const layer of [standby, idleVideo, replyVideo]) {
            if (layer !== visible && (layer !== standby || !layer.getAttribute('src'))) resetMedia(layer);
          }
          kind = interaction ? 'interaction' : next;
          video = target;
          node.dataset.auraAudio = 'quiet';
          video.muted = next !== 'answer'; video.loop = next === 'front';
          if (next === 'front') image.src = '/aura/character/short-hair.png';
          const current = () => !disposed && ticket === serial;
          const fail = failure => {
            if (!current()) return;
            const reason = failure?.type || failure?.name || 'load-timeout';
            diag('character_fallback', { sessionId, clip: next, reason,
              message: String(failure?.message || '').slice(0, 180), ...mediaState() });
            if (next !== 'answer') void fetch(source, { method: 'HEAD', cache: 'no-store' })
              .then(response => diag('character_asset_probe', { sessionId, clip: next,
                status: response.status, type: response.headers.get('content-type'),
                length: response.headers.get('content-length'), ranges: response.headers.get('accept-ranges') }))
              .catch(error => diag('character_asset_probe', { sessionId, clip: next, error: String(error?.message || error).slice(0, 180) }));
            if (answer) {
              finishAnswer(new Error(`当前回复音画无法播放（${reason}）`));
              if (next === 'answer' && activated) { show('front'); return; }
            }
            if (interaction) {
              if (manual) onInteractionError?.('这段动作暂时无法播放。');
              show('front'); return;
            }
            serial++; stopPending(); resetMedia(video);
            if (visible === video) { visible = null; image.style.visibility = 'visible'; }
            kind = 'fallback'; node.dataset.auraClip = visible === standby ? 'front' : 'fallback';
          };
          let ready = false, sourceAssigned = false;
          const play = () => {
            if (!current() || !ready || document.hidden) return;
            const attempt = ++playSerial;
            video.play()?.catch(error => {
              if (!current() || attempt !== playSerial) return;
              if (error?.name === 'NotAllowedError' && next === 'answer') {
                setNeedsPlay(true);
                diag('character_gesture_required', { sessionId, clip: next, ...mediaState() });
              } else fail(error);
            });
          };
          playCurrent = play;
          watchReadiness = () => {
            window.clearTimeout(loadTimer);
            if (current() && sourceAssigned && !ready && !document.hidden) loadTimer = window.setTimeout(() => fail(new Error('视频解码就绪超时')), 15000);
          };
          video.onloadeddata = () => {
            if (!current()) return;
            diag('character_decoded', { sessionId, clip: next, ...mediaState() });
            if (next !== 'answer') { ready = true; window.clearTimeout(loadTimer); play(); }
          };
          // The Host has already finished muxing the full AV file. Wait for
          // decoder readiness too; never start a second independent audio clock.
          video.oncanplaythrough = next === 'answer' && !reply?.streamUrl ? () => {
            if (!current()) return;
            ready = true; window.clearTimeout(loadTimer); play();
          } : null;
          const reveal = () => {
            if (!current()) return;
            const previous = visible;
            visible = video;
            if (previous && previous !== video) {
              if (previous === standby) { previous.pause(); previous.style.opacity = '0'; }
              else if (previous === replyVideo && next === 'front' && fadeReply) {
                // Retain the final decoded answer frame until the moving front is ready.
                fading = previous; previous.muted = true; previous.pause();
                previous.style.transition = 'opacity 320ms ease-out';
                previous.style.opacity = '0';
                fadeTimer = window.setTimeout(() => {
                  fadeTimer = 0;
                  if (fading !== previous) return;
                  previous.style.transition = ''; resetMedia(previous); fading = null;
                }, 320);
              } else resetMedia(previous);
            }
            video.style.opacity = '1';
            image.style.visibility = 'hidden';
            node.dataset.auraClip = next;
            if (interaction && previous !== video) {
              lastIdle = next;
              if (interaction.runtime.wave) lastWave = window.performance.now();
            }
            if (next === 'front' && idle() && !idleTimer) armIdle();
            if (next === 'answer') {
              activated = true;
              node.dataset.auraAudio = 'playing';
              answer?.onPlaying?.();
            }
          };
          video.onplaying = () => {
            if (!current() || !ready) return;
            window.clearTimeout(loadTimer); setNeedsPlay(false);
            reveal();
            if (next === 'front' && pendingManual) {
              const queued = pendingManual; pendingManual = null;
              if (canPreview()) { show(queued, null, true); return; }
            }
            diag('character_clip', { sessionId, clip: next, ...mediaState() });
            if (!frameCallback && video.requestVideoFrameCallback) {
              let frames = 0, since = performance.now(), lastMedia = null, maxMediaStep = 0;
              let startQuality = video.getVideoPlaybackQuality?.();
              const observe = (_now, metadata) => {
                frameCallback = 0;
                if (!current()) return;
                if (lastMedia !== null) maxMediaStep = Math.max(maxMediaStep, metadata.mediaTime - lastMedia);
                lastMedia = metadata.mediaTime; frames++;
                const elapsed = _now - since;
                if (elapsed >= 1000) {
                  const quality = video.getVideoPlaybackQuality?.();
                  diag('character_playback_stats', { sessionId, clip: next,
                    observedFps: frames * 1000 / elapsed, maxMediaStep,
                    decodedFrames: quality ? quality.totalVideoFrames - (startQuality?.totalVideoFrames || 0) : null,
                    droppedFrames: quality ? quality.droppedVideoFrames - (startQuality?.droppedVideoFrames || 0) : null,
                    bufferAhead: video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0,
                    ...mediaState() });
                  since = _now; frames = 0; maxMediaStep = 0; startQuality = quality;
                }
                frameCallback = video.requestVideoFrameCallback(observe);
              };
              frameCallback = video.requestVideoFrameCallback(observe);
            }
          };
          video.onwaiting = video.onpause = () => {
            if (!current() || next !== 'answer' || node.dataset.auraClip !== 'answer') return;
            diag('character_playback_wait', { sessionId, clip: next, ...mediaState() });
            node.dataset.auraAudio = 'quiet'; answer?.onWaiting?.();
          };
          video.onended = () => {
            if (!current()) return;
            if (next === 'answer') {
              video.muted = true; node.dataset.auraAudio = 'quiet';
              finishAnswer();
              returnTimer = window.setTimeout(() => {
                returnTimer = 0;
                if (current()) show('front', null, false, true);
              }, 500);
            }
            else if (interaction) show('front');
          };
          video.onerror = fail;
          // Answer loading has honest preparation UI, not a fake 5s success.
          const source = next === 'answer' ? reply.mediaUrl : interaction?.runtime.src || '/aura/character/front.mp4';
          if (resumeFront) {
            sourceAssigned = true; ready = video.readyState >= 2;
            watchReadiness();
            play();
          } else if (next === 'answer' && reply.streamUrl) {
            assetAbort = new AbortController();
            const signal = assetAbort.signal;
            const mse = new MediaSource();
            const objectUrl = URL.createObjectURL(mse);
            urls.set(video, objectUrl);
            sourceAssigned = true; video.src = objectUrl; video.load(); watchReadiness();
            // One SourceBuffer carries both tracks and their original timestamps.
            const waitEvent = (target, event) => new Promise((resolve, reject) => {
              const clean = () => { target.removeEventListener(event, done); target.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
              const done = () => { clean(); resolve(); };
              const failed = () => { clean(); reject(new Error('音画流解码失败')); };
              const aborted = () => { clean(); reject(new DOMException('Cancelled', 'AbortError')); };
              if (signal.aborted) return aborted();
              target.addEventListener(event, done, { once: true }); target.addEventListener('error', failed, { once: true });
              signal.addEventListener('abort', aborted, { once: true });
            });
            void (async () => {
              await waitEvent(mse, 'sourceopen');
              if (!current() || signal.aborted) return;
              const buffer = mse.addSourceBuffer(reply.streamMime);
              const response = await fetch(reply.streamUrl, { signal, credentials: 'same-origin', cache: 'no-store' });
              if (!response.ok || !response.body) throw new Error('音画流读取失败');
              const reader = response.body.getReader(); let bytes = 0;
              try {
                for (;;) {
                  let deadline;
                  const nextChunk = await Promise.race([reader.read(), new Promise((_, reject) => {
                    deadline = window.setTimeout(() => reject(new Error('音画流等待超时')), 30000);
                  })]).finally(() => window.clearTimeout(deadline));
                  const { done, value } = nextChunk;
                  if (done) break;
                  if (!current() || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                  bytes += value.byteLength;
                  if (bytes > 128 * 1024 * 1024) throw new Error('音画流超过播放上限');
                  const appended = waitEvent(buffer, 'updateend'); appended.catch(() => {});
                  buffer.appendBuffer(value); await appended;
                  // Start with a small cushion, not canplaythrough (unbounded stream).
                  if (!ready && buffer.buffered.length && buffer.buffered.end(0) >= 0.75) {
                    ready = true; window.clearTimeout(loadTimer); play();
                  }
                  if (video.currentTime > 30 && buffer.buffered.length && buffer.buffered.start(0) < video.currentTime - 25) {
                    const removed = waitEvent(buffer, 'updateend'); removed.catch(() => {}); buffer.remove(0, video.currentTime - 20); await removed;
                  }
                }
                if (!current() || signal.aborted) return;
                mse.endOfStream();
                if (!ready) { ready = true; window.clearTimeout(loadTimer); play(); }
                diag('character_stream_complete', { sessionId, bytes, ...mediaState() });
              } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            })().catch(error => { if (current() && !signal.aborted) fail(error); });
          } else if (window.location.protocol === 'dsh-app:') {
            // Desktop's custom-protocol media loader cannot open these MP4s,
            // although the same authenticated fetch succeeds. Hand the one
            // video element a bounded, complete Blob instead. No second clock.
            assetAbort = new AbortController();
            const controller = assetAbort, signal = controller.signal;
            const deadline = downloadTimer = window.setTimeout(() => {
              if (!current()) return;
              controller.abort(); fail(new Error('视频读取超时'));
            }, 15000);
            void (async () => {
              const response = await fetch(source, { signal, credentials: 'same-origin' });
              if (!response.ok) throw new Error(`视频读取失败（HTTP ${response.status}）`);
              const type = response.headers.get('content-type')?.split(';')[0];
              if (type !== 'video/mp4') throw new Error('视频响应不是 MP4');
              const limit = (next === 'answer' ? 64 : 8) * 1024 * 1024;
              if (Number(response.headers.get('content-length')) > limit) throw new Error('视频超过本地播放大小上限');
              const reader = response.body.getReader(), chunks = []; let bytes = 0;
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  bytes += value.byteLength;
                  if (signal.aborted || !current()) throw new Error('视频加载已取消');
                  if (bytes > limit) throw new Error('视频超过本地播放大小上限');
                  chunks.push(value);
                }
              } finally { if (!current() || bytes > limit || signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); }
              if (!current() || signal.aborted) return;
              const objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
              urls.set(video, objectUrl);
              sourceAssigned = true; video.src = objectUrl; video.load(); watchReadiness?.();
              diag('character_asset_loaded', { sessionId, clip: next, bytes, transport: 'authenticated-blob' });
            })().catch(fail).finally(() => {
              window.clearTimeout(deadline);
              if (downloadTimer === deadline) downloadTimer = 0;
            });
          } else { sourceAssigned = true; video.src = source; video.load(); watchReadiness(); }
        };
        const sync = () => {
          if (disposed) return;
          node.dataset.auraState = desired.current;
          if (lastStage !== desired.current) {
            lastStage = desired.current;
            if (idle()) {
              if (!idleTimer) armIdle();
            } else {
              clearIdle();
              pendingManual = null;
              if (kind === 'interaction') show('front');
            }
          }
          if (!kind) showStill('side');
          if (desired.current === 'listening') {
            activated = true;
            if (kind !== 'front' && kind !== 'answer') show('front');
          }
        };
        const visibility = () => {
          if (document.hidden) {
            pendingManual = null; clearIdle();
            if (kind === 'interaction') show('front');
            playSerial++; window.clearTimeout(loadTimer); video.pause();
            if (visible !== video) visible?.pause();
          } else if (kind !== 'side' && kind !== 'fallback') {
            if (kind === 'answer' && visible === standby) void standby.play()?.catch(() => {});
            watchReadiness?.(); playCurrent?.();
            if (idle() && !idleTimer) armIdle();
          }
        };
        const api = {
          sync,
          async interactions() {
            const rows = await loadCatalog();
            assets = rows || [];
            return rows && rows.filter(({ runtime }) => runtime.roles.includes('manual-interaction')).map(({ id, runtime }) => ({
              id, action: runtime.manualAction,
              available: playable(runtime),
              reason: runtime.disabledReason,
            }));
          },
          preview(id) {
            if (!canPreview()) return false;
            const item = assets?.find(clip => clip.id === id && clip.runtime.roles.includes('manual-interaction'));
            if (!item || !playable(item.runtime)) return false;
            activated = true;
            if (kind === 'interaction' || visible === idleVideo) { pendingManual = id; show('front'); }
            else show(id, null, true);
            return true;
          },
          activity() {
            pendingManual = null; clearIdle();
            if (kind === 'interaction') show('front');
            else if (idle()) armIdle();
          },
          playReply(reply) {
            if (disposed || reply.sessionId !== sessionId) return Promise.reject(new Error('数字人会话已失效'));
            finishAnswer(new Error('数字人回复被替换'));
            pendingManual = null; clearIdle();
            return new Promise((resolve, reject) => {
              answer = { ...reply, resolve, reject };
              show('answer', answer);
            });
          },
          resume() { if (!disposed) playCurrent?.(); },
          clear() {
            if (disposed) return;
            finishAnswer(new Error('数字人回复已取消'));
            node.dataset.auraAudio = 'quiet';
            if (kind === 'answer') {
              if (activated) show('front');
              else showStill('side');
            }
            armIdle();
          },
        };
        player.current = control.current = api;
        document.addEventListener('visibilitychange', visibility);
        sync();
        return () => {
          disposed = true; serial++; clearIdle(); catalog.abort(); finishAnswer(new Error('数字人播放器已关闭')); unload();
          document.removeEventListener('visibilitychange', visibility);
          if (control.current === api) control.current = null;
          player.current = null;
        };
      }, [sessionId, control, onInteractionError]);
      React.useEffect(() => { player.current?.sync(); }, [stage]);
      const layer = { ...CHARACTER_IMAGE, position: 'absolute', inset: 0,
        width: '100%', height: '100%', maxWidth: '100%', maxHeight: '100%', objectFit: 'cover', maskImage: 'none' };
      const mediaBox = { position: 'relative', flex: '0 0 auto',
        width: 'min(100cqw, calc(100cqh * 1113 / 1414))',
        height: 'min(100cqh, calc(100cqw * 1414 / 1113))',
        maskImage: CHARACTER_IMAGE.maskImage, maskComposite: CHARACTER_IMAGE.maskComposite };
      return h(React.Fragment, null, h('div', { ref: surround, style: { ...CHARACTER_SURROUND, containerType: 'size' },
        'data-aura-visual': 'single-character', 'data-aura-state': stage,
        'data-aura-clip': 'side', 'data-aura-audio': 'quiet' },
        h('div', { style: mediaBox, 'data-aura-media-box': true },
          h('img', { ref: still, src: '/aura/character/side.png', style: layer,
            alt: 'Aura 定妆像', draggable: false }),
          h('video', { ref: media, style: { ...layer, opacity: 0 }, muted: true,
            playsInline: true, preload: 'auto', 'aria-hidden': true }),
          h('video', { ref: idleMedia, 'data-aura-idle-player': true, style: { ...layer, opacity: 0 }, muted: true,
            playsInline: true, preload: 'none', 'aria-hidden': true }),
          h('video', { ref: replyMedia, 'data-aura-reply-player': true, style: { ...layer, opacity: 0 }, muted: true,
            playsInline: true, preload: 'auto', 'aria-hidden': true }))),
        needsPlay ? h('button', { type: 'button', 'data-aura-play': true, onClick: () => player.current?.resume(),
          style: { position: 'absolute', top: '55%', left: '50%', transform: 'translate(-50%, -50%)',
            pointerEvents: 'auto', zIndex: 2, padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
            color: '#fff', background: '#222', border: '1px solid #888' } }, '点击播放音画') : null);
    }

    /** The tab body: one presence plus a composer that drives this session. */
    function Pane(props) {
      const [prefs, setPrefs] = React.useState(readPrefs);
      // Static portrait and particle canvas are mutually exclusive visual layers.
      const form = prefs.character ? null : FORMS.orb;
      const useStatus = props.useSessionStatus || (() => undefined);
      // This Hook exposes every session, including other windows and workers.
      // Only this pane's identity may drive its reply completion and playback.
      const running = useStatus(status => status?.get(props.sessionId)?.running === true) === true;
      const waiting = useStatus(status => Boolean(status?.get(props.sessionId)?.pendingInteraction)) === true;

      const wasRunning = React.useRef(false);
      /* Mirrors the live status, because submitting happens outside the effect. */
      const runningRef = React.useRef(false);
      const [settledAt, setSettledAt] = React.useState(0);
      const [settled, setSettled] = React.useState(false);
      /* Declared before the phase below reads it. */
      const [listening, setListening] = React.useState(false);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        if (error) diag('pane_error', { sessionId: props.sessionId, message: String(error).slice(0, 600) });
      }, [error, props.sessionId]);
      /* A continuous session is always "listening" at rest, so the phase needs
       * the mode before the preference state is declared. */
      const modeRef = React.useRef('talk');
      const [talking, setTalking] = React.useState(false);
      const [singleStage, setSingleStage] = React.useState('initial');
      const [interactionOpen, setInteractionOpen] = React.useState(false);
      const [interactionAssets, setInteractionAssets] = React.useState(undefined);
      const [interactionNotice, setInteractionNotice] = React.useState('');
      const showInteractionError = React.useCallback(message => {
        setInteractionNotice(message);
        setInteractionOpen(true);
      }, []);
      const characterControl = React.useRef(null);
      const [visualStatus, setVisualStatus] = React.useState(null);
      const [visualNotice, setVisualNotice] = React.useState('');
      const [preparationSeconds, setPreparationSeconds] = React.useState(0);
      const visualPreparation = React.useRef(null);
      const visualStarted = React.useRef(0);
      const visualBusy = React.useRef(false);
      const pendingTaskIds = React.useRef(new Set());
      const [pendingTaskCount, setPendingTaskCount] = React.useState(0);
      const acceptedDispatchCalls = React.useRef(new Map());
      const summaryTurns = React.useRef(new Map());
      const completedTaskIds = React.useRef(new Set());
      const foregroundSpeech = React.useRef(new Map());
      const singleCharacterMode = () => prefsRef.current.character && modeRef.current === 'talk';
      React.useEffect(() => {
        if (!visualStatus || visualStatus.state !== 'preparing') return;
        const tick = () => setPreparationSeconds(Math.floor((Date.now() - visualStarted.current) / 1000));
        tick(); const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
      }, [visualStatus?.state]);

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
      // Continuous capture remains live during playback; display the active speaker.
      let visualPhase = phase;
      if (prefs.character && talking) visualPhase = 'talking';
      else if (prefs.character && running) visualPhase = 'running';
      phaseRef.current = visualPhase;
      const formRef = React.useRef(null);
      const gestureRef = React.useRef(0);
      const toneRef = React.useRef(0);

      React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !form) return undefined;
        const instance = form.mount(canvas, () => ({ phase: phaseRef.current, level: levelRef.current, tone: toneRef.current, gesture: gestureRef.current }));
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
      }, [form]);

      React.useEffect(() => {
        if (formRef.current) formRef.current.refresh();
      }, [visualPhase]);

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
      modeRef.current = prefs.mode || 'talk';
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [visualConfig, setVisualConfig] = React.useState(null);
      const [visualConfigAvailable, setVisualConfigAvailable] = React.useState(false);
      const [visualConfigRequest, setVisualConfigRequest] = React.useState(null);
      const [visualConfigError, setVisualConfigError] = React.useState('');
      const configRequestRef = React.useRef(null);
      const configLoadAbort = React.useRef(null);
      const configMounted = React.useRef(true);
      React.useEffect(() => {
        configMounted.current = true;
        return () => { configMounted.current = false; configLoadAbort.current?.abort(); };
      }, []);
      const refreshVisualConfig = React.useCallback(async () => {
        if (configRequestRef.current === 'post' || !props.access.active()) return;
        configLoadAbort.current?.abort();
        const controller = new AbortController();
        configLoadAbort.current = controller;
        configRequestRef.current = 'get'; setVisualConfigRequest('get'); setVisualConfigError('');
        const current = () => configMounted.current && configLoadAbort.current === controller && !controller.signal.aborted && props.access.active();
        try {
          const response = await fetch('/aura/visual/config', { method: 'GET', cache: 'no-store',
            headers: { 'x-aura-instance': props.access.token }, signal: controller.signal });
          const value = await response.json();
          if (!response.ok) throw new Error(value?.error || `读取状态失败（${response.status}）`);
          if (!value || typeof value.version !== 'string' || typeof value.enabled !== 'boolean' || typeof value.editable !== 'boolean'
            || (value.reason !== undefined && typeof value.reason !== 'string')) throw new Error('配置状态响应无效，请更新 Host 后重试。');
          if (current()) { setVisualConfig(value); setVisualConfigAvailable(true); }
        } catch (failure) {
          if (current()) { setVisualConfigAvailable(false); setVisualConfigError(String(failure?.message || failure)); }
        } finally {
          if (configLoadAbort.current === controller) {
            configLoadAbort.current = null; configRequestRef.current = null;
            if (configMounted.current) setVisualConfigRequest(null);
          }
        }
      }, [props.access]);
      React.useEffect(() => {
        if (!panelOpen) return;
        void refreshVisualConfig();
        return () => configLoadAbort.current?.abort();
      }, [panelOpen, refreshVisualConfig]);
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
      const captureEpoch = React.useRef(0);
      const pendingCapture = React.useRef(null);

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
      const taskSummaries = React.useRef([]);
      const coveredTurns = React.useRef(new Set());
      const pendingFallback = React.useRef(false);
      const coverCurrentTurn = () => {
        const entries = services?.get?.('sessions')?.binding?.(props.sessionId)?.eventSource?.getSnapshot?.().entries || [];
        for (const entry of entries) {
          const turn = entry.event?.data?.turn;
          if (!Number.isInteger(turn)) continue;
          observedTurn.current = Math.max(observedTurn.current, turn);
          coveredTurns.current.add(turn);
          if (coveredTurns.current.size > 256) coveredTurns.current.delete(coveredTurns.current.values().next().value);
        }
      };
      const summarySeen = React.useRef(new Set());
      const observedTurn = React.useRef(-1);
      const silencedThrough = React.useRef(-1);
      const voiceRef = React.useRef(null);
      // Playback state never gates microphone frames. The recognizer hears the
      // continuous stream; transcript/echo comparison decides interruption.
      const gateRef = React.useRef({ active: false, until: 0 });
      const levelRef = React.useRef(0);
      // Playback intent belongs to this live instance, not browser storage.
      // Remounting or restarting must never replay a different/obsolete turn.
      const speakNext = React.useRef(false);
      const taskSpeechEnabled = React.useRef(false);
      const armSpeak = (armed) => { speakNext.current = armed; if (armed) taskSpeechEnabled.current = true; };
      const speakArmedRef = speakNext;
      /* The window still shows the previous reply for a moment after a run
       * ends, so the text from before this turn is captured and the new one is
       * whatever differs from it. */
      const replyBefore = React.useRef('');
      const replyBeforeSeq = React.useRef(-1);

      /** Stop playback and let the sphere settle. */
      /**
       * Silence the voice.
       *
       * `echoTail` keeps the microphone closed for a moment after the speaker
       * stops, which is right when the answer ended by itself. It is wrong for
       * an interruption: the user is still talking, and closing the gate there
       * swallowed the next 150 ms of their sentence.
       */
      const stopSpeaking = React.useCallback((options = {}) => {
        const cancel = options.abort !== false;
        /* Only a real cancellation invalidates the request in flight. Bumping
         * the generation on a natural end made the *next* sentence decide it
         * was stale and cancel itself, which is why the voice kept dying one
         * sentence in. */
        if (cancel) {
          taskSummaries.current = [];
          pendingFallback.current = false;
          taskSpeechEnabled.current = false;
          silencedThrough.current = Math.max(silencedThrough.current, observedTurn.current);
          speakGeneration.current += 1;
          visualPreparation.current?.cancel(options.reason || 'explicit-stop');
          setVisualNotice(options.reason === 'silence-button' && visualBusy.current ? '已停止本次回答音画' : '');
          visualBusy.current = false;
          setVisualStatus(null);
          speakQueue.current = Promise.resolve();
          speechBuffer.current = '';
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
        if (cancel) spokenRef.current.clear();
        const playback = voiceRef.current;
        voiceRef.current = null;
        levelRef.current = 0;
        if (cancel) characterControl.current?.clear();
        if (modeRef.current === 'talk' && (cancel || !runningRef.current)) {
          // Stopping an old answer must not send a newly opened microphone back
          // to idle (including barge-in partials before this utterance is final).
          setSingleStage(captureRef.current ? 'listening' : pendingCapture.current ? 'opening' : 'idle');
        }
        setTalking(false);
        gateRef.current.active = false;
        gateRef.current.until = options.echoTail === false ? 0 : Date.now() + 150;
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
      /* The last few seconds of our own speech, for the echo test. */
      const spokenRef = React.useRef(createPlaybackReference());
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
        async (text, voice, generation, taskId) => {
          const spoken = speechText(text);
          if (!spoken) {
            diag('speak_skipped', { chars: String(text || '').length });
            return;
          }
          if (!props.access.active() || generation !== speakGeneration.current) return;
          if (speechGagged()) {
            diag('speak_gagged', { chars: spoken.length, run: runSeqRef.current });
            return;
          }
          if (singleCharacterMode()) {
            let visualOutcome = 'preparation-inactive';
            try {
              const replyVoice = voice || prefsRef.current.voice;
              const replyModel = prefsRef.current.model || MODELS[0].id;
              if (replyModel !== 'cosyvoice-v3-flash' || !VOICES.some(item => item.id === replyVoice && item.trait.endsWith('女'))) {
                throw new Error('单句数字人需要女声音色和 CosyVoice 3.0 Flash（非 3.5）。请打开 Aura 设置，选择龙颜/龙婉等已列出的女声及 3.0；不会自动换声。任务执行不受影响，回复文本可在会话中查看。');
              }
              setVisualNotice('');
              visualBusy.current = true;
              visualStarted.current = Date.now();
              setPreparationSeconds(0);
              setSingleStage('prepare');
              if (!visualPreparation.current) visualPreparation.current = createVisualPreparation({
                access: props.access, onStatus: setVisualStatus, diagnostic: diag,
              });
              const ready = await visualPreparation.current.prepare({
                text: spoken, voice: replyVoice, model: replyModel,
                taskId: taskId || `${props.sessionId}:turn:${runSeqRef.current}`,
                sessionId: props.sessionId,
              });
              const current = () => props.access.active() && generation === speakGeneration.current && !speechGagged() && singleCharacterMode();
              if (!ready || !current()) return;
              setVisualStatus({ ...ready, state: 'preparing', stage: '等待音画播放器就绪' });
              const player = characterControl.current;
              if (!player) throw new Error('数字人播放器不可用');
              await player.playReply({ mediaUrl: ready.mediaUrl, streamUrl: ready.streamUrl, streamMime: ready.streamMime, sessionId: props.sessionId,
                onPlaying() { if (current()) { setTalking(true); setSingleStage('speaking'); setVisualStatus(null); } },
                onWaiting() { if (current()) { setTalking(false); setSingleStage('prepare');
                  setVisualStatus({ state: 'preparing', stage: '音画缓冲', elapsedSeconds: 0 }); } },
              });
              visualOutcome = 'playback-ended';
              if (current()) stopSpeaking({ abort: false });
            } catch (failure) {
              visualOutcome = 'preparation-or-playback-error';
              diag('visual_error', { sessionId: props.sessionId, reason: failure?.name || 'Error' });
              if (!props.access.active() || generation !== speakGeneration.current) return;
              setError(String(failure?.message || failure));
              stopSpeaking({ abort: false });
            } finally {
              if (generation === speakGeneration.current) {
                visualPreparation.current?.cancel(visualOutcome);
                visualBusy.current = false;
                setVisualStatus(null);
              }
            }
            return;
          }
          let requestController;
          try {
            diag('tts_request', { chars: spoken.length });
            const controller = requestController = new AbortController();
            speechAbort.current = controller;
            const response = await fetch('/aura/tts', {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json', 'x-aura-instance': props.access.token },
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

            if (!props.access.active() || generation !== speakGeneration.current) return;
            const rate = Number(response.headers.get('x-aura-sample-rate')) || SAMPLE_RATE;
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) throw new Error('This browser exposes no Web Audio.');
            const existing = voiceRef.current;
            /* Sentences are queued: reuse the player so the next one starts
             * where the last ended instead of cutting it off. */
            const audio = existing ? existing.audio : new AudioCtor({ sampleRate: rate });
            if (audio.state === 'suspended') {
              // This context is not yet published in voiceRef. Revoke it even
              // while resume() waits for an OS/browser audio permission.
              const unsubscribe = props.access.subscribe(() => { if (!existing) void audio.close(); });
              try {
                await audio.resume();
              } catch {
                /* reported by the beacon below */
              } finally {
                unsubscribe();
              }
            }
            if (!props.access.active() || generation !== speakGeneration.current || speechGagged()) {
              if (!existing) void audio.close();
              void response.body?.cancel?.();
              return;
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
              if (prefsRef.current.character) {
                let crossings = 0;
                for (let i = 1; i < data.length; i++) {
                  if ((data[i] >= 128) !== (data[i - 1] >= 128)) crossings++;
                }
                const hz = crossings * audio.sampleRate / (2 * data.length);
                toneRef.current = hz < 420 ? 1 : hz > 1300 ? 2 : 0;
              }
              playback.frame = window.requestAnimationFrame(meter);
            };

            /* Play each slice as it lands: the first audio starts as soon as the
             * provider produces it, instead of after the whole reply exists. */
            const schedule = (samples) => {
              if (!props.access.active() || samples.length === 0 || voiceRef.current !== playback) return;
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
              const start = Math.max(playback.at, audio.currentTime);
              source.start(start);
              playback.at = start + samples.length / rate;
              spokenRef.current.add(audio, start, playback.at, spoken, runSeqRef.current);
              // Pass the actual scheduled PCM clock, never setTalking's early
              // network intent. Phase one intentionally has no synthetic lips.
              characterControl.current?.schedule({ audio, start, end: playback.at,
                pcm: samples, rate, sessionId: props.sessionId, generation });
              if (modeRef.current === 'talk') setSingleStage('speaking');
              voiceTrace('play_span', { turn: runSeqRef.current, start, end: playback.at, chars: spoken.length });
            };

            voiceRef.current = playback;
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
              if (speechGagged() || !props.access.active() || generation !== speakGeneration.current) {
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
            if (!props.access.active() || generation !== speakGeneration.current) return;
            const cancelled = failure && (failure.name === 'AbortError' || /aborted/i.test(String(failure.message)));
            if (cancelled) {
              diag('tts_cancelled');
              stopSpeaking({ abort: false });
              return;
            }
            diag('tts_error', { message: String((failure && failure.message) || failure).slice(0, 200) });
            setError(String((failure && failure.message) || failure));
            stopSpeaking({ abort: false });
          } finally {
            if (speechAbort.current === requestController) speechAbort.current = null;
          }
        },
        [stopSpeaking],
      );

      const speak = React.useCallback(
        (text, voice, taskId) => {
          const generation = speakGeneration.current;
          speakQueue.current = speakQueue.current
            .then(() => speakNow(text, voice, generation, taskId))
            .catch(() => {});
          return speakQueue.current;
        },
        [speakNow],
      );



      React.useEffect(() => {
        if (!prefs.character || prefs.mode === 'chat') {
          if (visualBusy.current) stopSpeaking({ reason: 'mode-change' });
        }
      }, [prefs.character, prefs.mode, stopSpeaking]);

      // Task completion is a separate, final-text-only channel. It never arms
      // the foreground stream, prompts a model, or survives a closed pane.
      React.useEffect(() => {
        const off = props.access.onSummary(message => {
          if (summarySeen.current.has(message.key)) return;
          summarySeen.current.add(message.key);
          if (summarySeen.current.size > 256) summarySeen.current.delete(summarySeen.current.values().next().value);
          const single = singleCharacterMode();
          const taskIds = [...new Set([message.taskId, ...(Array.isArray(message.taskIds) ? message.taskIds : [])]
            .filter(id => typeof id === 'string' && id.length > 0))];
          // A summary may settle several children at once. Its render identity
          // is the native child only for exactly one child, otherwise the stable
          // summary key. Never guess a child from unrelated pending work.
          const taskId = taskIds.length === 1 ? taskIds[0] : message.key;
          if (single) {
            for (const id of taskIds) { pendingTaskIds.current.delete(id); completedTaskIds.current.add(id); }
            setPendingTaskCount(pendingTaskIds.current.size);
          }
          if ((single && summaryTurns.current.has(message.turn)) || !taskSpeechEnabled.current || (!single && speakNext.current) || message.turn <= silencedThrough.current
            || (!single && coveredTurns.current.has(message.turn)) || speechGagged()) return;
          const text = single ? speechText(message.text) : speechText(message.text).slice(0, 360);
          if (!text) return;
          if (single) {
            summaryTurns.current.set(message.turn, text);
            if (summaryTurns.current.size > 256) summaryTurns.current.delete(summaryTurns.current.keys().next().value);
          }
          taskSummaries.current.push({ ...message, taskId, text, generation: speakGeneration.current, at: Date.now() });
          taskSummaries.current = taskSummaries.current.slice(-8);
        });
        const timer = window.setInterval(() => {
          if (!props.access.active()) { taskSummaries.current = []; return; }
          // Foreground/user audio always wins. Cancellation clears the queue;
          // late delivery cannot resume old audio after a hangup or interruption.
          if (runningRef.current || speakNext.current || pendingFallback.current || voiceRef.current
            || visualBusy.current || pendingCapture.current || Date.now() - partialRef.current.at < 1500) return;
          const next = taskSummaries.current.shift();
          if (!next || next.generation !== speakGeneration.current
            || (singleCharacterMode() && foregroundSpeech.current.get(next.turn) === next.text)
            || (!singleCharacterMode() && (Date.now() - next.at > 30000 || coveredTurns.current.has(next.turn))) || speechGagged()) return;
          void speak(next.text, undefined, next.taskId);
        }, 150);
        return () => { off(); window.clearInterval(timer); taskSummaries.current = []; };
      }, [props.sessionId, speak]);

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
          if (singleCharacterMode()) return; // Whole final reply: one TTS/render job, not one per sentence.
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

      /* Observe this session continuously; arming gates playback. A fast first
       * delta can arrive before the separate running-status notification. */
      React.useEffect(() => {
        const sessions = services && services.get ? services.get('sessions') : null;
        const binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(props.sessionId) : null;
        const source = binding && binding.eventSource;
        if (!source || typeof source.subscribe !== 'function') return undefined;

        let seen = 0, toolSeen = 0;
        const taskCalls = new Map();
        for (const entry of source.getSnapshot?.().entries || []) {
          if (entry.event?.type === 'tool/call' || entry.event?.type === 'tool/result') toolSeen = Math.max(toolSeen, entry.event.seq || 0);
          if (entry.event?.type === 'assistant/live-chunk') seen = Math.max(seen, entry.event.seq || 0);
        }
        const onSnapshot = () => {
          const snapshot = typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
          const entries = (snapshot && snapshot.entries) || [];
          for (const entry of entries) {
            const event = entry && entry.event;
            if (Number.isInteger(event?.data?.turn)) observedTurn.current = Math.max(observedTurn.current, event.data.turn);
            if ((speakNext.current || speechGagged()) && Number.isInteger(event?.data?.turn)) {
              coveredTurns.current.add(event.data.turn);
              if (coveredTurns.current.size > 256) coveredTurns.current.delete(coveredTurns.current.values().next().value);
            }
            if (event && event.seq > toolSeen && (event.type === 'tool/call' || event.type === 'tool/result')) {
              if (event.type === 'tool/call' && event.data.name === 'aura_task') {
                taskCalls.set(event.data.callId, event.data.turn);
              }
              if (event.type === 'tool/result' && taskCalls.has(event.data.message?.toolCallId)) {
                const callId = event.data.message.toolCallId;
                const dispatchTurn = taskCalls.get(callId);
                taskCalls.delete(callId);
                try {
                  const receipt = JSON.parse(event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
                  if (receipt.status === 'dispatched' && typeof receipt.sessionId === 'string') {
                    acceptedDispatchCalls.current.set(callId, dispatchTurn);
                    if (acceptedDispatchCalls.current.size > 256) acceptedDispatchCalls.current.delete(acceptedDispatchCalls.current.keys().next().value);
                    if (!completedTaskIds.current.has(receipt.sessionId)) pendingTaskIds.current.add(receipt.sessionId);
                    setPendingTaskCount(pendingTaskIds.current.size);
                  }
                } catch { /* Not a dispatch receipt: never invent a native task id. */ }
              }
              toolSeen = Math.max(toolSeen, event.seq);
            }
            if (!event || event.type !== 'assistant/live-chunk') continue;
            const seq = typeof event.seq === 'number' ? event.seq : 0;
            if (seq <= seen) continue;
            seen = seq;
            const chunk = event.data && event.data.chunk;
            if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
              appendSpeech(chunk.text);
            }
          }
        };
        const unsubscribe = source.subscribe(onSnapshot);
        onSnapshot();
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [appendSpeech, props.sessionId]);

      /** Settle only this foreground turn; independent workers may remain busy. */
      React.useEffect(() => {
        diag('run_watch', { running, was: wasRunning.current, wants: speakNext.current });
        if (running && !wasRunning.current) {
          pendingFallback.current = false;
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
            coverCurrentTurn();
            armSpeak(false);
            /* Whatever the stream left unfinished is the last sentence. */
            // Single mode speaks the completed durable answer, not draft/live
            // chunks that may span tool steps or differ from the final text.
            const tail = singleCharacterMode() ? '' : speechBuffer.current.trim();
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
            const baselineSeq = replyBeforeSeq.current;
            const watched = props.sessionId;
            const watchedRun = runSeqRef.current;
            const watchedGeneration = speakGeneration.current;
            pendingFallback.current = true;
            let attempts = 0;
            const take = () => {
              if (runSeqRef.current !== watchedRun || speakGeneration.current !== watchedGeneration) return;
              if (!props.access.active() || speechGagged()) { pendingFallback.current = false; return; }
              const single = singleCharacterMode();
              const completed = single ? lastAssistantText(watched, true, acceptedDispatchCalls.current) : null;
              const text = single ? (completed?.text || '') : lastAssistantText(watched);
              const fresh = Boolean(text) && (completed && Number.isInteger(completed.event.seq)
                ? completed.event.seq > baselineSeq : text !== baseline);
              diag('reply_ready', { chars: text.length, fresh, attempt: attempts });
              if (fresh) {
                coverCurrentTurn();
                pendingFallback.current = false;
                replyBefore.current = text;
                if (single) {
                  const turn = completed.event.data.turn;
                  const summary = summaryTurns.current.get(turn);
                  const spoken = speechText(text);
                  if (spoken) {
                    if (summary && (summary === spoken || ![...acceptedDispatchCalls.current.values()].includes(turn))) return;
                    foregroundSpeech.current.set(turn, spoken);
                    if (foregroundSpeech.current.size > 256) foregroundSpeech.current.delete(foregroundSpeech.current.keys().next().value);
                  }
                }
                void speak(text);
                return;
              }
              attempts += 1;
              if (attempts < 10) window.setTimeout(take, 200);
              else pendingFallback.current = false;
            };
            window.setTimeout(take, 120);
          }
        }
        wasRunning.current = running;
      }, [running, props.sessionId, speak]);

      // Silent replies / foreground acceptance may have no PCM end callback.
      // Independent task results can wake the character later through playReply.
      React.useEffect(() => {
        if (modeRef.current !== 'talk' || !['waiting', 'speaking'].includes(singleStage)) return;
        const since = Date.now();
        const timer = window.setInterval(() => {
          if (Date.now() - since < 1500 || runningRef.current || voiceRef.current
            || speakNext.current || pendingFallback.current || visualBusy.current || pendingTaskIds.current.size) return;
          setSingleStage('idle');
        }, 250);
        return () => window.clearInterval(timer);
      }, [singleStage]);

      /** Send one message into the session this pane belongs to. */
      const submitText = React.useCallback(
        async (text, stillCurrent = () => true) => {
          const trimmed = String(text || '').trim();
          if (!trimmed || configRequestRef.current === 'post' || !props.access.active() || !stillCurrent()) return false;
          const session = bindSession(props.sessionId);
          if (!session) {
            setError('No live session for this pane.');
            return false;
          }
          setBusy(true);
          setError(null);
          let step = 'enable';
          try {
            if (runningRef.current) gaggedRef.current = runSeqRef.current;
            stopSpeaking({ reason: 'new-submit' });
            characterControl.current?.activity();
            if (modeRef.current === 'talk') setSingleStage('waiting');
            // Native authenticated commands scope the foreground and cancel only
            // its obsolete turn. Published managed tasks have separate owners.
            const command = async line => {
              const reply = await services.remote.commands.execute(props.sessionId, line, []);
              if (!reply.ok || reply.value?.result?.kind !== 'success') {
                throw new Error(reply.value?.result?.text || reply.error?.message || 'Aura foreground unavailable.');
              }
            };
            await command('/aura on');
            if (!props.access.active() || !stillCurrent()) return false;
            step = 'interrupt';
            if (runningRef.current) await command('/aura interrupt');
            if (!props.access.active() || !stillCurrent()) return false;
            step = 'prompt';
            const mode = 'queue';
            // Arm BEFORE publication: a fast answer may arrive before the RPC
            // acknowledges the prompt. Never use that new answer as baseline.
            replyBefore.current = lastAssistantText(props.sessionId);
            replyBeforeSeq.current = lastAssistantText(props.sessionId, true)?.event?.seq ?? -1;
            gaggedRef.current = -1;
            armSpeak(true);
            diag('submit_mode', { sessionId: props.sessionId, mode });
            const result = await session.prompt([{ type: 'text', text: trimmed }], mode);
            if (result && result.ok === false) throw new Error(result.error?.message || 'The session refused the message.');
            if (!props.access.active() || !stillCurrent()) return false;
            diag('speak_armed', { sessionId: props.sessionId, chars: trimmed.length, before: replyBefore.current.length });
            return true;
          } catch (failure) {
            armSpeak(false);
            const message = String(failure?.message || failure);
            diag('submit_error', { sessionId: props.sessionId, step, message: message.slice(0, 600) });
            if (props.access.active()) setError(message);
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
        stopSpeaking({ reason: 'stop-button' });
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
      const stopCapture = React.useCallback((reason = 'manual-or-cleanup') => {
        voiceTrace('capture_stop', { reason: typeof reason === 'string' ? reason : 'manual' });
        captureEpoch.current += 1; // Invalidate pending permission/ASR callbacks, too.
        openingRef.current = false;
        const pending = pendingCapture.current;
        pendingCapture.current = null;
        if (pending) {
          try { pending.socket?.close(); } catch {}
          for (const track of pending.stream?.getTracks() || []) track.stop();
          if (pending.audio) void pending.audio.close();
          pending.release?.({ text: '' });
        }
        const capture = captureRef.current;
        captureRef.current = null;
        liveCapture.current = null;
        liveCapture.opening = false;
        try {
          if (window.__auraCapture && (!capture || window.__auraCapture.id === capture.id)) {
            window.__auraCapture = null;
          }
        } catch {
          /* private mode */
        }
        setListening(false);
        if (modeRef.current === 'talk' && reason !== 'single-final') setSingleStage('idle');
        if (!capture) {
          diag('mic_stop_empty');
          return;
        }
        diag('mic_stop', { id: capture.id });
        capture.release?.({ text: '' });
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

      React.useEffect(() => {
        const deactivate = (reason = 'ownership-revoked') => {
          armSpeak(false);
          stopCapture();
          stopSpeaking({ reason });
        };
        const unsubscribe = props.access.subscribe(deactivate);
        return () => { unsubscribe(); deactivate('pane-cleanup'); };
      }, [props.access, stopCapture, stopSpeaking]);

      /**
       * One live turn over the bridge's control frames: hello, listen start,
       * binary PCM, listen stop, stt final. Partials arrive while the user is
       * still talking, so the caption fills in and the turn can end on a
       * completed sentence instead of only on silence.
       */
      const startCaptureRef = React.useRef(null);
      /** True while getUserMedia is in flight, so one capture can be opened. */
      const openingRef = React.useRef(false);

      const startCapture = React.useCallback(async (reuse = null) => {
        if (configRequestRef.current === 'post' || !props.access.active()) return;
        /* Opening is asynchronous; without this guard a second call slips in
         * before the first has a stream, and two captures fight for the device. */
        if (!reuse && (liveCapture.current || liveCapture.opening)) {
          diag('mic_busy', { live: liveCapture.current ? liveCapture.current.id : 'opening' });
          return;
        }
        if (!reuse && (openingRef.current || captureRef.current)) {
          diag('mic_ignored', { opening: openingRef.current, open: Boolean(captureRef.current) });
          return;
        }
        const attempt = ++captureEpoch.current;
        const current = () => props.access.active() && captureEpoch.current === attempt;
        let openedStream = null, openedAudio = null;
        liveCapture.opening = true;
        openingRef.current = true;
        if (!reuse) captureRef.current = null;
        setError(null);
        setHeard('');
        if (modeRef.current === 'talk') {
          if (prefsRef.current.character) { stopSpeaking({ reason: 'mic-start' }); characterControl.current?.activity(); }
          setSingleStage('opening');
        }
        partialRef.current = { text: '', at: 0 };
        const turn = {
          socket: null, release: null, started: false,
          heardPlayback: Boolean(voiceRef.current), userSpeech: false, lastEcho: false, finishing: false, openedAt: Date.now(),
        };
        pendingCapture.current = turn;

        let record = reuse;
        let queue = reuse?.queue || null;
        const hold = data => {
          if (!queue.push(data)) {
            voiceTrace('buffer_overflow', queue.stats());
            setError('语音缓冲超过8秒，已停止采集，请重说本句。');
            choose({ mode: 'talk' });
            stopCapture('buffer-overflow');
          }
        };
        if (record) record.feed = hold;
        const finishTurn = (reason) => {
          if (!current() || turn.finishing) return;
          turn.finishing = true;
          if (record) record.feed = hold;
          voiceTrace('turn_finish', { reason, ...queue?.stats() });
          diag('turn_finish', { reason });
          /* The clock starts here: waiting for the transcript after "stop" is
           * what can hang, not the length of the utterance. */
          window.clearTimeout(turn.timer);
          turn.timer = window.setTimeout(() => {
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
          if (!current()) return;
          if (!origin) throw new Error('Cannot reach the host to open the speech socket.');
          const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/aura/asr/live?instance=${encodeURIComponent(props.access.token)}`);
          turn.socket = socket;

          const finalText = new Promise((resolve) => {
            let settled = false;
            turn.release = result => {
              if (settled) return;
              settled = true; turn.finishing = true;
              if (record) record.feed = hold;
              window.clearTimeout(turn.timer);
              window.clearTimeout(turn.noSpeechTimer);
              resolve(result);
            };
            socket.onmessage = (event) => {
              if (!current()) return;
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
                voiceTrace('asr_ready', { degraded: Boolean(message.degraded), waitMs: Date.now() - turn.openedAt, ...queue?.stats() });
                turn.flush?.();
                return;
              }
              if (message.type === 'stt') {
                const text = String(message.text || '');
                if (message.partial) {
                  partialRef.current = { text, at: Date.now() };
                  setHeard(text);
                  /* Somebody is saying something we are not: that is an
                   * interruption, and the recognizer is the authority. */
                  const echo = fromOurVoice(text, spokenRef.current.read());
                  turn.lastEcho = echo;
                  voiceTrace('echo_decision', { partial: true, echo, chars: text.length, referenceChars: spokenRef.current.read().length });
                  if (voiceRef.current) turn.heardPlayback = true;
                  if (text.trim() && !echo) turn.userSpeech = true;
                  if (voiceRef.current && !echo) {
                    diag('barge_heard', { chars: text.length });
                    gaggedRef.current = runSeqRef.current;
                    stopSpeaking({ echoTail: false, reason: 'barge-in' });
                    gateRef.current.active = false;
                    gateRef.current.until = 0;
                  }
                  return;
                }
                // Do not turn the assistant's own completed speech into a
                // fresh user message, even if playback ended before the final.
                const echoOnly = turn.heardPlayback && !turn.userSpeech &&
                  (fromOurVoice(text, spokenRef.current.read()) || (turn.lastEcho && bare(text) === bare(partialRef.current.text)));
                voiceTrace('echo_decision', { partial: false, echo: echoOnly, chars: text.length });
                turn.release({ text: echoOnly ? '' : text });
                return;
              }
              if (message.type === 'error') {
                turn.release({ error: message.message || 'the recognizer failed' });
              }
            };
            socket.onopen = () => {
              if (!current()) { socket.close(); return; }
              socket.send(
                JSON.stringify({
                  type: 'hello',
                  transport: 'websocket',
                  audio_params: { format: 'pcm16', sample_rate: SAMPLE_RATE, channels: 1, frame_duration: 100 },
                }),
              );
            };
            socket.onclose = () => turn.release({ error: 'the speech socket closed' });
            socket.onerror = () => {
              diag('live_error', { phase: 'socket' });
              turn.release({ error: 'the speech socket failed' });
            };
          });

          /* Measured: with echoCancellation on, the microphone reports exactly
           * 0.001 for the whole of a playback — it is being ducked, not quiet.
           * The constraint is a preference so the two can be compared. */
          /* Two mistakes in one experiment: the level of 0.001 that looked like
           * echo cancellation was several dead captures competing for the
           * device (fixed by the stale-capture cleanup), and turning AEC off
           * made the listener voice barely louder than its own echo — 0.09
           * against a 0.10 threshold. Back on, and on by default. */
          const useAec = prefsRef.current.aec !== false;
          const stream = reuse?.stream || await media.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: useAec,
              noiseSuppression: useAec,
              autoGainControl: useAec,
            },
          });
          openedStream = stream;
          turn.stream = stream;
          if (!current()) { for (const track of stream.getTracks()) track.stop(); socket.close(); return; }
          diag('mic_constraints', { aec: useAec });
          const audio = reuse?.audio || new AudioCtor({ sampleRate: SAMPLE_RATE });
          if (audio.sampleRate !== SAMPLE_RATE) throw new Error('Unsupported microphone sample rate: ' + audio.sampleRate);
          queue = queue || createSampleQueue(audio.sampleRate);
          openedAudio = audio;
          turn.audio = audio;
          const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
          try {
            if (!reuse) await audio.audioWorklet.addModule(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          if (!current()) {
            for (const track of stream.getTracks()) track.stop();
            void audio.close(); socket.close(); return;
          }
          const source = reuse?.source || audio.createMediaStreamSource(stream);
          const node = reuse?.node || new AudioWorkletNode(audio, 'aura-capture');
          const sink = reuse?.sink || audio.createGain();
          if (!reuse) {
            sink.gain.value = 0;
            source.connect(node); node.connect(sink); sink.connect(audio.destination);
          }

          const vad = createVad({
            noSpeechChunks: prefsRef.current.mode === 'chat' ? MAX_CHUNKS : Infinity,
            onSpeech() { window.clearTimeout(turn.noSpeechTimer); },
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
              if (reason === 'no_speech' && prefsRef.current.mode !== 'chat') {
                stopCapture('no-speech');
                setError('30 秒内未听到讲话，请再点麦克风重试。');
                return;
              }
              finishTurn(reason);
            },
          });

          void finalText.then(async (result) => {
            if (!current()) return;
            let accepted = !result.error;
            if (result.error) {
              diag('live_final_error', { error: String(result.error).slice(0, 160) });
              setError(String(result.error));
            } else {
              const text = String(result.text || '').trim();
              diag('asr', { chars: text.length, empty: text.length === 0 });
              if (text) {
                setHeard(text);
                if (modeRef.current === 'talk') {
                  // A single utterance releases the real microphone BEFORE
                  // command/prompt RPC, not after the task has been accepted.
                  stopCapture('single-final');
                  const releasedEpoch = captureEpoch.current;
                  const stillSingle = () => props.access.active() && captureEpoch.current === releasedEpoch;
                  setSingleStage('waiting');
                  accepted = await submitText(text, stillSingle);
                  if (!accepted && stillSingle()) setSingleStage('idle');
                  return;
                }
                accepted = await submitText(text, current);
              }
            }
            if (!current()) return;
            if (!accepted) choose({ mode: 'talk' });
            if (accepted && !result.error && prefsRef.current.mode === 'chat') {
              turn.socket.onclose = null;
              turn.socket.close();
              voiceTrace('turn_handoff', { id: record.id, sampleSeq: record.sampleSeq, frames: record.frames, ...queue.stats() });
              void startCaptureRef.current(record);
            } else stopCapture(result.error ? 'asr-error' : 'turn-end');
          });

          record = reuse || { id: ++liveCapture.seq, stream, audio, source, node, sink, queue };
          record.vad = vad; record.socket = socket; record.release = turn.release;
          const feed = data => {
            if (!current()) return;
            if (!turn.started || turn.finishing) hold(data);
            else {
              const tail = vad.push(data);
              if (tail?.length && current()) hold(tail);
            }
          };
          record.feed = feed;
          turn.flush = () => {
            if (!current() || turn.finishing) return;
            queue.drain(data => {
              if (turn.finishing) hold(data);
              else {
                const tail = vad.push(data);
                if (tail?.length && current()) hold(tail);
              }
            });
            voiceTrace('buffer_flush', queue.stats());
          };
          node.port.onmessage = event => {
            record.sampleSeq = (record.sampleSeq || 0) + event.data.length;
            record.frames = (record.frames || 0) + 1;
            record.feed(event.data);
          };
          if (turn.started) turn.flush();
          if (!current()) return;
          const id = record.id;
          if (pendingCapture.current === turn) pendingCapture.current = null;
          liveCapture.current = record;
          try {
            window.__auraCapture = record;
          } catch {
            /* private mode */
          }
          liveCapture.opening = false;
          captureRef.current = record;
          openingRef.current = false;
          setListening(true);
          if (modeRef.current === 'talk' && !turn.finishing && !vad.speech) {
            // Buffered samples can flush in a burst. Count visible listening time instead.
            const listeningAt = Date.now();
            turn.noSpeechTimer = window.setTimeout(() => {
              if (current() && !turn.finishing && modeRef.current === 'talk') vad.end('no_speech', Date.now() - listeningAt);
            }, SINGLE_NO_SPEECH_MS);
          }
          diag('mic_start', { rate: audio.sampleRate, id });
        } catch (failure) {
          if (pendingCapture.current === turn) pendingCapture.current = null;
          for (const track of openedStream?.getTracks() || []) track.stop();
          if (openedAudio) void openedAudio.close();
          if (captureEpoch.current !== attempt || !props.access.active()) { turn.socket?.close(); return; }
          if (reuse) stopCapture('handoff-error');
          openingRef.current = false;
          liveCapture.opening = false;
          choose({ mode: 'talk' });
          diag('mic_error', { message: String((failure && failure.message) || failure).slice(0, 160) });
          setError(String((failure && failure.message) || failure));
          setSingleStage('idle');
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
        if (configRequestRef.current === 'post') return;
        if (callActive) {
          choose({ mode: 'talk' });
          setSingleStage('idle');
          stopCapture();
          gaggedRef.current = runSeqRef.current;
          stopSpeaking({ reason: 'hangup' });
        } else {
          choose({ mode: 'chat' });
          if (!captureRef.current) void startCapture();
        }
      }, [callActive, choose, startCapture, stopCapture, stopSpeaking]);

      const configurationBusy = () => busy || running || runningRef.current || waiting || listening || transcribing || callActive || talking
        || pendingTaskCount > 0 || pendingTaskIds.current.size > 0 || visualBusy.current || !!visualStatus || openingRef.current
        || !!captureRef.current || !!pendingCapture.current || !!voiceRef.current || !!speechAbort.current;
      const configSaveBlocked = configurationBusy();
      const saveVisualConfig = async () => {
        if (configRequestRef.current || configurationBusy() || !visualConfigAvailable || !visualConfig?.editable || !props.access.active()) return;
        const enabled = !visualConfig.enabled;
        configRequestRef.current = 'post'; setVisualConfigRequest('post'); setVisualConfigError('');
        props.access.configurationPending();
        try {
          // Do not abort this POST on Pane unmount: a successful config edit can
          // close the instance before its acknowledgement reaches the browser.
          const response = await fetch('/aura/visual/config', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-aura-instance': props.access.token }, body: JSON.stringify({ enabled }) });
          const value = await response.json();
          if (!response.ok) throw new Error(value?.error || `保存失败（${response.status}）`);
          if (value?.saved !== true || value.enabled !== enabled || value.reopen !== true) throw new Error('未收到有效的保存确认，请重新打开 Aura 核实状态。');
          props.access.configurationSaved();
        } catch (failure) {
          const message = String(failure?.message || failure);
          props.access.configurationFailed(message);
          if (configMounted.current) setVisualConfigError(`保存失败：${message}`);
        } finally {
          configRequestRef.current = null;
          if (configMounted.current) setVisualConfigRequest(null);
        }
      };

      const usesQuickTalk = visualConfig?.provider === 'quicktalk';
      const generationLabel = usesQuickTalk ? 'QuickTalk 回复生成' : '本地回复生成';
      const preparationStage = visualStatus?.state === 'ready' ? PREPARATION_STAGES.ready
        : visualStatus?.provider === 'quicktalk' && visualStatus.stage === 'preflight' ? '连接 QuickTalk'
        : PREPARATION_STAGES[visualStatus?.stage] || visualStatus?.stage || visualStatus?.state;
      const preparationElapsed = Math.max(preparationSeconds, Math.floor(visualStatus?.elapsedSeconds || 0));
      const preparationProgress = Number.isFinite(visualStatus?.progress?.step) && Number.isFinite(visualStatus?.progress?.steps)
        ? ` · ${visualStatus.progress.step}/${visualStatus.progress.steps}` : '';
      const playbackBuffering = visualStatus?.stage === '音画缓冲';
      const playbackPending = visualStatus?.state === 'ready' || visualStatus?.stage === '等待音画播放器就绪';
      const caption = listening ? '正在收音' : transcribing ? '正在转写' : singleStage === 'opening' ? '正在开启麦克风'
        : visualNotice || (talking ? '正在回答' : running || pendingTaskCount > 0 || singleStage === 'waiting' ? '等待回答'
          : prefs.character && !callActive ? `${singleStage === 'initial' ? '未开始' : '待机'} · 麦克风关闭` : heard || phase);
      const interactionBlock = !prefs.character ? '请先显示数字人' : callActive ? '请先结束通话'
        : listening || singleStage === 'opening' || transcribing ? '请先结束收音' : talking ? '回答正在播放' : '';
      const toggleInteractions = () => {
        if (interactionOpen) { setInteractionOpen(false); return; }
        setInteractionOpen(true);
        setInteractionNotice('');
        setInteractionAssets(undefined);
        const player = characterControl.current;
        if (player) void player.interactions().then(setInteractionAssets);
        else setInteractionAssets(null);
      };
      const previewInteraction = id => {
        if (interactionBlock || !characterControl.current?.preview(id)) {
          setInteractionNotice(interactionBlock || '回答即将播放，暂不能预览。');
          return;
        }
        if (singleStage === 'initial') setSingleStage('idle');
        setInteractionOpen(false);
      };

      return h(
        'div',
        { style: PANE, className: prefs.character ? 'aura-character' : undefined,
          'data-aura-phase': phase, ref: paneRef },
        prefs.character && !callActive ? h(SingleCharacter, {
          stage: listening ? 'listening' : visualBusy.current ? singleStage : (running || pendingTaskCount > 0) ? 'waiting' : error ? 'idle' : singleStage, sessionId: props.sessionId, control: characterControl,
          onInteractionError: showInteractionError,
        }) : prefs.character ? h('div', { style: CHARACTER_SURROUND, 'data-aura-visual': 'portrait' },
          h('img', { src: '/aura/character/short-hair.png', style: CHARACTER_IMAGE,
            width: 1113, height: 1414, alt: 'Aura 短发正面半身 · 静态', draggable: false,
            'data-aura-art': 'short-hair-static-v1',
            onLoad: event => diag('portrait_loaded', { art: 'short-hair-static-v1',
              width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) })) : null,
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
                h('label', { className: 'aura-row' },
                  h('input', { type: 'checkbox', checked: !!prefs.character,
                    onChange: event => choose({ character: event.target.checked }) }),
                  '显示数字人'),
                h('div', { 'data-aura-visual-config': true, style: { display: 'grid', gap: 6, margin: '8px 0' } },
                  h('div', { role: 'status', 'aria-live': 'polite' },
                    `${generationLabel}：${visualConfigAvailable ? visualConfig.enabled ? '已启用' : '已关闭' : '状态不可用'}`),
                  h('div', { className: 'aura-row' },
                    h('button', { type: 'button', className: 'aura-act',
                      'aria-label': `切换${generationLabel}`,
                      disabled: !!visualConfigRequest || configSaveBlocked || !visualConfigAvailable || !visualConfig?.editable,
                      onClick: saveVisualConfig },
                    visualConfigRequest === 'post' ? '正在保存…' : (visualConfigAvailable && visualConfig.enabled ? '关闭' : '启用') + generationLabel),
                    h('button', { type: 'button', className: 'aura-act',
                      'aria-label': `刷新${generationLabel}状态`, disabled: !!visualConfigRequest,
                      onClick: refreshVisualConfig }, visualConfigRequest === 'get' ? '读取状态…' : '刷新状态')),
                  visualConfigRequest === 'post' ? h('div', { role: 'status' }, '正在保存配置；成功后 Aura 将重启，请重新打开 Aura。') : null,
                  visualConfigAvailable && !visualConfig.editable ? h('div', { className: 'aura-id-mono' }, visualConfig.reason || '此配置当前不可编辑。') : null,
                  configSaveBlocked ? h('div', { className: 'aura-id-mono', style: { whiteSpace: 'normal' } }, '请先结束收音、通话、任务及播放，再修改配置。') : null,
                  visualConfigError ? h('div', { role: 'alert', style: ERROR }, visualConfigError) : null,
                  h('div', { className: 'aura-id-mono', style: { whiteSpace: 'normal', lineHeight: 1.5 } },
                    `环境：未检测（只读取配置，不执行 TTS 或模型预检）。${visualConfigAvailable ? ` Host v${visualConfig.version}` : ''}`)),
                h('div', { className: 'aura-id-mono', style: { whiteSpace: 'normal', lineHeight: 1.5 } },
                  '单句数字人需选择女声 + CosyVoice 3.0 Flash（非 3.5），不自动换声。关麦后进入低频互动。'
                    + (usesQuickTalk ? '' : '本地离线生成曾耗时约 54 分钟（非实时）。')),
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
          { style: STAGE, role: 'group', 'aria-label': `Aura ${visualPhase}` },
          prefs.character ? null : h('canvas', { ref: canvasRef, style: CANVAS,
            'data-aura-visual': 'orb', 'aria-hidden': true }),
          h('div', { className: 'aura-actions' },
            h('button', {
                type: 'button',
                className: 'aura-call',
                'data-active': String(callActive),
                title: callActive ? '挂断' : '通话',
                'aria-label': callActive ? 'End call' : 'Start call',
                'aria-pressed': String(callActive),
                disabled: visualConfigRequest === 'post',
                onClick: toggleCall,
              },
              callActive ? h(HangupIcon, null) : h(PhoneIcon, null)),
            h('button', { type: 'button', className: 'aura-act aura-interactions', 'aria-expanded': interactionOpen,
              onClick: toggleInteractions }, '互动'),
            interactionOpen ? h('div', { className: 'aura-actions-menu', role: 'group', 'aria-label': '动作预览',
              onKeyDown: event => { if (event.key === 'Escape') setInteractionOpen(false); } },
              h('small', null, '动作预览'),
              MANUAL_ACTIONS.map(([action, label]) => {
                const asset = interactionAssets?.find(item => item.action === action);
                const reason = interactionBlock || (interactionAssets === undefined ? '正在读取素材'
                  : interactionAssets === null ? '素材目录不可用' : !asset?.available ? asset?.reason || '暂无可用素材' : '');
                return h('button', { key: action, type: 'button', className: 'aura-act', disabled: !!reason,
                  onClick: () => previewInteraction(asset.id) }, label,
                  action === 'wave' && asset?.available ? h('small', null, '旧版全身预览') : null,
                  reason ? h('small', null, reason) : null);
              }),
              interactionNotice ? h('small', { role: 'status' }, interactionNotice) : null) : null,
          ),
        ),
        h(
          'div',
          { className: 'aura-status', 'data-aura-status-bar': true,
            style: { ...CAPTION, textTransform: 'none', opacity: error ? 1 : .85 }, title: error || heard || undefined },
          error ? h('span', { role: 'alert', style: ERROR }, error)
            : visualStatus ? h('span', { 'data-aura-preparation': true,
              role: 'group', 'aria-label': '本次回答音画准备', title: '切换会话、关闭或刷新会取消这次生成' },
              h('span', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
                playbackBuffering ? '本次回答音画正在缓冲' : playbackPending ? '音画就绪等待播放' : `准备回答 · ${preparationStage}`),
              h('span', { className: 'aura-preparation-detail', 'aria-live': 'off' }, ` · 已用 ${preparationElapsed} 秒${preparationProgress}`))
            : h('span', { role: 'status' }, caption),
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
              disabled: visualConfigRequest === 'post',
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
                disabled: visualConfigRequest === 'post',
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
                disabled: busy || visualConfigRequest === 'post' || draft.trim() === '',
                onClick: send,
              },
              h(SendIcon, null),
            ),
            (running || talking || visualStatus)
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
                      stopSpeaking({ reason: 'silence-button' });
                    },
                  },
                  h(HaltIcon, null),
                )
              : null,
          ),
          prefs.character && !callActive ? null : h('div', { className: 'aura-id-mono', style: { whiteSpace: 'normal', lineHeight: 1.5 } },
            '简单问题直接答，任务独立执行。插话或挂断不停止任务；普通模式：/aura off。'),
        ),
      );
    }

    /** Slot entry: the boundary keeps a crash visible instead of blank. */
    const AuraPane = (props) => h(Boundary, null, h(InstancePane, { ...props, key: props.sessionId }));

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
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        diag('apply');
        // The Host owns module replacement. Never force a whole-app refresh
        // from an Aura timer: it can discard unrelated transient UI state.
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
                    description: () => 'Voice conversation with independent tasks; interrupt speech without stopping work.',
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

