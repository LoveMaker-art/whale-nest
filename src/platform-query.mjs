import assert from 'node:assert/strict';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const releaseVersion=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*))?$/;

/** Official, configuration-scoped management API; never read its backing store. */
export async function queryPlatformPlugins(configPath,{fetchImpl=fetch}={}){
 assert.ok(isAbsolute(configPath),'An absolute Connect configuration is required');
 const origin='http://127.0.0.1:47822';
 const response=await fetchImpl(origin+'/core/v1/plugins',{
  headers:{Origin:origin,'X-ClawChat-Connect-Core-Config-Path':configPath},
  signal:AbortSignal.timeout(5000),redirect:'error',
 });
 assert.ok(response.ok,'Official plugin manager unavailable (HTTP '+response.status+')');
 let size=0;const chunks=[];
 for await(const bytes of response.body){size+=bytes.length;assert.ok(size<=2*1024*1024,'Plugin metadata response too large');chunks.push(bytes);}
 const rows=JSON.parse(Buffer.concat(chunks).toString());
 assert.ok(Array.isArray(rows),'Official plugin metadata must be an array');
 // Keep only public metadata used by our callers, excluding configurations,
 // manifests, credentials and unrelated new fields from the transport output.
 return rows.map(row=>{
  assert.ok(row&&typeof row.pluginId==='string','Plugin metadata needs an identity');
  const value={};
  for(const key of ['pluginId','version','target','integrity','status','activeArtifact','activationGeneration'])
   if(row[key]!==undefined)value[key]=row[key];
  // Rollback selects the recorded version and integrity through the public
  // manager. Historical manifests and configurations must stay out of this DTO.
  if(Array.isArray(row.retainedVersions))value.retainedVersions=row.retainedVersions
   .filter(entry=>entry&&typeof entry.version==='string'&&entry.version.length<=100&&releaseVersion.test(entry.version)
    &&typeof entry.integrity==='string'&&/^sha256-[A-Za-z0-9+/]{43}=$/.test(entry.integrity))
   .map(({version,integrity})=>({version,integrity}));
  if(row.source&&typeof row.source.type==='string'){
   value.source={type:row.source.type};
   for(const key of ['path','repository','release','apiBase','package'])if(typeof row.source[key]==='string')value.source[key]=row.source[key];
  }
  return value;
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await queryPlatformPlugins(process.argv[2])));}
 catch(error){console.error('Official plugin metadata query failed: '+error.message);process.exitCode=1;}
}
