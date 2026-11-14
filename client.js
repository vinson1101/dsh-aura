/**
 * dsh-aura — browser half.
 *
 * One canvas, 1900 precomputed points on a golden-angle sphere. No WebGL, no 3D
 * library, no image assets, no network. The orb breathes at rest, turns faster
 * while a session runs, and takes a colour per phase read from the Session UI
 * status snapshot.
 *
 * Geometry and palette derive from the Zebra desktop assistant's orb.
 */
window.__ModuleLoader__.load({
  id: 'dsh-aura',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

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
     * Paints the orb into `canvas` and returns `{ refresh, dispose }` rather
     * than a bare cleanup, because the caller must also force a redraw when the
     * phase changes while `prefers-reduced-motion` is on: in that mode no frame
     * is ever scheduled, so nothing else would repaint.
     */
    function mountOrb(canvas, readPhase) {
      const ctx = canvas.getContext('2d');
      if (!ctx) return { refresh() {}, dispose() {} };
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      let frame;
      let elapsed = 0;
      let previous = 0;
      let disposed = false;

      function draw(now) {
        frame = undefined;
        if (disposed) return;
        const quiet = motion.matches;
        if (previous && !quiet) elapsed += Math.min(50, now - previous);
        previous = now;

        const side = Math.min(
          920,
          Math.round(canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2)),
        );
        if (!side) return;
        if (canvas.width !== side || canvas.height !== side) canvas.width = canvas.height = side;

        const phase = readPhase() || 'idle';
        const tone = TONE[phase] || TONE.idle;
        const fast = phase === 'running';
        const t = elapsed / 1000;
        const angle = t * (SPIN[phase] || SPIN.idle);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const mid = side / 2;
        const radius = side * (0.36 + 0.008 * Math.sin(t * (fast ? 6 : 2)));

        ctx.clearRect(0, 0, side, side);
        const glow = ctx.createRadialGradient(mid, mid, 0, mid, mid, radius * 1.2);
        glow.addColorStop(0, `rgba(${tone},.21)`);
        glow.addColorStop(0.68, `rgba(${tone},.06)`);
        glow.addColorStop(1, `rgba(${tone},0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, side, side);

        const groups = Array.from({ length: 6 }, () => []);
        for (const [x, y, z, seed] of POINTS) {
          const depth = z * cos - x * sin;
          const wave = 1 + 0.035 * Math.sin(10 * y + t * 2 + seed);
          const strength = (depth + 1) * 0.5;
          groups[Math.min(5, Math.floor(strength * 6))].push([
            mid + (x * cos + z * sin) * radius * wave,
            mid + y * radius * wave,
            Math.max(0.48, side * (0.0008 + 0.0014 * strength)),
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

        if (!quiet && !document.hidden) frame = window.requestAnimationFrame(draw);
      }

      function refresh() {
        if (disposed) return;
        if (frame !== undefined) window.cancelAnimationFrame(frame);
        previous = 0;
        draw(window.performance.now());
      }

      const resize = new ResizeObserver(() => {
        if (motion.matches || frame === undefined) refresh();
      });
      resize.observe(canvas);
      motion.addEventListener('change', refresh);
      document.addEventListener('visibilitychange', refresh);
      refresh();

      return {
        refresh,
        dispose() {
          disposed = true;
          if (frame !== undefined) window.cancelAnimationFrame(frame);
          frame = undefined;
          resize.disconnect();
          motion.removeEventListener('change', refresh);
          document.removeEventListener('visibilitychange', refresh);
        },
      };
    }

    /** How long the orb stays green after a run settles. */
    const SETTLED_MS = 3500;

    /* Selectors run on every status snapshot, so they return primitives: an
     * object would change identity each time and re-render the orb's owner. */
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

    const WRAP = {
      position: 'fixed',
      right: 18,
      bottom: 88,
      zIndex: 30,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'flex-end',
      /* The overlay layer is click-through; the orb opts back in. */
      pointerEvents: 'none',
    };
    const BALL = {
      pointerEvents: 'auto',
      display: 'grid',
      placeItems: 'center',
      margin: 0,
      padding: 0,
      border: 'none',
      background: 'transparent',
      transition: 'width 160ms ease, height 160ms ease',
    };
    const CANVAS = { display: 'block', width: '100%', height: '100%' };

    function Aura(props) {
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
      const orbRef = React.useRef(null);

      React.useEffect(() => {
        const orb = mountOrb(canvasRef.current, () => phaseRef.current);
        orbRef.current = orb;
        return () => {
          orbRef.current = null;
          orb.dispose();
        };
      }, []);

      React.useEffect(() => {
        if (orbRef.current) orbRef.current.refresh();
      }, [phase]);

      const [hovered, setHovered] = React.useState(false);
      const size = hovered ? 104 : 88;

      return h(
        'div',
        { style: WRAP },
        h(
          'div',
          {
            style: { ...BALL, width: size, height: size },
            onPointerEnter: () => setHovered(true),
            onPointerLeave: () => setHovered(false),
            role: 'img',
            'aria-label': `Aura ${phase}`,
            'data-aura-phase': phase,
          },
          h('canvas', { ref: canvasRef, style: CANVAS }),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-aura', order: 40 }, Aura),
        );
      },
    };
  },
});
