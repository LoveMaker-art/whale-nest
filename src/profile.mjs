import { mkdir, writeFile, symlink, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
/** Only creates/updates our isolated profile, never a user's existing sdk profile. */
export async function prepareProfile(home, configPath, { fixture = false, bridgeEntry = null, externalOverlay = false } = {}) {
  const config = await readFile(configPath);
  const profile = join(resolve(home), 'profiles/whalenest');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const packageFile = join(profile, 'package.json');
  const packageData = { name: 'whalenest-isolated-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } } };
  try {
    if (JSON.parse(await readFile(packageFile)).name !== packageData.name) throw new Error('Refusing to replace an unrelated profile');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(packageFile, JSON.stringify(packageData));
  try { await symlink(join(root, 'node_modules'), join(profile, 'node_modules'), 'dir'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await realpath(join(profile, 'node_modules')) !== await realpath(join(root, 'node_modules'))) {
      throw new Error('Profile points to a different dependency tree');
    }
  }
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  const patch = [
    { id: 'system-prompt', config: { personaPrefix: '' } },
    { id: 'sdk-jsonrpc-server', disabled: true },
    // Schedule's SDK activation contract stays unadvertised until the new
    // owner implements cold activation. Existing production schedule untouched.
    { id: 'schedule', disabled: !bridgeEntry }, { id: 'tool-schedule', disabled: !bridgeEntry },
    { id: 'tool-executor-ptc', disabled: true },
    { insert: [ ...(fixture ? [{ id: 'whalenest-fixture', name: join(root, 'test/fixture-provider.mjs') }] : []),
      ...(externalOverlay ? [] : [{ id: 'whalenest-sdk', name: bridgeEntry ?? join(root, 'src/host.mjs'),
        config: bridgeEntry ? { build: 'whalenest-aurabot-m1', home: resolve(home), profile: 'whalenest', aurabotConfigPath: resolve(configPath) }
          : { configPath: resolve(configPath) } }]) ] },
  ];
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch));
  return { profile, configSha256: createHash('sha256').update(config).digest('hex') };
}
