import json, os, pathlib, subprocess, tempfile, shutil, sys

copy = pathlib.Path(sys.argv[1])
oldcopy = pathlib.Path(sys.argv[2])
output = pathlib.Path(sys.argv[3])
os.environ['PATH'] = '/Users/flowbix_redfinger/XiaomiMiMoProjects/conty challenge/ferramentas/node22/node_modules/node/bin:' + os.environ['PATH']
probe_dir = pathlib.Path(tempfile.mkdtemp(prefix='conty09-a829-isolation-'))
sentinel_name = '.test-tmp-cleanup-other-suite-fixture.json.aaaaaaaa.tmp'
sentinel_content = b'owned-by-independent-other-suite'
report = {'reviewed_sha':'829b1bc9cf4df285c8f867cdd6166799fd862659','passed':False}

def proof(run):
    return {'exit_code':run.returncode, 'proof':[
        x for x in run.stdout.splitlines()
        if x.startswith(('not ok','# pass','# fail','# tests')) or 'temporário próprio' in x
    ]}

def selected(where, extra=None):
    args=['node']
    if extra: args += ['--import', extra.as_uri()]
    args += ['--test','--test-name-pattern=writeJsonAtomic remove somente','test/generate.test.js']
    return subprocess.run(args,cwd=where,capture_output=True,text=True,timeout=15)

try:
    # Uma suíte alheia mantém um temporário que contém "cleanup", mas tem outro prefixo.
    sentinel=copy/'dataset'/sentinel_name
    sentinel.write_bytes(sentinel_content)
    passed=selected(copy)
    assert passed.returncode==0,passed.stdout+passed.stderr
    assert sentinel.read_bytes()==sentinel_content
    report['foreign_temporary_ignored']=dict(proof(passed),foreign_preserved=True)

    # Controle negativo no teste antigo: a mesma sonda precisa detectar o defeito.
    old_sentinel=oldcopy/'dataset'/sentinel_name
    old_before=set(p.name for p in (oldcopy/'dataset').iterdir())
    try:
        old_sentinel.write_bytes(sentinel_content)
        old=selected(oldcopy)
        assert old.returncode==1,old.stdout+old.stderr
        assert 'temporário próprio deve ser removido' in old.stdout
        assert old_sentinel.read_bytes()==sentinel_content
        orphan_names=[p.name for p in (oldcopy/'dataset').iterdir() if p.name not in old_before and p!=old_sentinel]
        assert orphan_names, 'O teste antigo deveria deixar seu temporário após assertion'
        report['old31_negative_control']=dict(proof(old),foreign_preserved=True,left_own_temp_after_assertion=True)
    finally:
        for p in (oldcopy/'dataset').iterdir():
            if p.name not in old_before and p.is_file(): p.unlink()

    # Duas suítes padrão reais, simultâneas, no mesmo diretório com o temporário alheio.
    procs=[subprocess.Popen(['npm','test'],cwd=copy,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
    runs=[]
    for p in procs:
        out,err=p.communicate(timeout=20)
        record={'exit_code':p.returncode,'proof':[x for x in out.splitlines() if x.startswith(('# pass','# fail','# tests','not ok'))]}
        assert p.returncode==0,out+err
        runs.append(record)
    assert sentinel.read_bytes()==sentinel_content
    report['simultaneous_default_suites']={'runs':runs,'foreign_preserved':True,'same_copy':True,'default_workers':True}

    # Injeta órfão do prefixo da própria chamada para provocar a assertion preservada.
    metadata=probe_dir/'metadata.json'
    preload=probe_dir/'inject-own-orphan.mjs'
    preload.write_text("""
import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url);
const fs=require('node:fs');
const original=fs.writeFileSync;
const metadataPath=process.env.CONTY_REVIEW_METADATA;
fs.writeFileSync=(path,body,...args)=>{
  const result=original(path,body,...args);
  if(typeof path==='string'&&path.endsWith('.foreign-preexisting.tmp')){
    const owned=path.replace(/foreign-preexisting\\.tmp$/,'independent-injected.tmp');
    original(owned,'orphan-injected-by-independent-probe');
    original(metadataPath,JSON.stringify({foreign:path,owned}));
  }
  return result;
};
syncBuiltinESMExports();
""")
    os.environ['CONTY_REVIEW_METADATA']=str(metadata)
    failed=selected(copy,preload)
    assert failed.returncode==1,failed.stdout+failed.stderr
    assert 'temporário próprio deve ser removido' in failed.stdout
    paths=json.loads(metadata.read_text())
    assert not pathlib.Path(paths['foreign']).exists(), 'finally não removeu o temporário criado pelo próprio teste'
    assert not pathlib.Path(paths['owned']).exists(), 'finally não removeu órfão próprio após assertion'
    assert sentinel.read_bytes()==sentinel_content, 'finally removeu temporário de outra suíte'
    report['assertion_failure_finally']=dict(proof(failed),assertion_not_relaxed=True,own_foreign_removed=True,own_injected_orphan_removed=True,other_suite_preserved=True)
    leftovers=[p.name for p in (copy/'dataset').iterdir() if p.name!='series.json' and p.name!=sentinel_name]
    assert not leftovers,leftovers
    report['owned_leftovers']=leftovers
    report['passed']=True
finally:
    (copy/'dataset'/sentinel_name).unlink(missing_ok=True)
    shutil.rmtree(probe_dir)
    os.environ.pop('CONTY_REVIEW_METADATA',None)
output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(report,indent=2,ensure_ascii=False))
