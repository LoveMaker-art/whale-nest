// Resolve native SDK types and helpers from the executable that owns this DSH
// process, matching the existing Core bridge. Installed plugin artifacts must
// not accidentally load another physical SDK copy from the project directory.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const nativeRequire = createRequire(process.argv[1]);
export const importNative = name => import(pathToFileURL(nativeRequire.resolve(name)).href);
const [agent, llm] = await Promise.all([
  import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-agent')).href),
  import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href),
]);
export const installModelSelection = agent.installModelSelection;
export const createUserMessage = llm.createUserMessage;
export const LlmAdapter = llm.LlmAdapter;
