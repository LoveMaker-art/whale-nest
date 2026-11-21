import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {writeState} from './state.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const number = value => /^\d{5,12}$/.test(String(value ?? '')) ? String(value) : null;

/** Independent HTTP clients for the published login interfaces. Gateway
 * programs and their account data are provisioned outside the plugin. */
export function createQQGateway(config, {fetchImpl = fetch, now = Date.now} = {}) {
  assert.ok(config && ['napcat', 'llbot', 'snowluma'].includes(config.type), '未配置支持的QQ网关登录接口');
  const base = new URL(config.url);
  assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password
    && !base.search && !base.hash && base.pathname === '/', 'QQ网关必须使用实例配置中的HTTP服务地址');
  assert.ok(typeof config.token === 'string' && config.token.length >= 8, 'QQ网关管理凭据未配置');
  let credential, expiresAt = 0, lastQrUrl;
  function snapshot(path,maxBytes) {
    const stat=lstatSync(path);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=maxBytes,'QQ二维码快照过大或无效');
    const bytes=readFileSync(path);assert.ok(bytes.length===stat.size&&bytes.length<=maxBytes,'QQ二维码快照读取期间发生变化');return bytes;
  }
  function loginSnapshot() {
    if(!config.loginQrFile)return null;
    try {
      const value=JSON.parse(snapshot(join(dirname(resolve(config.loginQrFile)),'status.json'),8192).toString('utf8'));
      return Number.isFinite(value.updatedAt)&&now()-value.updatedAt<=10000&&value.updatedAt<=now()+5000 ? value : null;
    } catch {return null;}
  }
  function snapshotImage(value) {
    const image=snapshot(join(dirname(resolve(config.loginQrFile)),'qr.png'),256*1024);
    assert.ok(image.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&sha(image)===value.imageSha256,'QQ客户端二维码快照校验失败');
    return image;
  }

  async function request(path, body, headers = {}) {
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {...headers, ...(body === undefined ? {} : {'content-type': 'application/json'})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: AbortSignal.timeout(15000), redirect: 'error',
      });
    } catch { throw new Error('QQ网关连接失败或超时，请查询连接状态'); }
    assert.ok(response.ok, 'QQ网关请求失败：HTTP ' + response.status);
    const chunks=[];let bytes=0;
    for await (const chunk of response.body ?? []) {
      bytes+=chunk.byteLength;
      assert.ok(bytes <= 1024 * 1024, 'QQ网关响应过大');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('QQ网关响应不是有效JSON'); }
    // Both services can return HTTP 200 for an unsuccessful operation. Do not
    // copy backend messages, which may contain credentials, into model output.
    assert.ok(config.type === 'napcat' ? value.code === 0 : config.type === 'snowluma'
      ? value && typeof value === 'object' && value.success !== false && value.status !== 'failed' : value.success === true,
      'QQ网关未完成请求，请检查网关运行状态和凭据');
    return config.type === 'snowluma' ? value : value.data ?? {};
  }

  async function call(path, body) {
    if (config.type === 'llbot') return request(path, body, {'X-Webui-Token': sha(config.token)});
    if (!credential || now() >= expiresAt) {
      const snow = config.type === 'snowluma';
      const auth = await request(snow ? '/api/login' : '/api/auth/login', snow ? {password:config.token} : {hash: sha(config.token + '.napcat')});
      assert.ok(!auth.mustChangePassword, 'QQ网关控制台需要先完成密码配置');
      credential = snow ? auth.token : auth.Credential;
      assert.ok(typeof credential === 'string' && credential, 'QQ网关认证失败');
      expiresAt = now() + (snow ? 25 : 55) * 60 * 1000;
    }
    try {
      return await request(path, body, config.type === 'snowluma' ? {'x-snowluma-token':credential} : {Authorization: 'Bearer ' + credential});
    } catch(error) {
      // The managed desktop may restart its local console to refresh an
      // unlogged QQ client. Renew a rejected session once for this read only.
      if(config.type==='snowluma'&&path==='/api/qq-list'&&body===undefined&&error.message==='QQ网关请求失败：HTTP 401') {
        credential=undefined;expiresAt=0;
        const auth=await request('/api/login',{password:config.token});
        assert.ok(typeof auth.token==='string'&&auth.token,'QQ网关认证失败');
        credential=auth.token;expiresAt=now()+25*60*1000;
        return request(path,body,{'x-snowluma-token':credential});
      }
      throw error;
    }
  }

  async function snowStatus() {
    const value = await call('/api/qq-list');
    assert.ok(Array.isArray(value.list), 'SnowLuma账号列表无效');
    const accounts = value.list.filter(a=>number(a.uin));
    const selected = config.botQQ ? accounts.find(a=>String(a.uin)===String(config.botQQ)) : accounts.length===1 ? accounts[0] : null;
    assert.ok(config.botQQ || accounts.length<=1, 'SnowLuma存在多个QQ账号，需要明确指定机器人身份');
    if (!selected) {
      const observed=loginSnapshot();
      if(['expired','scanned','security-restricted'].includes(observed?.state))return {state:observed.state};
      if(observed?.state==='reconnecting'||observed?.state==='preparing')return {state:'restarting'};
      if(observed?.state==='attention-required') {
        const result={state:'attention-required'};
        if(observed.attentionSha256)try {
          const image=snapshot(join(dirname(resolve(config.loginQrFile)),'attention.png'),256*1024);
          if(image.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&sha(image)===observed.attentionSha256)result.attentionImage=image;
        } catch {}
        return result;
      }
      return {state:observed?.state==='waiting'?'waiting':'offline'};
    }
    const onebot = config.onebot;
    assert.ok(onebot?.httpUrl, 'SnowLuma尚未配置OneBot账号核验接口');
    const url = new URL(onebot.httpUrl);
    assert.ok(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash,'OneBot核验地址无效');
    const secret = key=>onebot[key+'File'] ? readFileSync(resolve(onebot[key+'File']),'utf8').trim() : onebot[key]??'';
    const token = secret('httpToken') || secret('token');
    const headers = token ? {Authorization:'Bearer '+token} : {};
    const result = await request(new URL('get_login_info',url.href.endsWith('/')?url:url.href+'/').href,{},headers);
    assert.equal(result.status,'ok','OneBot身份核验未完成');
    assert.equal(number(result.data?.user_id),String(selected.uin),'OneBot与SnowLuma的机器人身份不一致');
    const state = await request(new URL('get_status',url.href.endsWith('/')?url:url.href+'/').href,{},headers);
    assert.equal(state.status,'ok','OneBot在线状态未确认');
    return state.data?.online===true ? {state:'online',botQQ:String(selected.uin),name:String(result.data.nickname??'').slice(0,100)} : {state:'reconnecting'};
  }

  function qr(value) {
    const url = value.qrcode ?? value.qrcodeurl ?? value.qrcodeUrl;
    if (value.restarting === true) return {state: 'restarting'};
    assert.ok(typeof url === 'string' && url.length > 0 && url.length <= 2000, 'QQ网关尚未提供支持的登录二维码');
    const parsed = new URL(url);
    assert.ok(['https:', 'http:'].includes(parsed.protocol)
      && (parsed.hostname === 'qq.com' || parsed.hostname.endsWith('.qq.com')), 'QQ登录二维码来源不受支持');
    return {state: 'waiting', url,
      ...(Number.isFinite(value.expireTime) ? {gatewayExpireTime: value.expireTime} : {})};
  }

  return {
    type: config.type,
    async qr({refresh = false} = {}) {
      if (config.type === 'snowluma') {
        assert.ok(config.loginQrFile,'QQ客户端扫码入口尚未准备');
        const file=resolve(config.loginQrFile);
        let value;
        // Reuse only a currently visible, recently inspected code, never a
        // snapshot inferred valid merely from the time its PNG was written.
        if(!refresh&&loginSnapshot()?.state==='waiting')try {
          const cached=JSON.parse(snapshot(file,8192).toString('utf8'));
          if(cached.phase==='waiting'&&now()-cached.updatedAt<=3000&&cached.updatedAt<=now()+5000)
            return {state:'waiting',image:snapshotImage(cached),reused:true};
        } catch {}
        if(config.loginRequestFile) {
          const id=randomUUID();writeState(resolve(config.loginRequestFile),{id,requestedAt:now(),refresh});
          const until=Date.now()+60000;
          while(Date.now()<until) {
            try {value=JSON.parse(snapshot(file,8192).toString('utf8'));}catch {value=undefined;}
            if(value?.requestId===id&&(value.imageSha256||value.url||value.error||['scanned','security-restricted','attention-required','online'].includes(value.phase)))break;
            await delay(250);
          }
          assert.ok(value?.requestId===id&&!value.error,'QQ客户端尚未准备好本次二维码，请查询状态后重试');
        } else value=JSON.parse(snapshot(file,8192).toString('utf8'));
        assert.ok(Number.isFinite(value.updatedAt)&&now()-value.updatedAt<=30000&&value.updatedAt<=now()+5000,'QQ客户端二维码快照已过期，请等待当前登录窗口刷新');
        if(value.phase==='online')return snowStatus();
        if(['scanned','security-restricted','attention-required'].includes(value.phase))return {state:value.phase};
        let current,key;
        if(value.imageSha256) {
          const image=snapshotImage(value);
          current={state:'waiting',image,...(value.reused?{reused:true}:{})};key=value.imageSha256;
        } else {current=qr({qrcode:value.url});key=current.url;}
        assert.ok(!refresh||current.reused||key!==lastQrUrl,'QQ客户端二维码尚未更新，请等待客户端刷新');lastQrUrl=key;
        return current;
      }
      if (config.type === 'llbot') return qr(await call('/api/login-qrcode'));
      return qr(await call(refresh ? '/api/QQLogin/RefreshQRcode' : '/api/QQLogin/GetQQLoginQrcode', {}));
    },
    async status() {
      if (config.type === 'snowluma') return snowStatus();
      if (config.type === 'llbot') {
        const data = await call('/api/login-info');
        const info = data.selfInfo ?? data;
        return info.online === true && number(info.uin)
          ? {state: 'online', botQQ: number(info.uin), name: String(info.nick ?? '').slice(0, 100)}
          : {state: info.online === false ? 'offline' : 'waiting'};
      }
      const data = await call('/api/QQLogin/CheckLoginStatus', {});
      if (data.isLogin === true && data.isOffline !== true) {
        const info = await call('/api/QQLogin/GetQQLoginInfo', {});
        assert.ok(info.online === true && number(info.uin), 'QQ网关尚未完成在线账号核验');
        return {state: 'online', botQQ: number(info.uin), name: String(info.nick ?? '').slice(0, 100)};
      }
      const phase = String(data.loginPhase ?? '').toLowerCase();
      return {state: data.loginError ? 'failed' : data.isOffline ? 'offline'
        : /expire/.test(phase) ? 'expired' : /cancel/.test(phase) ? 'cancelled'
        : data.qrLoginAccepted === true ? 'scanned' : 'waiting'};
    },
    async logout() {
      assert.equal(config.type, 'llbot', '此QQ网关尚未提供已核实的QQ退出接口，不能用刷新二维码代替换号');
      await call('/api/logout', {});
      return {state: 'disconnected', credentialsRetained: true};
    },
    clearAuthentication() { credential = undefined; expiresAt = 0; },
  };
}
