import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

test('QQ service retains the resource stop and waits without relaunching the desktop under an always-restart supervisor',async t=>{
 const home=mkdtempSync(join(tmpdir(),'whalenest-qq-resource-'));
 const base=join(home,'.local/share/whale-nest/qq-gateways'),snow=join(base,'snowluma-v2.4.2');
 mkdirSync(snow,{recursive:true});mkdirSync(join(base,'desktop-deps'));
 writeFileSync(join(base,'desktop-deps/runtime-library-path.txt'),'');
 writeFileSync(join(snow,'resource-stop.json'),JSON.stringify({reason:'test memory pressure'}));
 const child=spawn('python3',[fileURLToPath(new URL('../deploy/serve-qq-gateway.py',import.meta.url))],{env:{...process.env,HOME:home},stdio:['ignore','pipe','pipe']});
 const ended=once(child,'exit');let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGKILL');await ended;}rmSync(home,{recursive:true,force:true});});
 const status=join(snow,'managed-status.json'),until=Date.now()+5000;
 while(!existsSync(status)&&Date.now()<until&&child.exitCode===null)await delay(20);
 assert.ok(existsSync(status),output);
 assert.equal(JSON.parse(readFileSync(status)).reason,'resource-stop');
 await delay(200);assert.equal(child.exitCode,null,'Resource stop must not exit into an automatic restart loop');
 assert.equal(existsSync(join(snow,'qq-process.json')),false,'No QQ process should be launched');
 assert.ok(existsSync(join(snow,'resource-stop.json')),'Stop requires operator review');
 child.kill('SIGTERM');const [code]=await ended;assert.equal(code,0,output);
});

