import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('QQ distinguishes a known informational restriction, phone confirmation and unknown dialogs; retry recovers once',async()=>{
 const helper=fileURLToPath(new URL('../deploy',import.meta.url));
 const fixture=fileURLToPath(new URL('./fixtures/qq-risk-message-mask.json',import.meta.url));
 const code=`import sys,json,zlib,base64
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from qq_login_window import QQLoginWindow,classify
def blank(dimmed=False):
 rgb=bytearray([122 if dimmed else 245])*(320*460*3)
 for y in range(50,58):
  for x in range(140,148):rgb[(y*320+x)*3:(y*320+x)*3+3]=bytes([80,120,240])
 return rgb
fixture=json.loads(Path(sys.argv[2]).read_text());mask=zlib.decompress(base64.b64decode(fixture['maskZlibBase64']))
risk=blank(True)
for y in range(63):
 for x in range(250):
  v=0 if mask[y*250+x] else 255;i=((y+195)*320+x+35)*3;risk[i:i+3]=bytes([v,v,v])
assert classify(risk)=='security-restricted','The actual static warning must be a terminal restriction, not generic preparation'
unknown=blank(True);assert classify(unknown)=='attention-required'
scanned=blank()
for y in range(304,317):
 for x in range(122,135):scanned[(y*320+x)*3:(y*320+x)*3+3]=bytes([0,153,255])
# The real scan-success label starts immediately to the right of the icon.
scanned[(310*320+140)*3:(310*320+140)*3+3]=bytes([0,0,0])
assert classify(scanned)=='scanned','A blue scan result is not a QR preparation state'
class Actions(QQLoginWindow):
 def __init__(self):super().__init__(Path('/fixture'),{},41);self.actions=[]
 def dismiss_security_notice(self,frame):self.actions.append('dismiss-known-notice')
 def cancel_scanned(self,frame):self.actions.append('cancel-old-request')
 def refresh(self,frame):self.actions.append('refresh-expired')
w=Actions();attempt={'refresh':False}
assert w.prepare({'state':'scanned'},attempt)['state']=='scanned';assert not w.actions,'Ordinary waiting must not cancel a phone verification'
attempt={'refresh':False}
assert w.prepare({'state':'security-restricted'},attempt)['state']=='preparing'
assert w.prepare({'state':'scanned'},attempt)['state']=='preparing'
assert w.prepare({'state':'scanned'},attempt)['state']=='preparing'
assert w.prepare({'state':'waiting'},attempt)['done']
assert w.actions==['dismiss-known-notice','cancel-old-request'],'Each retry step happens once'
w=Actions();attempt={};w.prepare({'state':'security-restricted'},attempt)
assert w.prepare({'state':'security-restricted'},attempt)['state']=='security-restricted';assert len(w.actions)==1,'A recurring restriction must never create an automatic login retry loop'
w=Actions();assert w.prepare({'state':'attention-required'}, {})['done'];assert not w.actions,'Unknown verification dialogs remain untouched'
print('QQ login recovery boundaries verified')
`;
 const child=spawn('python3',['-c',code,helper,fixture],{stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const [exitCode]=await once(child,'exit');assert.equal(exitCode,0,output);
});
