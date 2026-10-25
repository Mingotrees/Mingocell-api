import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('PM2 starts one worker with .env loading and bounded graceful shutdown without token in definition',async t=>{
  const root=await mkdtemp(join(tmpdir(),'analysis-pm2-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'server.json');await writeFile(path,JSON.stringify({service_token:'test-only-token-'.repeat(3),timeout:120}),{mode:0o600});
  const module=new URL('../deploy/ecosystem.config.cjs',import.meta.url).pathname;
  const result=spawnSync(process.execPath,['-e',`process.stdout.write(JSON.stringify(require(process.argv[1])))`,module],{env:{...process.env,CLASSIFIER_CONFIG_PATH:path},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const [worker]=JSON.parse(result.stdout).apps;
  assert.equal(worker.instances,1);assert.equal(worker.exec_mode,'fork');assert.equal(worker.kill_timeout,210000);
  assert.match(worker.node_args,/--env-file-if-exists=.env/);assert.match(worker.script,/classification-worker.js$/);
  assert.doesNotMatch(result.stdout,/test-only-token-/);
});

for(const stopFails of [false,true])test(`deployment shell preserves drain/transfer/migrate/start ordering (stop fails: ${stopFails})`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'analysis-lifecycle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const stage=join(root,'.classifier-analysis-stage');
  const artifacts={
    'dist/cli/classification-worker.js':'new worker','package.json':'new package','package-lock.json':'new lock',
    'migrations/005_classification_jobs.sql':'new migration','scripts/extract-classifier-page.py':'new helper',
    'deploy/ecosystem.config.cjs':'new ecosystem','deploy/check-analysis-worker.mjs':'new check',
  };
  const {dirname}=await import('node:path');
  for(const [path,content] of Object.entries(artifacts)){await mkdir(dirname(join(stage,path)),{recursive:true});await writeFile(join(stage,path),content);}
  await mkdir(join(root,'dist/cli'),{recursive:true});await writeFile(join(root,'dist/cli/classification-worker.js'),'old worker');
  await writeFile(join(root,'events'),'');await mkdir(join(root,'bin'));
  const fixture=await readFile(new URL('./deploy-tool-fixture.mjs',import.meta.url),'utf8');
  await writeFile(join(root,'bin/tool.mjs'),`#!${process.execPath}\n${fixture}`,{mode:0o700});
  for(const command of ['node','pm2','npm','rsync','curl'])await symlink('tool.mjs',join(root,'bin',command));
  const workflow=await readFile(new URL('../.github/workflows/deploy.yml',import.meta.url),'utf8');
  const blocks=[...workflow.matchAll(/<<'REMOTE'\n([\s\S]*?)\n\s*REMOTE/g)];
  const shell=blocks.at(-1)[1].split('\n').map(line=>line.replace(/^          /,'')).join('\n')
    .replaceAll('/data/users/s22101440/api-mingocell.dcism.org',root);
  let result;
  try{result=await promisify(execFile)('/usr/bin/bash',['-c',shell],{cwd:root,env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`,TEST_DEPLOY_ROOT:root,TEST_STOP_FAIL:String(stopFails)}});}
  catch(error){if(!stopFails)throw error;result=error;}
  const events=(await readFile(join(root,'events'),'utf8')).trim().split('\n');
  assert.deepEqual(events.slice(0,2),['preflight','stop']);
  if(stopFails){
    assert.notEqual(result.code,0);assert.equal(await readFile(join(root,'dist/cli/classification-worker.js'),'utf8'),'old worker');
    assert.deepEqual(events,['preflight','stop']);
  }else{
    assert.ok(events.indexOf('stop')<events.indexOf('transfer'));
    assert.ok(events.lastIndexOf('transfer')<events.indexOf('migrate'));
    assert.ok(events.indexOf('migrate')<events.indexOf('start'));
    assert.ok(events.indexOf('start')<events.indexOf('check'));
    assert.equal(await readFile(join(root,'scripts/extract-classifier-page.py'),'utf8'),'new helper');
  }
});
