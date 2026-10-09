import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
const repo=resolve(process.argv[2]);
const output=process.argv[3]??'revisoes/09-b-probes.json';
const {classify}=await import(pathToFileURL(resolve(repo,'src/classify.js')));
const {validateSeries}=await import(pathToFileURL(resolve(repo,'src/validate.js')));
const {buildDataset,serializeDataset,expandDatasetSeries}=await import(pathToFileURL(resolve(repo,'src/generate.js')));
const {evaluateDataset}=await import(pathToFileURL(resolve(repo,'scripts/evaluate.js')));
const {createServer}=await import(pathToFileURL(resolve(repo,'src/server.js')));
const epoch=Date.parse('2026-01-05T00:00:00Z');
const points=values=>values.map((views,index)=>({timestamp:new Date(epoch+index*3_600_000).toISOString(),views}));
const summary=value=>({classification:value.classification,shape:value.shape,reason:value.reason,flags:value.flags,rawMetrics:value.rawMetrics});
const validation=[];
for(const [name,series,shouldAccept] of [
  ['utc_valid',points([1,2]),true],
  ['utc_offset_zero',[{timestamp:'2026-01-05T00:00:00+00:00',views:1},{timestamp:'2026-01-05T01:00:00+00:00',views:2}],true],
  ['impossible_calendar',[{timestamp:'2026-02-30T00:00:00Z',views:1},{timestamp:'2026-02-30T01:00:00Z',views:2}],false],
  ['non_leap_day',[{timestamp:'2026-02-29T00:00:00Z',views:1}],false],
  ['non_iso_date',[{timestamp:'Mon, 05 Jan 2026 00:00:00 Z',views:1}],false],
  ['gap',[points([1,2])[0],points([1,2,3])[2]],false],
  ['duplicate_hour',[points([1])[0],points([2])[0]],false],
  ['backwards',points([1,2]).reverse(),false],
  ['fractional_hour',[{timestamp:'2026-01-05T00:30:00Z',views:1}],false],
  ['non_utc',[{timestamp:'2026-01-05T00:00:00-03:00',views:1}],false],
  ['NaN',points([NaN]),false],['Infinity',points([Infinity]),false],['fraction',points([1.5]),false],['negative',points([-1]),false],['unsafe_integer',points([Number.MAX_SAFE_INTEGER+1]),false],
]) {
 let accepted=false,error=null,normalized=null;
 try{normalized=validateSeries(series);accepted=true;}catch(e){error=e.message;}
 validation.push({name,shouldAccept,accepted,error,startMs:normalized?.startMs,contractPassed:accepted===shouldAccept});
}
const smooth=Array.from({length:48},(_,i)=>{
 let v=100;
 if(i>=10&&i<18){const t=(i-10)/8;v=100+1100*(t*t*(3-2*t));}
 else if(i>=18&&i<32){const t=(i-18)/14;v=1200-1100*(t*t*(3-2*t));}
 return Math.round(v);
});
const organic=summary(classify(points(smooth)));
const jittered=summary(classify(points(smooth.map((v,i)=>v+((i*17)%5)-2))));
const huge=[Number.MAX_SAFE_INTEGER,1,1,1,1,1];
const hugeOutcome=summary(classify(points(huge)));
const hugeExact=huge.reduce((sum,value)=>sum+BigInt(value),0n).toString();
const overflow={input:huge,expectedTotal:hugeExact,returnedTotal:String(hugeOutcome.rawMetrics.total),safeTotal:Number.isSafeInteger(hugeOutcome.rawMetrics.total),exactTotal:BigInt(hugeOutcome.rawMetrics.total).toString()===hugeExact,outcome:hugeOutcome};
const seeds=[...Array.from({length:64},(_,i)=>i),20261010,123456789,4294967295];
const holdouts=[];
let fp=0,legitimate=0,tp=0,suspicious=0,abstentions=0;
for(const seed of seeds){
 const dataset=buildDataset({seed,clock:()=>new Date(0)});
 const metrics=evaluateDataset(dataset);
 const serialized=serializeDataset(dataset);
 const same=serializeDataset(buildDataset({seed,clock:()=>new Date(1_700_000_000_000)}));
 fp+=metrics.fpr.numerator;legitimate+=metrics.fpr.denominator;tp+=metrics.recallSuspicious.numerator;suspicious+=metrics.recallSuspicious.denominator;abstentions+=metrics.counts.inconclusives;
 holdouts.push({seed,fp:metrics.fpr.numerator,legitimate:metrics.fpr.denominator,tp:metrics.recallSuspicious.numerator,suspicious:metrics.recallSuspicious.denominator,abstentions:metrics.counts.inconclusives,byteReproduction:serialized===same,sha256:createHash('sha256').update(serialized).digest('hex'),falsePositives:metrics.rows.filter(r=>r.label==='legitimo'&&r.classification==='suspeito')});
}
const dataset=buildDataset({clock:()=>new Date(0)});
const independent={legitimo:{plausivel:0,suspeito:0,inconclusivo:0},suspeito:{plausivel:0,suspeito:0,inconclusivo:0}};
for(const entry of dataset.series)independent[entry.label][classify(expandDatasetSeries(entry)).classification]++;
const reported=evaluateDataset(dataset);
const matrixConsistent=JSON.stringify(independent)===JSON.stringify(reported.confusionMatrix);
const server=createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const http=[];
try{
 for(const [name,body,expected] of [
  ['valid_points',{series:points([100,101,99,102,98,103])},200],
  ['impossible_calendar',{series:[{timestamp:'2026-02-30T00:00:00Z',views:100},{timestamp:'2026-02-30T01:00:00Z',views:100}]},422],
  ['numeric_bypass',{series:[100,101,99,102,98,103]},422],
  ['numeric_invalid_bypass',{series:[-1]},422],
  ['missing_series',{},422],['empty_series',{series:[]},422],['string_series',{series:'not-an-array'},422],
  ['sum_overflow',{series:points(huge)},422],
 ]){
  const response=await fetch(`${base}/classify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  http.push({name,expected,status:response.status,contractPassed:response.status===expected,data:summary(data),error:data.error});
 }
 for(const [method,path,expected] of [['GET','/health',200],['GET','/classify',404],['PUT','/classify',404],['GET','/unknown',404]]){
  const response=await fetch(`${base}${path}`,{method});
  http.push({name:`${method} ${path}`,expected,status:response.status,contractPassed:response.status===expected});await response.text();
 }
 const oversized=await new Promise(resolve=>{
  let settled=false;
  const finish=value=>{if(!settled){settled=true;resolve(value);}};
  const req=httpRequest(`${base}/classify`,{method:'POST',headers:{'content-type':'application/json','content-length':2_000_101}},res=>{
   let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>finish({status:res.statusCode,body}));
  });
  req.setTimeout(2000,()=>{req.destroy();finish({error:'timeout'});});
  req.on('error',error=>finish({error:error.code,message:error.message}));
  req.end(Buffer.alloc(2_000_101,0x78));
 });
 http.push({name:'oversized_body',expected:413,...oversized,contractPassed:oversized.status===413});
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const worker=`
 import http from 'node:http';
 import {createServer} from ${JSON.stringify(pathToFileURL(resolve(repo,'src/server.js')).href)};
 const server=createServer();
 server.listen(0,'127.0.0.1',()=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/health',headers:{host:'[bad'}},res=>{console.log('STATUS',res.statusCode);res.resume();res.on('end',()=>server.close());});
  req.on('error',error=>{console.log('CLIENT',error.code);server.close();});req.end();
 });
`;
const malformedHost=spawnSync(process.execPath,['--input-type=module','-e',worker],{encoding:'utf8',timeout:5000});
const results={reviewed_sha:'eebbf112c1c89eb6f26afa477fad70424c28b4c4',node:process.version,validation,organicRepeatedBaseline:{views:smooth,outcome:organic,jitteredOutcome:jittered,expected:'plausivel ou inconclusivo; a base repetida não transforma a rampa suave em compra'},overflow,holdout:{seeds:seeds.length,series:seeds.length*102,falsePositives:fp,legitimate,fpr:fp/legitimate,truePositives:tp,suspicious,recall:tp/suspicious,abstentions,rows:holdouts},matrix:{independent,reported:reported.confusionMatrix,consistent:matrixConsistent},http,malformedHost:{exitCode:malformedHost.status,signal:malformedHost.signal,stdout:malformedHost.stdout,stderr:malformedHost.stderr,error:malformedHost.error?.message}};
writeFileSync(output,JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({validationFailures:validation.filter(v=>!v.contractPassed).map(v=>v.name),organicClassification:organic.classification,organicSmoothRamp:organic.flags.smoothRamp,organicMechanical:organic.flags.mechanical,overflowExact:overflow.exactTotal,holdout:{seeds:seeds.length,fp,legitimate,tp,suspicious,abstentions},matrixConsistent,httpFailures:http.filter(r=>!r.contractPassed).map(r=>({name:r.name,status:r.status,error:r.error})),hostExit:malformedHost.status,hostError:malformedHost.stderr.split('\n').find(line=>line.includes('ERR_INVALID_URL'))}));
