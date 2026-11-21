import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import qrcode from '../vendor/qrcode-generator/qrcode.cjs';

function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,bytes){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([name,bytes])));return Buffer.concat([length,name,bytes,crc]);}
/** Deterministic local encoding for login links, without any model service. */
export function qrPng(value){
 assert.ok(typeof value==='string'&&value.length>=1&&value.length<=2000&&/^[\x20-\x7e]+$/.test(value),'QR input must be 1..2000 ASCII characters');
 const qr=qrcode(0,'M');qr.addData(value,'Byte');qr.make();
 const modules=qr.getModuleCount(),scale=5,margin=4,width=(modules+margin*2)*scale;
 const pixels=Buffer.alloc((width+1)*width,255);
 for(let y=0;y<width;y++){pixels[y*(width+1)]=0;const row=Math.floor(y/scale)-margin;
  for(let x=0;x<width;x++){const col=Math.floor(x/scale)-margin;if(row>=0&&row<modules&&col>=0&&col<modules&&qr.isDark(row,col))pixels[y*(width+1)+x+1]=0;}
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(width,4);header[8]=8;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
