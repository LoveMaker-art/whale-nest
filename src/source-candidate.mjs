import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const sourceCandidateFile=options=>join(options.dataDir,'source-candidate.json');
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const pluginId='whalenest.runtime.deepseek-harness';
export const sourceTarget=selected=>({version:selected.version,integrity:selected.integrity,
  activeArtifact:selected.activeArtifact,activationGeneration:selected.activationGeneration});
export const sourceIdentity=options=>sha(JSON.stringify([options.instanceId,options.home,options.dataDir,options.cwd,options.clawchat.route]));
export function selectedSourceRuntime(options){
  return read(join(dirname(options.clawchat.delivery.configPath),'plugins.lock.json')).plugins[pluginId];
}

/** Only a matching, operator-selected development source can replace our own
 * modules. A later package activation automatically returns to installed code. */
export function inspectSourceCandidate(options,selected=selectedSourceRuntime(options),{verify=true,record:supplied}={}){
  const pointer=sourceCandidateFile(options);
  if(!supplied&&!existsSync(pointer))return null;
  const record=supplied??read(pointer);
  assert.equal(record.schema,1);assert.equal(record.mode,'source-test');
  if(selected?.status!=='active'||record.identity!==sourceIdentity(options)
    ||JSON.stringify(record.target)!==JSON.stringify(sourceTarget(selected)))return null;
  assert.ok(isAbsolute(record.root)&&record.root===realpathSync(record.root));
  assert.match(record.manifestSha256,/^[a-f0-9]{64}$/);
  if(verify){
    const bytes=readFileSync(join(record.root,'source-manifest.json'));
    assert.equal(sha(bytes),record.manifestSha256,'Development source manifest changed');
    const manifest=JSON.parse(bytes);
    assert.equal(manifest.schema,1);assert.equal(manifest.version,record.version);
    assert.ok(manifest.files&&Object.keys(manifest.files).length);
    for(const [name,digest]of Object.entries(manifest.files)){
      assert.ok(name&&!isAbsolute(name)&&!name.split('/').some(part=>!part||part==='.'||part==='..'));
      const file=join(record.root,name);
      assert.equal(realpathSync(file),file,'Development source must not traverse symbolic links');
      assert.ok(lstatSync(file).isFile());assert.match(digest,/^[a-f0-9]{64}$/);
      assert.equal(sha(readFileSync(file)),digest,'Development source changed: '+name);
    }
    for(const name of ['package.json','src/runtime-extension.mjs','src/runtime-provider.mjs','src/dsh-bridge.mjs',
      'src/liveware-service.mjs','src/assets/workspace-instructions.json'])assert.ok(manifest.files[name]);
    assert.equal(read(join(record.root,'package.json')).version,record.version);
  }
  return {...record,installedRoot:join(dirname(selected.activeArtifact),'whalenest')};
}

/** A resolver for our installed source paths; official artifacts and all
 * unrelated package imports pass through untouched. Resource reads then use
 * the selected source module's own import.meta.url. */
export function sourceResolver(candidate){
  const prefix=resolve(candidate.installedRoot)+sep;
  return (specifier,context,next)=>{
    let url;
    if(specifier.startsWith('file:'))url=new URL(specifier);
    else if(specifier.startsWith('./')||specifier.startsWith('../')){
      if(context.parentURL?.startsWith('file:'))url=new URL(specifier,context.parentURL);
    }
    if(url?.protocol==='file:'){
      const file=fileURLToPath(url);
      if(file.startsWith(prefix)){
        const name=relative(candidate.installedRoot,file);
        if(name.startsWith('src'+sep))return next(pathToFileURL(join(candidate.root,name)).href,context);
      }
    }
    return next(specifier,context);
  };
}

export function sourceNodeOptions(current,preload){
  assert.ok(isAbsolute(preload));
  return [current,'--import='+JSON.stringify(pathToFileURL(preload).href)].filter(Boolean).join(' ');
}
