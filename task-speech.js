import { randomUUID } from 'node:crypto';

/** Runtime-only attribution, never a second prompt or a durable notification log.
 * Reserve the native child identity BEFORE dispatch: even synchronous settlement
 * and claimed events before the activation receipt belong to exactly one task. */
export function installTaskSpeech(ctx, deliver) {
  const tasks = new Map(), turns = new Map(), seen = new Set(), recent = new Map();
  const bound = (map, max = 256) => { while (map.size > max) map.delete(map.keys().next().value); };
  const key = (id, turn) => `${id}:${turn}`;
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const source = message.source;
    if (!['subagent-settled', 'agent-message'].includes(source?.kind)) return;
    const task = tasks.get(source.senderSessionId);
    if (!task || task.parent !== agent.id) return;
    // Native manager omits closing output after a last-action send_message.
    // Once that relay has a completed parent answer, its success-only closing
    // notice contains no new result and must not cause a paraphrased repeat.
    if (source.kind === 'subagent-settled' && source.stopReason === 'completed' && task.relayReported
      && message.content?.some(b => b.type === 'text' && b.text === 'It sent you a message just before finishing, so its closing message is omitted.')) return;
    if (source.kind === 'agent-message') task.relayTurn = turn;
    const k = key(agent.id, turn);
    if (seen.has(k)) return;
    let state = turns.get(k);
    if (!state) turns.set(k, state = { sessionId: agent.id, turn, children: new Set(), text: '' });
    state.children.add(source.senderSessionId);
    // The stop reason stays in the native message seen by the parent model.
    // We speak only its actual answer, never turn failures into a success notice.
    if (source.kind === 'subagent-settled') task.settled = true;
    bound(turns);
  });
  ctx.on('session/event', (session, event) => {
    const state = turns.get(key(session.id, event.data?.turn));
    if (!state) return;
    if (event.type === 'assistant/message') {
      const { message, interrupted } = event.data;
      // A tool-bearing intermediate step is not a final user-facing summary.
      state.text = !interrupted && !message.content.some(b => b.type === 'tool-call')
        ? message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').replace(/```[\s\S]*?(?:```|$)/g, ' ').trim().slice(0, 1200) : '';
    }
    if (event.type !== 'turn/end') return;
    const k = key(session.id, state.turn);
    turns.delete(k); seen.add(k); bound(seen);
    if (event.data.reason.kind !== 'completed' || !state.text) return;
    // Native send_message followed by settlement can produce the same parent
    // answer twice. Suppress identical summaries for the same exact task(s).
    const children = [...state.children].sort();
    for (const child of children) {
      const task = tasks.get(child);
      if (task?.relayTurn === state.turn) task.relayReported = true;
    }
    const duplicate = children.every(child => recent.get(child) === state.text);
    for (const child of children) { recent.set(child, state.text); bound(recent); }
    if (!duplicate) deliver(state.sessionId, { type: 'task-summary', key: k, turn: state.turn, text: state.text });
  });
  ctx.on('agent/disposed', ({ agent }) => {
    for (const [child, task] of tasks) if (task.parent === agent.id) tasks.delete(child);
    for (const [k, state] of turns) if (state.sessionId === agent.id) turns.delete(k);
  });
  ctx.effect(() => () => { tasks.clear(); turns.clear(); seen.clear(); recent.clear(); });
  return {
    reserve(parent) {
      const childId = `session-${randomUUID()}`;
      tasks.set(childId, { parent: parent.id }); bound(tasks);
      return childId;
    },
    forget(childId) { tasks.delete(childId); },
  };
}
