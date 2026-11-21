import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { createCompanion } from './companion.mjs';

export const name = 'whalenest-aurabot-sdk';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm', 'tools', 'systemPrompt', 'permissionPresets',
  'agentDefaultModel','attachments','fileUploads','fs','remoteAccess','sessionProjections','sessionQuery','typert','typertGateway','workspaceRegistry','timer'];

// Local stdio is an integration/testing entry. Future platform adapters pass
// authenticated envelopes to this same host; this is not an HTTP endpoint.
export function apply(ctx, config) {
  let lines;
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const start = async () => {
    const options = JSON.parse(readFileSync(config.configPath, 'utf8'));
    const runtime = await createCompanion(ctx, options, {configPath:config.configPath});
    ctx.provide('whaleNest', runtime);
    lines = createInterface({ input: process.stdin });
    let tail = Promise.resolve();
    lines.on('line', line => {
      tail = tail.then(async () => {
        let request;
        try {
          request = JSON.parse(line);
          let result;
          if (request.method === 'receive') result = await runtime.receive(request.input);
          else if (request.method === 'status') result = runtime.status();
          else if (request.method === 'outbox') result = runtime.outbox();
          else if (request.method === 'memory.list') result = runtime.memory.list('');
          else if (request.method === 'memory.consolidate') result = await runtime.memoryAdapter.consolidate();
          else if (request.method === 'background.configure') result = runtime.policy.configure(request.patch);
          else if (request.method === 'memory.update') {
            assert.ok(typeof request.memoryId === 'string' && typeof request.text === 'string'
              && request.text.trim() && request.text.length <= 200, 'Memory update requires an ID and 1..200 characters');
            result = runtime.memory.update(request.memoryId, { text: request.text.trim() });
          }
          else if (request.method === 'memory.delete') result = runtime.memory.remove(request.memoryId);
          else if (request.method === 'migration.import') result = await runtime.importLegacy(request.snapshot);
          else if (request.method === 'migration.rollback') result = await runtime.rollbackLegacy(request.sourceHash);
          else if (request.method === 'shutdown') {
            await runtime.dispose(); send({ id: request.id, ok: true });
            lines.close(); await ctx.root.dispose(); process.exitCode = 0; return;
          } else throw new Error('Unknown method');
          send({ id: request.id, ok: true, result });
        } catch (error) { send({ id: request?.id, ok: false, error: error.message }); }
      }).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
    });
    ctx.effect(() => async () => { lines?.close(); await runtime.dispose(); });
    send({ type: 'ready', ...runtime.status() });
  };
  start().catch(error => { process.stderr.write(`[whalenest] ${error.stack}\n`); process.exit(1); });
}
