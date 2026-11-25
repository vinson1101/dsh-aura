/** Read-only status and explicit, owner-authenticated local enablement. No TTS or inference. */
export function installVisualSettings(ctx, { instance, enabled, version, provider = 'latentsync' }) {
  const editable = () => ctx.fiber?.entry !== undefined && ctx.get?.('configEditor') !== undefined;
  const json = (status, value) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/aura/visual/config',
    async resource(request, peer) {
      if (!peer) {
        const connection = ctx.get?.('connection');
        const rejection = connection ? connection.requestRejection(request) : 401;
        if (rejection) return json(rejection, { error: 'Browser authentication required' });
      }
      if (request.method === 'GET') {
        const canEdit = editable();
        return json(200, { version, enabled, provider, editable: canEdit,
          ...(!canEdit ? { reason: '当前运行环境不能保存配置' } : {}) });
      }
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
      let revoked = false;
      const release = instance.authorize(request.headers.get('x-aura-instance'), () => { revoked = true; });
      if (!release) return json(409, { error: '请先在当前会话打开 Aura' });
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
          return json(400, { error: 'application/json required' });
        }
        // Bounded streaming read; never materialize an arbitrary request body.
        const reader = request.body?.getReader();
        let size = 0, text = '';
        const decoder = new TextDecoder();
        if (reader) try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 256) { await reader.cancel(); return json(400, { error: 'Oversized config body' }); }
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
        let body;
        try { body = JSON.parse(text); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') {
          return json(400, { error: 'Only enabled:boolean is accepted' });
        }
        if (!editable()) return json(503, { error: '当前运行环境不能保存配置' });
        // Saving ordinary config restarts this plugin. No audio/provider is invoked.
        const entry = ctx.fiber.entry;
        const editor = ctx.get('configEditor');
        const assertOwner = () => {
          if (revoked || request.signal.aborted) throw Object.assign(new Error('Aura ownership was lost; reopen and retry'), { status: 409 });
        };
        assertOwner();
        await editor.edit(entry, current => {
          assertOwner();
          return { ...current, visualResponse: { ...current.visualResponse, enabled: body.enabled } };
        });
        return json(200, { saved: true, enabled: body.enabled, reopen: true });
      } catch (error) {
        return json(error.status || 500, { error: String(error.message || error).slice(0, 240) });
      } finally { release(); }
    },
  }), 'dsh-aura: explicit local visual settings');
}
