// Deterministic container metadata, without any captured user audio.
export function mp4Fixture({handlers=['soun'],brand='mp42',padding=9000,extended=true}={}) {
 const box=(type,...parts)=>{const body=Buffer.concat(parts),head=Buffer.alloc(8);head.writeUInt32BE(body.length+8);head.write(type,4);return Buffer.concat([head,body]);};
 const ftyp=box('ftyp',Buffer.from(brand),Buffer.alloc(4),Buffer.from('isommp42'));
 const media=Buffer.alloc(padding);let mdat;
 if(extended){const head=Buffer.alloc(16);head.writeUInt32BE(1);head.write('mdat',4);head.writeBigUInt64BE(BigInt(media.length+16),8);mdat=Buffer.concat([head,media]);}
 else mdat=box('mdat',media);
 const tracks=handlers.map(handler=>{const h=Buffer.alloc(24);h.write(handler,8);return box('trak',box('mdia',box('hdlr',h)));});
 return Buffer.concat([ftyp,mdat,box('moov',...tracks)]);
}
