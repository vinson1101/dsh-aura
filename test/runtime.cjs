/* Optional integration test against the installed DSH modules.
 * ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" test/runtime.cjs
 * DSH_INSTALL_DIR must identify the running DSH package.
 * No profile, sessions, network or models are changed.
 */
const assert = require('node:assert/strict');
const native = name => require(require.resolve(name, { paths: [process.env.DSH_INSTALL_DIR] }));
const { Context } = native('@deepseek-ai/cordis');
const { SystemPrompt } = native('@deepseek-ai/dsh-system-prompt');
const { ToolsService } = native('@deepseek-ai/dsh-tools');
const { createScope } = native('@deepseek-ai/dsh-scope');
const { mountForeground } = require('../tasks.js');

(async () => {
  const root = new Context();
  await root.plugin(SystemPrompt).await();
  await root.plugin(ToolsService).await();
  await root.inject(['tools', 'systemPrompt'], async ctx => {
  const definition = name => ({ name, description: name, parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) });
  ctx.tools.register(definition('global_tool'));
  const presetKey = {};
  const preset = createScope(ctx, presetKey);
  preset.ctx.tools.register(definition('bash'));
  preset.ctx.tools.register(definition('list_agents'));
  preset.ctx.tools.register(definition('send_message'));
  const agent = { session: { header: { cwd: process.cwd() } } };
  const foreground = createScope(ctx, agent, { parent: presetKey });
  agent.ctx = foreground.ctx;
  const worker = {};
  const workerScope = createScope(ctx, worker, { parent: presetKey });
  let dispatched;
  const disable = mountForeground(agent, {
    resolveMaxDepth: () => 1,
    async startActivation(spec) { dispatched = spec; return { childId: 'worker-id', name: 'worker' }; },
  });
  foreground.ctx.tools.register(definition('late_agent_tool'));
  const check = (who, name) => ctx.tools.checkGuards({ agent: who, name });
  for (const name of ['global_tool', 'bash', 'late_agent_tool']) assert.match(check(agent, name).reason, /aura_task/);
  for (const name of ['list_agents', 'send_message', 'aura_task', 'aura_interrupt_task', 'run_code']) assert.equal(check(agent, name), undefined);
  assert.equal(check(worker, 'bash'), undefined, 'fresh worker retains its full preset');
  assert.equal(check(undefined, 'global_tool'), undefined, 'ordinary sessions remain unchanged');
  assert.equal(ctx.tools.get('aura_task', worker), undefined, 'foreground tools do not leak to workers');
  assert.equal(ctx.tools.get('aura_task'), undefined, 'foreground tools are not global');
  const task = ctx.tools.get('aura_task', agent);
  const signal = new AbortController();
  const result = await task.execute({ description: 'native-contract', prompt: 'Full authorized context' }, { signal: signal.signal });
  assert.equal(result.status, 'dispatched');
  assert.equal(dispatched.parent, agent);
  assert.equal(dispatched.delivery, 'parent');
  signal.abort();
  disable();
  assert.equal(check(agent, 'bash'), undefined, 'off restores ordinary execution');
  assert.equal(ctx.tools.get('aura_task', agent), undefined);
  await foreground.dispose();
  await workerScope.dispose();
  await preset.dispose();
  }).await();
  await root.fiber.dispose();
  console.log('runtime.cjs: real Cordis registration, native tool schemas, scoped guards, worker isolation and cleanup ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
