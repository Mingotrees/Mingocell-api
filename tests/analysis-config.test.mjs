import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadClassifierConfig} from '../dist/analysis/config.js';
test('private service config permissions, token and loopback endpoint are validated',async t=>{
  const root=await mkdtemp(join(tmpdir(),'analysis-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'server.json'), link=join(root,'link');
  await writeFile(path,JSON.stringify({service_token:'x'.repeat(40),timeout:120}),{mode:0o600});
  const env={CLASSIFIER_CONFIG_PATH:path};
  assert.equal((await loadClassifierConfig(env)).serviceTimeoutMs,120_000);
  await chmod(path,0o644);await assert.rejects(loadClassifierConfig(env));await chmod(path,0o600);
  await symlink(path,link);await assert.rejects(loadClassifierConfig({CLASSIFIER_CONFIG_PATH:link}));
  for(const url of ['https://example.com','http://user:pw@127.0.0.1','http://127.0.0.1/?token=x']) await assert.rejects(loadClassifierConfig({...env,CLASSIFIER_URL:url}));
  for(const value of [{service_token:'short',timeout:120},{service_token:'x'.repeat(40),timeout:0},{service_token:'x'.repeat(40),timeout:1e9}]){
    await writeFile(path,JSON.stringify(value));await assert.rejects(loadClassifierConfig(env));
  }
});