test('QQ login automation refuses another PID, a different window, and any unverified refresh layout',async()=>{
 const helper=fileURLToPath(new URL('../deploy',import.meta.url));
 const code=`import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from qq_login_window import QQLoginWindow,classify
class Probe(QQLoginWindow):
 def __init__(self,owner='42',height=460):
  super().__init__(Path('/fixture'),{},41);self.owner=owner;self.height=height;self.calls=[]
 def run(self,args,timeout=6):
  self.calls.append(args)
  if args[1]=='search':return b'11\\n'
  if args[1]=='getwindowpid':return self.owner.encode()
  if args[1]=='getwindowgeometry':return ('WIDTH=320\\nHEIGHT='+str(self.height)+'\\nX=352\\nY=154\\n').encode()
  raise AssertionError('Unexpected desktop action')
for probe in [Probe(),Probe(owner='41',height=600)]:
 assert probe.inspect()['state']=='unavailable'
 try:probe.refresh({'state':'expired','geometry':('11',352,154)})
 except RuntimeError:pass
 else:raise AssertionError('Unverified window must not receive input')
 assert not any('click' in args for args in probe.calls)
probe=Probe(owner='41');probe.window_id='12';assert probe.geometry() is None
try:probe.refresh({'state':'attention-required','geometry':('11',352,154)})
except RuntimeError:pass
else:raise AssertionError('Verification dialogs must not be clicked')
assert classify(bytes([245])*320*460*3)=='unavailable'
print('QQ login window boundaries verified')
`;
 const child=spawn('python3',['-c',code,helper],{stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const [exitCode]=await once(child,'exit');assert.equal(exitCode,0,output);
});

test('QQ refresh still clicks when the pointer is already positioned over the refresh button',async()=>{
 const helper=fileURLToPath(new URL('../deploy',import.meta.url));
 const code=`import sys,subprocess
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from qq_login_window import QQLoginWindow
class Stationary(QQLoginWindow):
 def __init__(self):
  super().__init__(Path('/fixture'),{},41);self.clicked=False
 def geometry(self):return ('11',352,154)
 def inspect(self):return {'state':'expired','geometry':self.geometry()}
 def run(self,args,timeout=6):
  if '--sync' in args:raise subprocess.TimeoutExpired(args,timeout)
  if 'click' in args:self.clicked=True
  return b''
window=Stationary();window.refresh(window.inspect());assert window.clicked
print('A stationary pointer does not block the refresh click')
`;
 const child=spawn('python3',['-c',code,helper],{stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const [exitCode]=await once(child,'exit');assert.equal(exitCode,0,output);
});

test('QQ keeps running above the old cache threshold and stops only for sustained hard pressure',()=>{
 const helper=fileURLToPath(new URL('../deploy',import.meta.url));
 const code=`import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from qq_gateway_memory import GatewayMemory,process_memory
from tempfile import TemporaryDirectory
def reading(current,effective,non_file,maximum=0,oom=0):
 return dict(limit=2048,current=current,effective=effective,nonFile=non_file,
             events={'max':maximum,'oom':oom,'oom_kill':0})
guard=GatewayMemory()
for t in range(35):
 assert not guard.record(reading(1920,1742,580),t)
assert guard.deferred and len(guard.samples)==30
for t in range(3):
 assert not guard.record(reading(1500,1380,580),40+t)
 assert guard.deferred==(t<2)
assert not guard.record(reading(2000,1910,900,2),50)
assert not guard.record(reading(2020,1920,920,3),55)
assert guard.record(reading(2010,1930,900,3),60)
guard=GatewayMemory()
for t in range(2): assert not guard.record(reading(1990,1970,1870),t)
assert guard.record(reading(1990,1970,1870),2)
guard=GatewayMemory()
assert not guard.record(reading(1900,1800,1300),0)
assert guard.record(reading(2020,2000,1700,1,1),5)
assert not guard.record(reading(1700,1550,900,1,2),10)
with TemporaryDirectory() as tmp:
 root=Path(tmp)
 data={'41':(41,80),'42':(41,20),'43':(43,55),'44':(44,900)}
 for pid,(group,pss) in data.items():
  proc=root/pid;proc.mkdir()
  (proc/'stat').write_text(f'{pid} (name with spaces) S 1 {group} {group} 0')
  (proc/'smaps_rollup').write_text(f'Pss: {pss} kB\\n')
 assert process_memory({41:'qq',43:'snowluma'},procfs=root)['qq']==dict(processes=2,sampled=2,pssKiB=100)
`;
 const result=spawnSync('python3',['-B','-c',code,helper],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('saved QQ account page navigates once to scan login without using the saved credentials',()=>{
 const helper=fileURLToPath(new URL('../deploy',import.meta.url));
 const code=`import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from qq_login_window import QQLoginWindow
w=QQLoginWindow(Path('/fixture'),{},42)
clicks=[]
w._click=lambda frame,state,x,y: clicks.append((state,x,y))
a={}
for state in ('saved-account','account-picker','scan-link'):
 assert w.prepare({'state':state},a)['state']=='preparing'
 assert w.prepare({'state':state},a)['state']=='preparing'
assert clicks==[('saved-account',160,234),('account-picker',100,325),('scan-link',121,422)]
assert w.prepare({'state':'attention-required'},a)['done']
assert len(clicks)==3
`;
 const result=spawnSync('python3',['-B','-c',code,helper],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('QQ cold-start account selector recognizes the wide layout and opens the verified login entry once',()=>{
 const helper=fileURLToPath(new URL('../deploy',import.meta.url));
 const fixture=fileURLToPath(new URL('./fixtures/qq-wide-saved-page-mask.json',import.meta.url));
 const code=`import sys,base64,json,zlib,struct
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from qq_login_window import QQLoginWindow,classify
size=(640,424)
pixels=bytearray([245])*(size[0]*size[1]*3)
fixture=json.loads(Path(sys.argv[2]).read_text())
def paint(item,target):
 x0,y0,x1,y1=item['bounds']
 bits=zlib.decompress(base64.b64decode(item['maskZlibBase64']))
 ink=bytes({'dark':[96,96,96],'blue':[0,120,245],'red':[245,100,90]}[item['threshold']])
 for y in range(y0,y1):
  for x in range(x0,x1):
   if bits[(y-y0)*(x1-x0)+x-x0]:
    p=(y*size[0]+x)*3;target[p:p+3]=ink
for item in fixture['masks']:paint(item,pixels)
class ColdStart(QQLoginWindow):
 def __init__(self):
  super().__init__(Path('/fixture'),{},41);self.wid='11';self.frame=pixels;self.clicks=[]
 def run(self,args,timeout=6):
  if args[0].endswith('/ffmpeg'):
   assert args[args.index('-video_size')+1]=='640x424';return self.frame
  action=args[1]
  if action=='search':return self.wid.encode()
  if action=='getwindowpid':return b'41'
  if action=='getwindowgeometry':
   return b'WIDTH=640\\nHEIGHT=424\\nX=192\\nY=172\\n' if self.wid=='11' else b'WIDTH=320\\nHEIGHT=460\\nX=352\\nY=154\\n'
  if action=='mousemove':self.clicks.append(args);return b''
  raise AssertionError('Unexpected desktop operation')
assert classify(pixels,*size)=='wide-saved-account'
assert classify(bytes([245])*len(pixels),*size)=='unavailable'
window=ColdStart();frame=window.inspect();attempt={}
assert frame['state']=='wide-saved-account'
assert window.prepare(frame,attempt)['action']=='add-account'
assert window.prepare(frame,attempt)['state']=='preparing'
assert len(window.clicks)==1 and window.clicks[0][4:6]==['460','153']
window.wid='12';assert window.geometry() is not None, 'The login flow may open a new window for the same PID'
window=ColdStart();frame=window.inspect();window.frame=bytes([245])*len(pixels)
try:window.prepare(frame,{})
except RuntimeError:pass
else:raise AssertionError('Changed layouts must not receive input')
assert not window.clicks
scan=bytearray([245])*len(pixels)
paint(fixture['scanInstruction'],scan)
ink=bytes([40,110,245])
def dot(x,y,color=ink):
 p=(y*640+x)*3;scan[p:p+3]=color
for x,y in ((454,162),(560,162),(454,269)):
 dot(x,y)
 for delta in [-12,12]:
  dot(x+delta,y);dot(x,y+delta)
for y in range(186,248,2):
 for x in range(478,549,2):dot(x,y)
window=ColdStart();window.frame=scan;frame=window.inspect()
assert frame['state']=='waiting','The new scan layout must return its QR image'
assert struct.unpack('!II',frame['image'][16:24])==(160,160)
dot(560,162,bytes([245])*3)
assert window.inspect()['state']=='unavailable','An incomplete or faded QR is not sent'
for key in ('scanExpiredLabel','scanRefreshLabel'):paint(fixture[key],scan)
frame=window.inspect();attempt={}
assert frame['state']=='expired','The desktop QR expiration page must be detected'
assert 'image' not in frame and 'attentionImage' not in frame
assert window.prepare(frame,attempt)['action']=='refresh-expired-code'
assert window.prepare(frame,attempt)['state']=='preparing'
assert len(window.clicks)==1 and window.clicks[0][4:6]==['507','227']
x0,y0,x1,y1=fixture['scanRefreshLabel']['bounds']
for y in range(y0,y1):
 for x in range(x0,x1):dot(x,y,bytes([245])*3)
assert window.inspect()['state']=='unavailable','Without the verified button, the page must stay read-only'
paint(fixture['scanRefreshHoveredLabel'],scan)
assert window.inspect()['state']=='expired','Leaving the pointer over Refresh must not hide native expiration'
`;
 const result=spawnSync('python3',['-B','-c',code,helper,fixture],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
