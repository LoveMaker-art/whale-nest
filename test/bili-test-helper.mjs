import {join} from 'node:path';
import {readState,writeState} from '../src/state.mjs';
import {createBiliAccount} from '../src/bili-account.mjs';
export function seedBiliAccount(options,route,deps={}){
 createBiliAccount(options,route,deps);const path=join(options.dataDir,'bili/account.json'),state=readState(path);Object.assign(state,{cookie:'SESSDATA=TEST_PRIVATE_SESSION; bili_jct=TEST_CSRF; buvid3=TEST_BUVID',uid:'123',name:'合成测试账号',generation:1,verifiedAt:(deps.now??Date.now)()});writeState(path,state);return createBiliAccount(options,route,deps);
}
