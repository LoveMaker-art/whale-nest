import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {hash,routeKey,senderKey} from './routing.mjs';
import {livewareCommands} from './liveware-command.mjs';
import {discoverManagedLiveware,managedLivewareCapability,prepareLegacyLivewareMigration,
  livewareCallPort,readManagedLiveware,requireLivewareOwner} from './liveware-migration.mjs';

export {managedLivewareCapability};

function readInstance(context) {
  const home = context.runtimeConfiguration?.homePath || process.env.DSH_HOME || join(homedir(),'.dsh');
  return JSON.parse(readFileSync(join(home,'companion/aurabot-v1/instance.json'),'utf8'));
}

/** One real, private HTTP entry remains alive independently of either business
 * backend. Official Exposure owns publication, credentials, and the relay. */
export function createManagedLivewareProvider({readOptions = readInstance,...dependencies} = {}) {
  return {
    capabilityId:managedLivewareCapability.id,
    instanceKey(context) {
      const options = readOptions(context), route = requireLivewareOwner(options,context.bindingId);
      return hash([resolve(options.dataDir),routeKey(route),senderKey(route)]);
    },
    async acquire(context) {
      const read = () => readOptions(context);
      requireLivewareOwner(read(),context.bindingId);
      return await startManagedLiveware(read,{...dependencies,bindingId:context.bindingId});
    },
  };
}

export function registerManagedLiveware(context, dependencies) {
  context.hostCapabilities.get('managed-web-app-provider').register(createManagedLivewareProvider(dependencies));
}

const removeHopHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([name]) =>
  !['connection','keep-alive','proxy-connection','proxy-authorization','te','trailer','transfer-encoding','upgrade'].includes(name.toLowerCase())));

export async function startManagedLiveware(readOptions, {bindingId,pollInterval = 2000,
  commands = livewareCommands(readOptions()),port = 0} = {}) {
  const initial = readOptions(), owner = requireLivewareOwner(initial,bindingId);
  await prepareLegacyLivewareMigration(initial,{commands});
  const controller = new AbortController(), sockets = new Set(), healthListeners = new Set(), exitListeners = new Set();
  let health = 'starting', closing, timerTask, publicationFound = false;
  function setHealth(value) {
    if (health === value) return;
    health = value;
    for (const listener of healthListeners) listener(value);
  }
  function currentOptions() {
    const options = readOptions(), route = requireLivewareOwner(options,bindingId);
    assert.ok(routeKey(route) === routeKey(owner) && senderKey(route) === senderKey(owner),
      'Managed Liveware binding changed');
    return options;
  }
  function target(req) {
    const options = currentOptions();
    assert.equal(req.headers['x-clawchat-user-id'],owner.sender,'Liveware owner header missing');
    const state = readManagedLiveware(options);
    const origins = new Set([state?.publication?.url,state?.legacy?.url].filter(Boolean).map(url => new URL(url).origin));
    const hosts = new Set([...origins].map(url => new URL(url).host));
    const origin = req.headers.origin;
    assert.ok(origin === undefined || typeof origin === 'string' && origins.has(origin),'Unregistered Liveware origin');
    const host = [req.headers.host,req.headers['x-forwarded-host']].find(value => typeof value === 'string' && hosts.has(value));
    const canonical = host ?? (origin && origins.has(origin) ? new URL(origin).host : undefined);
    assert.ok(canonical,'Unregistered Liveware host');
    if (!options.realtime?.enabled) return {disabled:true};
    const backendPort = livewareCallPort(options);
    assert.ok(typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//'),'Invalid Liveware path');
    // Only a host proven by public account-bound publication metadata can be
    // forwarded. Keep the exact relay-supplied owner and approved Origin.
    return {port:backendPort,host:canonical};
  }
  const fail = (res, status = 503, message = '通话服务正在恢复，请稍后重试。') => {
    if (!res.headersSent) res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'private, no-store'}).end(message);
    else res.destroy();
  };
  const server = createServer((req,res) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/healthz') {
      res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(req.method === 'HEAD' ? undefined : 'ok');
      return;
    }
    let backend;
    try { backend = target(req); } catch { fail(res,403,'无法访问此私有通话入口。');return; }
    if (backend.disabled) { fail(res,503,'通话已关闭。');return; }
    const headers = {...removeHopHeaders(req.headers),host:backend.host,'x-forwarded-host':backend.host};
    const upstream = httpRequest({hostname:'127.0.0.1',port:backend.port,path:req.url,method:req.method,headers}, response => {
      res.writeHead(response.statusCode ?? 502,removeHopHeaders(response.headers));
      response.on('error',()=>res.destroy());
      response.pipe(res);
    });
    upstream.on('error',()=>fail(res));
    req.on('aborted',()=>upstream.destroy());
    res.on('close',()=>upstream.destroy());
    req.pipe(upstream);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10000;
  server.on('connection',socket => { sockets.add(socket);socket.once('close',()=>sockets.delete(socket)); });
  server.on('upgrade',(req,socket,head) => {
    let backend;
    try { backend = target(req); } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return; }
    if (backend.disabled) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return; }
    const upstream = httpRequest({hostname:'127.0.0.1',port:backend.port,path:req.url,method:req.method,
      headers:{...req.headers,host:backend.host,'x-forwarded-host':backend.host}});
    upstream.on('upgrade',(response,peer,buffer) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + response.rawHeaders.reduce((text,value,index) =>
        text + (index % 2 ? value + '\r\n' : value + ': '),'') + '\r\n');
      if (buffer.length) socket.write(buffer);
      if (head.length) peer.write(head);
      peer.on('error',()=>socket.destroy());
      socket.on('error',()=>peer.destroy());
      peer.once('close',()=>socket.destroy());
      socket.once('close',()=>peer.destroy());
      peer.pipe(socket);socket.pipe(peer);
    });
    upstream.on('response',response => {
      socket.write('HTTP/1.1 ' + (response.statusCode ?? 502) + ' Rejected\r\nConnection: close\r\n\r\n');
      response.pipe(socket);
    });
    upstream.on('error',()=>socket.destroy());
    socket.once('close',()=>upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve,reject) => { server.once('error',reject);server.listen(port,'127.0.0.1',resolve); });
  const release = () => closing ??= (async () => {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await timerTask;
    setHealth('stopped');
  })();
  server.on('error',error => { setHealth('error');for (const listener of exitListeners) listener(error);void release(); });
  setHealth('ready');
  timerTask = (async () => {
    while (!controller.signal.aborted) {
      let options;
      try { options = currentOptions(); }
      catch (error) {
        setHealth('error');
        for (const listener of exitListeners) listener(error);
        break;
      }
      try {
        // A provider generation needs one successful publication discovery.
        // Official replacement acquires a new handle, which discovers its new
        // App identity. Avoid accumulating permanent CLI read journals while
        // this generation's already-published service remains healthy.
        if (!publicationFound) publicationFound = Boolean(await discoverManagedLiveware(options,{commands,signal:controller.signal}));
      } catch (error) {
        if (!controller.signal.aborted) console.error('[whalenest-liveware] publication discovery will retry',error.name);
      }
      try { await delay(pollInterval,undefined,{signal:controller.signal}); }
      catch { break; }
    }
  })();
  return {
    upstream:'http://127.0.0.1:' + server.address().port,
    async waitUntilReady() { assert.equal(health,'ready','Managed Liveware service is not ready'); },
    health:() => health,
    onHealthChange(listener) { healthListeners.add(listener);return () => healthListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener);return () => exitListeners.delete(listener); },
    release,
  };
}
