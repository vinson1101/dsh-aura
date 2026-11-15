// UI-only transport seam. Host mutual exclusion is tested with real ws sockets
// in instance.test.mjs; these tests exercise the real Client wrapper/lifetimes.
export const controls = [];
let owner = null;
export function withInstanceSocket(SpeechSocket = class {}) {
  return class extends SpeechSocket {
    constructor(url) {
      if (!String(url).includes('/aura/instance?')) { super(url); return; }
      const socket = {
        readyState: 1,
        send(value) {
          if (value === 'heartbeat') this.onmessage?.({ data: JSON.stringify({ type: 'heartbeat' }) });
        },
        close() {
          if (this.readyState === 3) return;
          this.readyState = 3;
          if (owner === this) owner = null;
          this.onclose?.({});
        },
      };
      controls.push(socket);
      const sessionId = new URL(url).searchParams.get('sessionId');
      const busy = owner;
      if (!busy) owner = socket;
      setTimeout(() => {
        if (socket.readyState !== 1) return;
        socket.onmessage?.({ data: JSON.stringify(busy
          ? { type: 'busy', sessionId: busy.sessionId }
          : { type: 'owned', sessionId, token: `test-instance-${controls.length}`, timeoutMs: 12000 }) });
        if (busy) socket.close();
      }, 1);
      socket.sessionId = sessionId;
      return socket;
    }
  };
}
