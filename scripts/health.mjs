import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
const socketPath = process.argv[2] ?? join(homedir(), '.clawnest-integrations/deepseek-harness/control.sock');
try {
  const health = await new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/integration/health' }, response => {
      let body = ''; response.on('data', b => body += b);
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('Health timeout')));
  });
  const result = { ready: health.ready === true, connected: health.connected === true, draining: health.draining === true };
  console.log(JSON.stringify(result));
  process.exitCode = result.ready && result.connected && !result.draining ? 0 : 1;
} catch (error) { console.log(JSON.stringify({ error: error.code ?? 'health-unavailable' })); process.exitCode = 1; }
