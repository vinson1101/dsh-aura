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

    const VERSION = '0.5.0';

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
     * Paints the orb into `canvas` and returns `{ refresh, dispose }` rather
     * than a bare cleanup, because the caller must also force a redraw when the
     * phase changes while `prefers-reduced-motion` is on: in that mode no frame
     * is ever scheduled, so nothing else would repaint.
     *
     * The sphere fits the smaller canvas dimension, so a tall pane and a wide
     * pane both stay inside their box.
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

        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const side = Math.min(
          920,
          Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * ratio),
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

    const PANE = {
      height: '100%',
      minHeight: 0,
      display: 'grid',
      gridTemplateRows: '1fr auto auto',
      gap: 10,
      padding: 16,
      boxSizing: 'border-box',
    };
    const STAGE = { width: '100%', height: '100%', minHeight: 160, display: 'grid', placeItems: 'center' };
    const CANVAS = { display: 'block', width: '100%', height: '100%' };
    const CAPTION = {
      font: 'inherit',
      fontSize: 11,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      opacity: 0.55,
      color: 'var(--dsw-alias-text-secondary, inherit)',
      userSelect: 'none',
    };

    const FOOTER = { display: 'grid', gap: 6 };
    const ROW = { display: 'flex', gap: 6, alignItems: 'flex-end' };
    const INPUT = {
      flex: 1,
      minHeight: 34,
      maxHeight: 120,
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
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      const send = React.useCallback(async () => {
        const text = draft.trim();
        if (!text || busy) return;
        const session = bindSession(props.sessionId);
        if (!session) {
          setError('No live session for this pane.');
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const result = await session.prompt([{ type: 'text', text }], 'queue');
          if (result && result.ok === false) {
            setError((result.error && result.error.message) || 'The session refused the message.');
          } else {
            setDraft('');
          }
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setBusy(false);
        }
      }, [draft, busy, props.sessionId]);

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

      return h(
        'div',
        { style: PANE, 'data-aura-phase': phase },
        h(
          'div',
          { style: STAGE, role: 'img', 'aria-label': `Aura ${phase}` },
          h('canvas', { ref: canvasRef, style: CANVAS }),
        ),
        h('div', { style: CAPTION }, phase),
        h(
          'div',
          { style: FOOTER },
          h(
            'div',
            { style: ROW },
            h('textarea', {
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

        /* Visible probe in a slot the shipped templates use, so "the bundle
         * runs" and "the right bar renders my body" can be told apart without a
         * console. Removed once the pane renders. */
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: TAB_ID + '-probe', order: 900 },
            function AuraProbe() {
              return h(
                'div',
                {
                  style: {
                    fontSize: 11,
                    lineHeight: 1.4,
                    padding: '2px 4px',
                    opacity: 0.7,
                    color: 'var(--dsw-alias-text-secondary, inherit)',
                    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  },
                },
                'aura ' + VERSION + ' · bundle ok · pane ' +
                  (registrations.ready ? 'registered' : 'NOT registered'),
              );
            },
          ),
        );

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
