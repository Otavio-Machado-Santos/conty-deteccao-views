import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const repo = resolve(process.argv[2]);
const output = process.argv[3];
const generateUrl = pathToFileURL(join(repo, 'src/generate.js')).href;
const { writeJsonAtomic, buildDataset, serializeDataset } = await import(generateUrl);
const { runEvaluation } = await import(pathToFileURL(join(repo, 'scripts/evaluate.js')).href);
const dir = fs.mkdtempSync(join(tmpdir(), 'conty09-a31-atomic-'));
const digest = b => createHash('sha256').update(b).digest('hex');
const paths = [
  join(repo, 'dataset/series.json'),
  join(repo, 'docs/evidence/evaluation.json'),
  join(repo, 'README.md')
];
const snap = () => paths.map(p => {
  const s = fs.statSync(p);
  return { path:p, ino:s.ino, mtimeMs:s.mtimeMs, size:s.size, sha256:digest(fs.readFileSync(p)) };
});
const report = { sha:'31bb2150d1758c9c2efbbfc73e506f4973597ca7', passed:false };
try {
  const before = snap();
  const evaluated = runEvaluation({ writeEvidence:false }).report;
  const after = snap();
  assert.deepEqual(after, before);
  assert.equal(evaluated.reproduction.diskMatchesCanonical,true);
  report.readonly = { unchanged:true, before, after };

  const dataset = paths[0];
  const canonical = fs.readFileSync(dataset);
  const evaluationOriginal = fs.readFileSync(paths[1]);
  const readmeOriginal = fs.readFileSync(paths[2]);
  try {
    fs.writeFileSync(dataset, '{"deliberately":"different","series":[]}\n');
    const alteredBefore = snap();
    const alteredReport = runEvaluation({ writeEvidence:false }).report;
    assert.equal(alteredReport.reproduction.diskMatchesCanonical,false);
    assert.deepEqual(snap(),alteredBefore);
    report.disk_bytes_negative = { diskMatchesCanonical:false, tampered_bytes_not_repaired:true };
    fs.unlinkSync(dataset);
    const missingReport = runEvaluation({ writeEvidence:false }).report;
    assert.equal(missingReport.reproduction.diskMatchesCanonical,false);
    assert.equal(fs.existsSync(dataset),false);
    assert.deepEqual(fs.readFileSync(paths[1]),evaluationOriginal);
    assert.deepEqual(fs.readFileSync(paths[2]),readmeOriginal);
    report.missing_dataset = { diskMatchesCanonical:false, file_not_created:true, evidence_and_readme_unchanged:true };
  } finally {
    fs.writeFileSync(dataset,canonical);
  }

  const target = join(dir,'atomic.json');
  const initial = JSON.stringify({version:'initial',payload:'ação🙂'.repeat(22000)});
  const bodies = [0,1,2,3].map(i => JSON.stringify({version:i,payload:('AÇÃO🙂-'+i).repeat(23000+i*3000)}));
  writeJsonAtomic(target,initial);
  assert.equal(fs.readFileSync(target,'utf8'),initial);
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*2);
  const workerSource = `
    import {parentPort,workerData} from 'node:worker_threads';
    import {readFileSync} from 'node:fs';
    const {writeJsonAtomic}=await import(workerData.generateUrl);
    const control = new Int32Array(workerData.shared);
    Date.now = () => 1700000000000;
    parentPort.postMessage({type:'ready'});
    parentPort.once('message',()=>{
      const observed = new Set(); let reads=0;
      try {
        if(workerData.role==='writer'){
          for(let i=0;i<120;i++)writeJsonAtomic(workerData.target,workerData.body);
        }else{
          const allowed=new Set(workerData.allowed);
          while(Atomics.load(control,1)<4 || reads<2000){
            const raw=readFileSync(workerData.target,'utf8');
            if(!allowed.has(raw))throw new Error('Partial/unexpected publication');
            const parsed=JSON.parse(raw);
            observed.add(parsed.version);reads++;
            if(reads>50000)throw new Error('Readers did not observe writer completion');
          }
        }
        parentPort.postMessage({type:'done',pid:process.pid,reads,observed:[...observed]});
      }catch(e){parentPort.postMessage({type:'failure',error:String(e)});}
      finally{
        if(workerData.role==='writer')Atomics.add(control,1,1);
        parentPort.close();
      }
    });
  `;
  const workers = [];
  const results = [];
  const readyPromises = [];
  for (let i=0;i<7;i++) {
    const worker = new Worker(workerSource,{
      eval:true,
      workerData:{role:i<4?'writer':'reader',target,body:bodies[i],allowed:[initial,...bodies],shared,generateUrl}
    });
    workers.push(worker);
    let markReady;
    readyPromises.push(new Promise(resolve => {markReady=resolve}));
    results.push(new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{worker.terminate();reject(new Error('worker timeout'))},20000);
      worker.on('message',msg=>{
        if(msg.type==='ready')markReady();
        if(msg.type==='done'){clearTimeout(timeout);resolve(msg)}
        if(msg.type==='failure'){clearTimeout(timeout);reject(new Error(msg.error))}
      });
      worker.on('error',e=>{clearTimeout(timeout);reject(e)});
      worker.on('exit',code=>{if(code!==0){clearTimeout(timeout);reject(new Error('worker exit '+code))}});
    }));
  }
  await Promise.all(readyPromises);
  for(const worker of workers)worker.postMessage('go');
  const concurrency = await Promise.all(results);
  assert.equal(new Set(concurrency.map(x=>x.pid)).size,1);
  assert.ok(bodies.includes(fs.readFileSync(target,'utf8')));
  assert.deepEqual(fs.readdirSync(dir).filter(x=>x.endsWith('.tmp')),[]);
  report.concurrency = {
    barrier_synchronized:true,
    fixed_clock_ms:1700000000000,
    same_pid:true,
    writers:4,
    reader_threads:3,
    publications:480,
    reads:concurrency.reduce((n,x)=>n+x.reads,0),
    observed_versions:concurrency.filter(x=>x.reads).map(x=>x.observed),
    all_reads_whole_known_utf8:true,
    final_whole:true,
    temporary_files_remaining:0,
    body_bytes:bodies.map(b=>Buffer.byteLength(b))
  };

  const require = createRequire(import.meta.url);
  const fsMutable = require('node:fs');
  const cryptoMutable = require('node:crypto');
  const originalUuid = cryptoMutable.randomUUID;
  const originalOpen = fsMutable.openSync;
  const originalWrite = fsMutable.writeFileSync;
  const originalClose = fsMutable.closeSync;
  const collisionUuid = '11111111-2222-4333-8444-555555555555';
  const collisionTarget = join(dir,'collision.json');
  const foreign = join(dir,'.'+basename(collisionTarget)+'.'+collisionUuid+'.tmp');
  fs.writeFileSync(foreign,'foreign-original');
  cryptoMutable.randomUUID = () => collisionUuid;
  syncBuiltinESMExports();
  try {
    assert.throws(()=>writeJsonAtomic(collisionTarget,'{}'),{code:'EEXIST'});
    assert.equal(fs.readFileSync(foreign,'utf8'),'foreign-original');
    assert.equal(fs.existsSync(collisionTarget),false);
    report.exclusive_collision = { error:'EEXIST', foreign_tmp_preserved:true, no_final_created:true };
  } finally {
    cryptoMutable.randomUUID=originalUuid;
    syncBuiltinESMExports();
  }

  const failureTarget = join(dir,'failure.json');
  fs.writeFileSync(failureTarget,'previous-final');
  let createdFd, createdTmp, openFlags;
  fsMutable.openSync = (path,flags,...args)=>{
    const fd = originalOpen(path,flags,...args);
    createdFd=fd;createdTmp=path;openFlags=flags;
    return fd;
  };
  fsMutable.writeFileSync = (fd,body,...args)=>{
    originalWrite(fd,'partial-chunk',...args);
    const error=new Error('injected write error');error.code='EIO';throw error;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(()=>writeJsonAtomic(failureTarget,'new-final'),{code:'EIO'});
    assert.equal(openFlags,'wx');
    assert.equal(dirname(createdTmp),dirname(failureTarget));
    assert.equal(fs.existsSync(createdTmp),false);
    assert.equal(fs.readFileSync(failureTarget,'utf8'),'previous-final');
    assert.throws(()=>fs.fstatSync(createdFd),{code:'EBADF'});
    assert.equal(fs.readFileSync(foreign,'utf8'),'foreign-original');
    report.partial_write_failure = { error:'EIO', exclusive_flags:openFlags, fd_closed:true, owned_tmp_removed:true, previous_final_preserved:true, foreign_preserved:true };
  } finally {
    fsMutable.openSync=originalOpen;
    fsMutable.writeFileSync=originalWrite;
    fsMutable.closeSync=originalClose;
    syncBuiltinESMExports();
  }

  const directoryTarget = join(dir,'directory-target');
  fs.mkdirSync(directoryTarget);
  fs.writeFileSync(join(directoryTarget,'marker'),'unchanged');
  const filesBefore = fs.readdirSync(dir).sort();
  let renameError;
  try { writeJsonAtomic(directoryTarget,'{}') } catch(e) { renameError=e.code }
  assert.ok(renameError);
  assert.deepEqual(fs.readdirSync(dir).sort(),filesBefore);
  assert.equal(fs.readFileSync(join(directoryTarget,'marker'),'utf8'),'unchanged');
  assert.equal(fs.readFileSync(foreign,'utf8'),'foreign-original');
  report.rename_failure = { code:renameError, owned_tmp_removed:true, existing_directory_preserved:true, foreign_preserved:true };
  const canonicalAfter=serializeDataset(buildDataset({seed:20261009,clock:()=>new Date(0)}));
  assert.equal(digest(canonicalAfter),digest(canonical));
  assert.equal(digest(fs.readFileSync(dataset)),digest(canonical));
  report.canonical_sha256 = digest(canonical);
  report.passed=true;
} finally {
  fs.rmSync(dir,{recursive:true,force:true});
}
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
