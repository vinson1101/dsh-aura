import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

/** One Aura seat per Host activation/runtime, shared by every browser window.
 * This owns UI/audio resources only. It never cancels an Agent or worker. */
export function installInstance(ctx, { heartbeatMs = 4000, timeoutMs = 12000 } = {}) {
  const sockets = new WebSocketServer({ noServer: true });
  let owner = null;
  const release = (seat) => {
    if (owner !== seat) return;
    owner = null;
    for (const stop of seat.resources) { try { stop(); } catch {} }
    seat.resources.clear();
  };
  const authorize = (token, stop) => {
    const seat = owner;
    if (!seat || seat.token !== token || seat.peer.readyState !== 1) return null;
    seat.resources.add(stop);
    return () => seat.resources.delete(stop);
  };
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/aura/instance',
    handler(request, socket, head) {
      const sessionId = new URL(request.url, 'http://localhost').searchParams.get('sessionId');
      sockets.handleUpgrade(request, socket, head, peer => {
        if (!sessionId || sessionId.length > 256) { peer.close(1008, 'Session identity required'); return; }
        if (owner) {
          peer.send(JSON.stringify({ type: 'busy', sessionId: owner.sessionId }));
          peer.close(1000, 'Aura is already open');
          return;
        }
        const seat = { sessionId, peer, token: randomUUID(), resources: new Set(), seen: Date.now() };
        owner = seat; // Publication is synchronous: concurrent claims cannot both win.
        peer.on('message', data => {
          if (String(data) === 'heartbeat' && owner === seat) {
            seat.seen = Date.now();
            peer.send(JSON.stringify({ type: 'heartbeat' }));
          }
        });
        peer.on('error', () => { release(seat); peer.terminate(); });
        peer.on('close', () => release(seat));
        peer.send(JSON.stringify({ type: 'owned', token: seat.token, sessionId, timeoutMs }));
      });
    },
  }), 'dsh-aura: runtime singleton route');
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (owner && Date.now() - owner.seen > timeoutMs) {
        const stale = owner;
        release(stale);
        stale.peer.terminate();
      }
    }, heartbeatMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      if (owner) release(owner);
      for (const peer of sockets.clients) peer.terminate();
      sockets.close();
    };
  }, 'dsh-aura: runtime singleton lifetime');
  return { authorize };
}
