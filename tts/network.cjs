'use strict';
const http=require('node:http');const https=require('node:https');const crypto=require('node:crypto');const {EventEmitter}=require('node:events');
const MAX_AUDIO=64*1024**2;
function abortError(){const error=new Error('Speech generation cancelled.');error.name='AbortError';return error;}
function requestBuffer(url,{method='GET',headers={},body,signal,timeoutSeconds=180,maxBytes=MAX_AUDIO,onHeaders,onData}={}){
 return new Promise((resolve,reject)=>{
  const u=new URL(url);if(!['http:','https:'].includes(u.protocol))return reject(Error('Unsupported network protocol.'));
  if(signal?.aborted)return reject(abortError());let settled=false;let deadline;const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(deadline);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
  const req=(u.protocol==='https:'?https:http).request(u,{method,headers,timeout:timeoutSeconds*1000},res=>{
   if(res.statusCode<200||res.statusCode>=300){res.destroy();return finish(Error(res.statusCode>=300&&res.statusCode<400?'The speech service redirected the request. Redirects are disabled to protect API keys.':`The speech service returned HTTP ${res.statusCode}. Check the provider settings and account access.`));}
   const announced=Number(res.headers['content-length']);if(announced>maxBytes){res.destroy();return finish(Error('The speech service response exceeded its size limit.'));}
   const contentType=String(res.headers['content-type']||'').toLowerCase();try{onHeaders?.({contentType,contentLength:announced,headers:res.headers});}catch(error){res.destroy();return finish(error);}
   const chunks=[];let bytes=0;res.on('data',chunk=>{if(settled)return;bytes+=chunk.length;if(bytes>maxBytes){res.destroy();return finish(Error('The speech service response exceeded its size limit.'));}chunks.push(chunk);try{onData?.(chunk,{contentType});}catch(error){res.destroy();finish(error);}});res.on('end',()=>finish(null,{bytes:Buffer.concat(chunks,bytes),contentType}));res.on('error',()=>finish(Error('The speech service connection ended unexpectedly.')));
  });
  deadline=setTimeout(()=>{req.destroy();finish(Error('The speech request timed out.'));},timeoutSeconds*1000);
  function abort(){req.destroy();finish(abortError());}signal?.addEventListener('abort',abort,{once:true});req.on('timeout',()=>{req.destroy();finish(Error('The speech request timed out.'));});req.on('error',()=>finish(signal?.aborted?abortError():Error('Could not connect to the speech service. Check its address, certificate and availability.')));if(body)req.write(body);req.end();
 });
}
// Minimal RFC 6455 client for the fixed Realtime JSON protocol. Uses Node TLS
// validation, no redirects, masked client frames and bounded fragmented frames.
class JsonWebSocket extends EventEmitter{
 constructor(url,{headers={},signal,maxMessageBytes=4*1024**2,timeoutSeconds=180}={}){
  super();this.socket=null;this.closed=false;this.pending=Buffer.alloc(0);this.fragments=[];this.fragmentBytes=0;this.fragmentOpcode=0;this.maxMessageBytes=maxMessageBytes;
  const u=new URL(url);if(!['ws:','wss:'].includes(u.protocol))throw Error('Unsupported WebSocket URL.');
  const key=crypto.randomBytes(16).toString('base64');const expected=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');u.protocol=u.protocol==='wss:'?'https:':'http:';
  this.timer=setTimeout(()=>this.fail('The Realtime speech request timed out.'),timeoutSeconds*1000);this.signal=signal;this.abort=()=>this.fail('Speech generation cancelled.','AbortError');signal?.addEventListener('abort',this.abort,{once:true});
  this.req=(u.protocol==='https:'?https:http).request(u,{headers:{...headers,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key}});
  this.req.on('upgrade',(res,socket,head)=>{
   if(this.closed){socket.destroy();return;}if(res.statusCode!==101||res.headers['sec-websocket-accept']!==expected||String(res.headers.upgrade).toLowerCase()!=='websocket'){socket.destroy();this.fail('Invalid Realtime WebSocket handshake.');return;}
   this.socket=socket;socket.on('data',chunk=>this.consume(chunk));socket.on('error',()=>this.fail('The Realtime connection failed.'));socket.on('end',()=>this.fail('The Realtime connection ended before the reading completed.'));socket.on('close',()=>{if(!this.closed)this.fail('The Realtime connection closed before the reading completed.');});this.emit('open');if(head.length)this.consume(head);
  });
  this.req.on('response',res=>{res.destroy();this.fail(`The Realtime service returned HTTP ${res.statusCode}. Check the API key and model access.`);});this.req.on('error',()=>{if(!this.closed)this.fail('Could not connect to OpenAI. Check the connection and TLS certificate.');});this.req.end();if(signal?.aborted)queueMicrotask(this.abort);
 }
 frame(opcode,bytes){if(!this.socket||this.closed)return;const mask=crypto.randomBytes(4),len=bytes.length;let header;if(len<126){header=Buffer.from([0x80|opcode,0x80|len]);}else if(len<=65535){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=0x80|126;header.writeUInt16BE(len,2);}else{header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=0x80|127;header.writeBigUInt64BE(BigInt(len),2);}const masked=Buffer.alloc(len);for(let i=0;i<len;i++)masked[i]=bytes[i]^mask[i%4];this.socket.write(Buffer.concat([header,mask,masked]));}
 send(value){this.frame(1,Buffer.from(JSON.stringify(value)));}
 consume(chunk){try{
  this.pending=Buffer.concat([this.pending,chunk]);if(this.pending.length>this.maxMessageBytes+14)throw Error('The Realtime frame exceeded its size limit.');
  while(this.pending.length>=2){const first=this.pending[0],second=this.pending[1],fin=!!(first&0x80),opcode=first&15;if(first&0x70||second&0x80)throw Error('Invalid Realtime WebSocket frame.');let len=second&127,offset=2;if(len===126){if(this.pending.length<4)return;len=this.pending.readUInt16BE(2);offset=4;}else if(len===127){if(this.pending.length<10)return;const big=this.pending.readBigUInt64BE(2);if(big>BigInt(this.maxMessageBytes))throw Error('The Realtime frame exceeded its size limit.');len=Number(big);offset=10;}if(len>this.maxMessageBytes)throw Error('The Realtime frame exceeded its size limit.');if(this.pending.length<offset+len)return;const payload=this.pending.subarray(offset,offset+len);this.pending=this.pending.subarray(offset+len);
   if(opcode>=8){if(!fin||len>125)throw Error('Invalid Realtime control frame.');if(opcode===8){this.fail('The Realtime connection closed before the reading completed.');return;}if(opcode===9)this.frame(10,payload);else if(opcode!==10)throw Error('Unsupported Realtime control frame.');continue;}
   if(opcode===1){if(this.fragmentOpcode)throw Error('Overlapping Realtime messages.');this.fragmentOpcode=1;}else if(opcode!==0||!this.fragmentOpcode)throw Error('Unexpected Realtime WebSocket message.');
   this.fragmentBytes+=len;if(this.fragmentBytes>this.maxMessageBytes)throw Error('The Realtime event exceeded its size limit.');this.fragments.push(Buffer.from(payload));if(fin){const data=Buffer.concat(this.fragments,this.fragmentBytes);this.fragments=[];this.fragmentBytes=0;this.fragmentOpcode=0;const text=new TextDecoder('utf-8',{fatal:true}).decode(data);this.emit('message',JSON.parse(text));}
  }
 }catch(error){this.fail(error instanceof SyntaxError?'The Realtime service returned invalid JSON.':error.message||'Invalid Realtime event.');}}
 fail(message,name='Error'){if(this.closed)return;const error=new Error(message);error.name=name;this.close();this.emit('error',error);}
 close(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.signal?.removeEventListener('abort',this.abort);this.req?.destroy();this.socket?.destroy();this.pending=Buffer.alloc(0);this.fragments=[];}
}
module.exports={requestBuffer,JsonWebSocket,MAX_AUDIO,abortError};
