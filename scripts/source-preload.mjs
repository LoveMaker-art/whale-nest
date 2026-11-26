import {readFileSync} from 'node:fs';
import * as moduleHooks from 'node:module';
import {inspectSourceCandidate,sourceResolver} from '../src/source-candidate.mjs';

const file=process.env.WHALENEST_SOURCE_INSTANCE;
if(file&&!process.versions.bun){
  const {recoverBindingTransition}=await import('../src/binding-transition.mjs');
  const candidate=inspectSourceCandidate(recoverBindingTransition(file));
  if(candidate&&!process.versions.bun){
    if(typeof moduleHooks.registerHooks!=='function')throw Error('Source tests require the Node module hook provided by the current image');
    moduleHooks.registerHooks({resolve:sourceResolver(candidate)});
    console.error('[whalenest-source] '+candidate.version+' '+candidate.manifestSha256.slice(0,12));
  }
}
