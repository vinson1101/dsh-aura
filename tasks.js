/** Aura's foreground is agent-scoped; native managed activations own the work. */
export const FOREGROUND_PROMPT = `## Aura 前台对话
你是 Aura 的实时对话前台，不是任务执行器。简单问题直接简短回答；查资料、读写文件、运行命令、测试等实际工作交给 aura_task，然后立即确认已派发并结束本轮，不等待、不轮询。
派发必须提供完整上下文：用户目标、已知事实、相关路径、约束、授权边界、验收标准；执行者不继承这段对话。不要把猜测当成事实，不要扩大用户授权。
收到新话题就立即回应新话题；插话只替换前台回答，不代表取消已经派发的任务。只有用户明确要求停止某个任务才使用 aura_interrupt_task，目标不清楚先问。任务的后代是独立任务，若需停止也须逐个明确处理。
需要了解状态时使用 list_agents；给任务补充信息使用 send_message。插话没听到派发回执不等于未接单：先查 list_agents 中同一任务及子会话ID，不得仅因回执未播报而重派；明确尚未接受或派发失败才报告真实状态。收到执行者进度或原生完成通知，向用户简短汇报真实结果，不编造成功、不朗读日志。若工具缺失，明确说明，不要声称已经派发。
语音回答通常一两句，先结论后理由。`;

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

export function mountForeground(agent, subagents, taskSpeech) {
  const tools = agent.ctx.get('tools');
  const prompts = agent.ctx.get('systemPrompt');
  const disposers = [];
  try {
    disposers.push(tools.register({
      name: 'aura_task',
      description: 'Dispatch actual work to an independent managed worker, then return immediately. Supply all relevant conversation context, constraints, user authorization and acceptance criteria. Never wait for its result here.',
      parameters: {
        type: 'object', properties: {
          description: { type: 'string', description: 'Short task label.' },
          prompt: { type: 'string', description: 'Self-contained task and all necessary context.' },
        }, required: ['description', 'prompt'], additionalProperties: false,
      },
      output,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const childId = taskSpeech?.reserve(agent);
        let started;
        try {
          started = await subagents.startActivation({
            ...(childId ? { childId } : {}),
            provider: 'spawn', parent: agent, label: args.description,
            cwd: agent.session.header.cwd,
            prompt: [{ type: 'text', text: `${args.prompt}\n\n你是独立任务执行者。按用户授权完成实际工作；前台插话不是取消信号。关键阶段可通过 list_agents 确认派发你的父级名称，再用 send_message 向其汇报简短进度，不要高频轮询。完成后给出结果、验证及限制；不要仅启动 shell 后台工作就宣称任务完成。` }],
            signal: exec.signal, delivery: 'parent',
            maxDepth: subagents.resolveMaxDepth(),
          });
        } catch (error) { taskSpeech?.forget(childId); throw error; }
        // Do not await result, bind signal after publication, or dispose on turn end.
        return { name: started.name, sessionId: started.childId, status: 'dispatched' };
      },
    }));
    disposers.push(tools.register({
      name: 'aura_interrupt_task',
      description: 'Only after an explicit user request: stop the selected descendant worker current execution. Does not stop independent descendants; stop those separately if requested. Never call for natural conversation interruption.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      output,
      async execute(args, exec) {
        const id = await subagents.resolveName(agent, args.name, exec.signal);
        exec.signal.throwIfAborted();
        subagents.interrupt(id, { kind: 'ancestor', agent });
        return { name: args.name, status: 'interrupt-requested' };
      },
    }));
    // A scope-local monotonic guard covers preset and same-agent tools alike.
    // Keep the inherited catalog stable; restriction masks exempt own-scope
    // registrations and cannot reliably enforce foreground-only execution.
    // run_code is only the PTC transport: its inner calls remain guarded.
    const allowed = ['aura_task', 'aura_interrupt_task', 'list_agents', 'send_message', 'run_code'];
    disposers.push(tools.guard(exec => allowed.includes(exec.name) ? undefined : 'Aura foreground only dispatches work. Use aura_task; do not execute work in this conversation.'));
    disposers.push(prompts.section({ name: 'aura-foreground', order: 950, text: FOREGROUND_PROMPT }));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
}

/** Replay only successful native command records, not invented session events. */
export function foregroundEnabled(events) {
  const pending = new Map();
  let enabled = false;
  for (const event of events) {
    if (event.type === 'command/run' && event.data.name === 'aura') pending.set(event.data.commandId, event.data.args?.trim());
    if (event.type === 'command/done') {
      const action = pending.get(event.data.commandId);
      if (event.data.kind === 'success' && (action === 'on' || action === 'off')) enabled = action === 'on';
      pending.delete(event.data.commandId);
    }
  }
  return enabled;
}

export function installTaskLayer(ctx, taskSpeech) {
  const mounted = new Map();
  const enable = agent => {
    if (!mounted.has(agent)) mounted.set(agent, mountForeground(agent, ctx.subagents, taskSpeech));
  };
  const disable = agent => { mounted.get(agent)?.(); mounted.delete(agent); };
  ctx.commands.register({
    name: 'aura', description: 'Aura foreground: on, off, or interrupt (foreground only).',
    input: { hint: 'on | off | interrupt' },
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted();
      const action = rawInput.trim();
      if (action === 'on') {
        if (!mounted.has(agent) && agent.status === 'running' && !foregroundEnabled(agent.session.snapshotEvents())) {
          return { kind: 'error', text: 'This session is already doing ordinary work. Enable Aura when it is idle or use a new session; existing work was not interrupted.' };
        }
        enable(agent);
      }
      else if (action === 'off') disable(agent);
      else if (action === 'interrupt') {
        if (!mounted.has(agent)) return { kind: 'error', text: 'Aura foreground is not enabled.' };
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        // Do not re-arm the client voice until obsolete foreground output has
        // drained. This never waits for manager-owned worker completion.
        return agent.whenIdle().then(() => ({ kind: 'success' }));
      } else return { kind: 'error', text: 'Use /aura on, /aura off, or /aura interrupt.' };
      return { kind: 'success' };
    },
  });
  ctx.on('agent/created', ({ agent }) => { if (foregroundEnabled(agent.session.snapshotEvents())) enable(agent); });
  ctx.on('agent/disposed', ({ agent }) => disable(agent));
  for (const agent of ctx.agents.list()) {
    if (foregroundEnabled(agent.session.snapshotEvents())) enable(agent);
  }
  ctx.effect(() => () => { for (const agent of mounted.keys()) disable(agent); });
}
