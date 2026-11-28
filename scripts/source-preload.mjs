import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import * as moduleHooks from 'node:module';
import {inspectSourceCandidate,sourceResolver,bunSourcePath} from '../src/source-candidate.mjs';

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
if(file&&process.versions.bun&&['clawchat-connect-core','clawchat-connect'].includes(basename(process.execPath))){
  const candidate=inspectSourceCandidate(JSON.parse(readFileSync(file,'utf8')));
  if(candidate){
    const {plugin}=await import('bun');
    plugin({name:'whalenest-owned-source',setup(build){
      build.onResolve({filter:/.*/},args=>{
        const path=bunSourcePath(candidate,args.path,args.importer);
        if(path)return {path};
      });
    }});
    console.error('[whalenest-source-core] '+candidate.version+' '+candidate.manifestSha256.slice(0,12));
  }
}
