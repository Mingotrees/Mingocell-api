import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const script=new URL('../scripts/package-runtime.mjs',import.meta.url).pathname;
test('CI runtime artifact contains executable contract but excludes private/unrelated files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mingocell-ci-artifact-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const files=['dist/server.js','dist/cli/classification-worker.js','migrations/005_classification_jobs.sql','scripts/extract-classifier-page.py','deploy/check-analysis-worker.mjs','deploy/ecosystem.config.cjs','package.json','package-lock.json'];
  for(const path of [...files,'.env','storage/private.png','tests/private.test.mjs','scripts/unrelated.mjs']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),path);}
  const output=join(root,'runtime');await promisify(execFile)(process.execPath,[script,output],{cwd:root});
  for(const path of files)assert.equal(await readFile(join(output,path),'utf8'),path);
  for(const path of ['.env','storage/private.png','tests/private.test.mjs','scripts/unrelated.mjs'])await assert.rejects(access(join(output,path)));
  await rm(join(root,'dist/cli/classification-worker.js'));
  await assert.rejects(promisify(execFile)(process.execPath,[script,join(root,'incomplete')],{cwd:root}));
  await assert.rejects(access(join(root,'incomplete')));
});
