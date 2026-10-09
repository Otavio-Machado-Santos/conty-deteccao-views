import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
const repo=resolve(process.argv[2]);
const {createServer}=await import(pathToFileURL(resolve(repo,'src/server.js')));
const server=createServer();
const serverSocketErrors=[];
server.on('connection',socket=>socket.on('error',error=>serverSocketErrors.push(error.code)));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const rows=[];
async function call({method='GET',path='/health',agent=false,body,chunked=false,headers={}}={}){
 return await new Promise(resolve=>{
  let result,finished=false,responseDone=false,done=false,reusedSocket=false;
  const errors=[];
  const finish=()=>{if(!done&&result&&((finished&&responseDone)||errors.length)){done=true;resolve({...result,finished,responseDone,reusedSocket,errors});}};
  const request=http.request(`${base}${path}`,{method,agent,headers:{...headers,...(body?chunked?{'transfer-encoding':'chunked'}:{'content-length':body.length}:{})}},response=>{
   const chunks=[];
   response.on('data',chunk=>chunks.push(chunk));
   response.on('error',error=>{errors.push({source:'response',code:error.code});result={status:response.statusCode};finish();});
   response.on('end',()=>{
    const text=Buffer.concat(chunks).toString('utf8');
    let json;try{json=JSON.parse(text);}catch{}
    result={status:response.statusCode,contentType:response.headers['content-type'],json,textLength:text.length,finishedAtResponseEnd:finished};
    responseDone=true;finish();
   });
  });
  request.on('socket',socket=>socket.on('error',error=>{errors.push({source:'client_socket',code:error.code});result??={};finish();}));
  request.on('finish',()=>{finished=true;reusedSocket=request.reusedSocket;finish();});
  request.on('error',error=>{errors.push({source:'request',code:error.code});result??={};finish();});
  request.setTimeout(3000,()=>{errors.push({source:'timeout',code:'timeout'});result??={};request.destroy();finish();});
  if(body&&chunked){for(let i=0;i<body.length;i+=16384)request.write(body.subarray(i,i+16384));request.end();}
  else request.end(body);
 });
}
try{
 for(const keepAlive of [false,true])for(const chunked of [false,true])for(const size of [2_000_001,2_001_024,2_100_000]){
  const agent=keepAlive?new http.Agent({keepAlive:true,maxSockets:1}):false;
  try{
   const upload=await call({method:'POST',path:'/classify',agent,body:Buffer.alloc(size,0x78),chunked,headers:{'content-type':'application/json'}});
   const health=await call({agent});
   const data=Buffer.from(JSON.stringify({series:[{timestamp:'2026-01-05T00:00:00Z',views:100}]}));
   const valid=await call({method:'POST',path:'/classify',agent,body:data,headers:{'content-type':'application/json'}});
   rows.push({keepAlive,chunked,size,upload,health,valid,passed:upload.status===413&&upload.contentType?.includes('application/json')&&typeof upload.json?.error==='string'&&health.status===200&&valid.status===200&&(!keepAlive||health.reusedSocket)&&[upload,health,valid].every(x=>!x.errors.length)});
  }finally{if(agent)agent.destroy();}
 }
 const agent=new http.Agent({keepAlive:true,maxSockets:1});
 try{
  rows.push({name:'invalid_host_then_same_socket_health',host:await call({agent,headers:{host:'[bad'}}),health:await call({agent})});
  for(const body of [Buffer.alloc(0),Buffer.from('   '),Buffer.from('{')])rows.push({name:'empty_or_invalid_json',result:await call({method:'POST',path:'/classify',agent,body,headers:{'content-type':'application/json'}})});
 }finally{agent.destroy();}
}finally{await new Promise(resolve=>server.close(resolve));}
const report={reviewed_sha:'21c55d52d5e51f39ee8a06607c5c2e6d4da37afc',node:process.version,rows,serverSocketErrors};
writeFileSync(process.argv[3]??'revisoes/09-b-http-final.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({bodyCases:rows.filter(x=>'passed'in x).length,bodyFailures:rows.filter(x=>x.passed===false).map(x=>({keepAlive:x.keepAlive,chunked:x.chunked,size:x.size,upload:x.upload,health:x.health})),invalidJsonStatuses:rows.filter(x=>x.name==='empty_or_invalid_json').map(x=>x.result.status),host:rows.find(x=>x.name==='invalid_host_then_same_socket_health'),serverSocketErrors}));
