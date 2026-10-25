import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {model,prediction} from './analysis-fixtures.mjs';
import {heartbeatTests} from './analysis-heartbeat.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export async function analysisTests(t, { pool, storage, browser, owner, ownerId }) {
  await heartbeatTests(t,{pool,storage,owner,ownerId});
  await t.test('valid stored TIFF expansion fails permanently without inference dispatch',{skip:!process.env.CLASSIFIER_PYTHON},async st=>{
    const {acquireWorker,claimNext,executeClaim,releaseWorker}=await import('../dist/analysis/worker.js');
    const {enqueueAnalysis}=await import('../dist/analysis/repository.js');
    const {stdout}=await promisify(execFile)(process.env.CLASSIFIER_PYTHON,[new URL('./classifier_fixtures.py',import.meta.url).pathname],{encoding:'buffer',maxBuffer:6*1024*1024});
    assert.ok(stdout.byteLength<=5*1024*1024);
    const uploaded=await owner.upload(stdout,randomUUID(),'expanding.tif','image/tiff');
    assert.equal(uploaded.status,201);
    const id=uploaded.data.submissions[0].id;
    await enqueueAnalysis(pool,id,ownerId);
    const worker=await acquireWorker(pool,120000);st.after(()=>releaseWorker(worker));
    await pool.query('UPDATE mingocell_data.classification_worker SET safe_after=now()');
    const claim=await claimNext(worker.client,worker.instanceId,210000);
    let dispatches=0;
    const client={ready:async()=>{},model:async()=>model,classify:async()=>{dispatches++;return prediction;}};
    const signal=new AbortController().signal;
    await executeClaim(worker,claim,{pool,storage,config:{pythonPath:process.env.CLASSIFIER_PYTHON,serviceTimeoutMs:120000},client,signal,log:()=>{}},signal);
    const row=(await pool.query('SELECT state,error_code FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId])).rows[0];
    assert.equal(row.state,'failed');assert.equal(row.error_code,'CLASSIFIER_INPUT_TOO_LARGE');assert.equal(dispatches,0);
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId]);
  });
  await t.test('lost worker connection cannot publish an in-flight result', async () => {
    const {acquireWorker,claimNext,executeClaim,recoverAttempts,releaseWorker}=await import('../dist/analysis/worker.js');
    const {enqueueAnalysis}=await import('../dist/analysis/repository.js');
    const bytes=await sharp({create:{width:3,height:3,channels:3,background:'green'}}).png().toBuffer();
    const upload=await owner.upload(bytes,randomUUID(),'lost.png','image/png');
    const id=upload.data.submissions[0].id;
    await enqueueAnalysis(pool,id,ownerId);
    const worker=await acquireWorker(pool,120000);
    const lost=new AbortController();worker.client.on('error',()=>lost.abort());
    await pool.query("UPDATE mingocell_data.classification_worker SET safe_after=now()-interval '1 second'");
    const claim=await claimNext(worker.client,worker.instanceId,210000);
    let dispatch,complete;
    const started=new Promise(resolve=>{dispatch=resolve;});
    const pending=new Promise(resolve=>{complete=resolve;});
    const client={ready:async()=>{},model:async()=>model,classify:async()=>{dispatch();return pending;}};
    const executing=executeClaim(worker,claim,{pool,storage,config:{serviceTimeoutMs:120000},client,signal:lost.signal,log:()=>{}},lost.signal);
    await started;
    await pool.query('SELECT pg_terminate_backend($1)',[worker.client.processID]);
    await new Promise(resolve=>setImmediate(resolve));complete(prediction);
    await assert.rejects(executing);
    const row=(await pool.query('SELECT state,result FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId])).rows[0];
    assert.equal(row.state,'running');assert.equal(row.result,null);
    worker.client.release(true);
    await pool.query("UPDATE mingocell_data.classification_worker SET safe_after=now()+interval '15 minutes'");
    const replacement=await acquireWorker(pool,120000);
    try{
      assert.equal(await claimNext(replacement.client,replacement.instanceId,210000),null,'replacement must preserve persisted uncertainty deadline');
      await pool.query("UPDATE mingocell_data.classification_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.jobId]);
      await recoverAttempts(replacement.client,replacement.instanceId,210000);
      await pool.query('UPDATE mingocell_data.classification_worker SET safe_after=now()');
      assert.equal(await claimNext(replacement.client,replacement.instanceId,210000),null,'recovered job must retain uncertainty delay independently');
      await pool.query('UPDATE mingocell_data.classification_jobs SET available_at=now() WHERE id=$1',[claim.jobId]);
      const retry=await claimNext(replacement.client,replacement.instanceId,210000);
      assert.equal(retry.jobId,claim.jobId);assert.equal(retry.attempts,2);assert.notEqual(retry.attemptId,claim.attemptId);
    }finally{await releaseWorker(replacement);}
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId]);
  });

  await t.test('graceful worker shutdown drains active work without claiming another image',async()=>{
    const {runClassificationWorker}=await import('../dist/analysis/worker.js');
    const {enqueueAnalysis}=await import('../dist/analysis/repository.js');
    const bytes=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).png().toBuffer();
    const ids=[];
    for(let i=0;i<2;i++){
      const upload=await owner.upload(bytes,randomUUID(),'drain.png','image/png');
      ids.push(upload.data.submissions[0].id);await enqueueAnalysis(pool,ids.at(-1),ownerId);
    }
    const stop=new AbortController();let dispatch,complete,calls=0;
    const started=new Promise(resolve=>{dispatch=resolve;});
    const pending=new Promise(resolve=>{complete=resolve;});
    const config={serviceTimeoutMs:120000};
    const previous=(await pool.query('SELECT instance_id FROM mingocell_data.classification_worker')).rows[0].instance_id;
    const client={ready:async()=>{},model:async()=>model,classify:async()=>{calls++;dispatch();return pending;}};
    const running=runClassificationWorker({pool,storage,config,client,signal:stop.signal,log:()=>{}});
    let instance;
    for(let n=0;n<100;n++){
      instance=(await pool.query('SELECT instance_id FROM mingocell_data.classification_worker')).rows[0].instance_id;
      if(instance&&instance!==previous)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.notEqual(instance,previous);
    await pool.query('UPDATE mingocell_data.classification_worker SET safe_after=now() WHERE instance_id=$1',[instance]);
    await started;
    stop.abort();complete(prediction);await running;
    assert.equal(calls,1);
    const states=(await pool.query('SELECT state FROM mingocell_data.classification_jobs WHERE submission_id=ANY($1::uuid[])',[ids])).rows.map(r=>r.state).sort();
    assert.deepEqual(states,['queued','succeeded']);
    assert.equal((await pool.query('SELECT state FROM mingocell_data.classification_worker')).rows[0].state,'offline');
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE submission_id=ANY($1::uuid[])',[ids]);
  });

  await t.test('worker publishes real multipart prediction, abstention and provenance atomically; model change suspends', async st => {
    const {acquireWorker,claimNext,executeClaim,releaseWorker}=await import('../dist/analysis/worker.js');
    const {enqueueAnalysis}=await import('../dist/analysis/repository.js');
    const {createClassifierClient}=await import('../dist/analysis/classifier.js');
    let mode='success',calls=0;
    const server=createServer(async(req,res)=>{
      assert.equal(req.headers.authorization,'Bearer '+ 'z'.repeat(40));
      const body=Buffer.concat(await Array.fromAsync(req));
      let data;
      if(req.url==='/api/ready') data={status:'ready'};
      else if(req.url==='/api/model')data={...model,temperature:mode==='changed' && calls>0?2:model.temperature};
      else{
        calls++;
        const db=(await pool.query("SELECT state FROM pg_stat_activity WHERE pid=$1",[worker.client.processID])).rows[0];
        assert.equal(db.state,'idle','inference must not hold a database transaction');
        assert.ok(body.includes(Buffer.from('name="image"')));
        data=mode==='abstain'?{...prediction,probabilities:Array(6).fill(1/6),calibrated_confidence:1/6,normalized_entropy:1,abstained:true}:prediction;
      }
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
    }).listen(0,'127.0.0.1');
    await once(server,'listening');st.after(()=>new Promise(resolve=>server.close(resolve)));
    const config={baseUrl:`http://127.0.0.1:${server.address().port}`,token:'z'.repeat(40),serviceTimeoutMs:120000,pythonPath:process.env.CLASSIFIER_PYTHON};
    const worker=await acquireWorker(pool,config.serviceTimeoutMs);
    st.after(()=>releaseWorker(worker));
    const options={pool,storage,config,client:createClassifierClient(config),signal:new AbortController().signal,log:()=>{}};
    for(const current of ['success','abstain','changed']){
      mode=current;calls=0;
      await pool.query("UPDATE mingocell_data.classification_worker SET state='ready',safe_after=now()-interval '1 second'");
      const bytes=await sharp({create:{width:5,height:5,channels:3,background:'red'}}).png().toBuffer();
      const upload=await owner.upload(bytes,randomUUID(),'worker.png','image/png');
      const id=upload.data.submissions[0].id;
      await enqueueAnalysis(pool,id,ownerId);
      const claim=await claimNext(worker.client,worker.instanceId,210000);
      await executeClaim(worker,claim,options,options.signal);
      const row=(await pool.query('SELECT j.*,s.status FROM mingocell_data.classification_jobs j JOIN mingocell_data.submissions s ON s.id=j.submission_id WHERE j.id=$1',[claim.jobId])).rows[0];
      if(current==='changed'){
        assert.equal(row.state,'queued');assert.equal(row.result,null);
        assert.equal((await pool.query('SELECT state FROM mingocell_data.classification_worker')).rows[0].state,'suspended');
      }else{
        assert.equal(row.state,'succeeded');assert.equal(row.status,'analyzed');
        assert.equal(row.result.prediction.abstained,current==='abstain');
        assert.equal(row.result.provenance.originalSha256,upload.data.image.sha256);
        assert.equal(row.result.provenance.pageIndex,0);
      }
      await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId]);
    }
  });
  await t.test('worker singleton, fencing, retry delays and recovery survive independent sessions', async () => {
    const {acquireWorker,claimNext,finishAttempt,failAttempt,recoverAttempts,releaseWorker} = await import('../dist/analysis/worker.js');
    const {enqueueAnalysis}=await import('../dist/analysis/repository.js');
    const {AnalysisFailure}=await import('../dist/analysis/types.js');
    const png=await sharp({create:{width:4,height:4,channels:3,background:'blue'}}).png().toBuffer();
    const uploaded=await owner.upload(png,randomUUID(),'worker.png','image/png');
    const id=uploaded.data.submissions[0].id;
    const job=await enqueueAnalysis(pool,id,ownerId);
    const worker=await acquireWorker(pool,120000);
    assert.ok(worker);
    assert.equal(await acquireWorker(pool,120000),null);
    assert.equal(await claimNext(worker.client,worker.instanceId,210000),null,'startup cooldown must block dispatch');
    await pool.query("UPDATE mingocell_data.classification_worker SET safe_after=now()-interval '1 second'");
    let claim=await claimNext(worker.client,worker.instanceId,210000);
    assert.equal(claim.jobId,job.analysis.id);
    assert.equal(await finishAttempt(worker.client,{...claim,attemptId:randomUUID()},worker.instanceId,{prediction:{},provenance:{}}),false);
    await failAttempt(worker.client,claim,worker.instanceId,new AnalysisFailure('CLASSIFIER_UNAVAILABLE','transient'));
    let row=(await pool.query('SELECT *,extract(epoch from available_at-now()) AS delay FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId])).rows[0];
    assert.equal(row.state,'queued');assert.ok(Number(row.delay)>28 && Number(row.delay)<=30);
    assert.equal(await claimNext(worker.client,worker.instanceId,210000),null);
    await pool.query('UPDATE mingocell_data.classification_jobs SET available_at=now() WHERE id=$1',[claim.jobId]);
    claim=await claimNext(worker.client,worker.instanceId,210000);
    await failAttempt(worker.client,claim,worker.instanceId,new AnalysisFailure('CLASSIFIER_UNAVAILABLE','transient'));
    row=(await pool.query('SELECT extract(epoch from available_at-now()) AS delay FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId])).rows[0];
    assert.ok(Number(row.delay)>118 && Number(row.delay)<=120);
    await pool.query('UPDATE mingocell_data.classification_jobs SET available_at=now() WHERE id=$1',[claim.jobId]);
    claim=await claimNext(worker.client,worker.instanceId,210000);
    await pool.query("UPDATE mingocell_data.classification_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.jobId]);
    await recoverAttempts(worker.client,worker.instanceId,210000);
    assert.equal(await finishAttempt(worker.client,claim,worker.instanceId,{prediction:{},provenance:{}}),false);
    row=(await pool.query('SELECT state,attempts FROM mingocell_data.classification_jobs WHERE id=$1',[claim.jobId])).rows[0];
    assert.equal(row.state,'failed');assert.equal(row.attempts,3);
    await releaseWorker(worker);
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE submission_id=$1',[id]);
  });

  await t.test('analysis is explicit, owner-only, CSRF protected and idempotent', async () => {
    const png = await sharp({create: {width: 16, height: 16, channels: 3, background: '#ab1234'}}).png().toBuffer();
    const upload = await owner.upload(png, randomUUID(), 'cell.png', 'image/png');
    assert.equal(upload.status, 201);
    const id = upload.data.submissions[0].id;
    const path = `/api/v1/submissions/${id}/analysis`;
    assert.equal((await owner.request(path)).data.analysis.state, 'not_requested');
    assert.equal((await browser().request(path)).status, 401);
    assert.equal((await owner.request(path, {method: 'POST', csrf: false})).status, 403);
    const responses = await Promise.all(Array.from({length: 10}, () => owner.request(path, {method: 'POST'})));
    assert.ok(responses.every(r => r.status === 202));
    assert.equal(new Set(responses.map(r => r.data.analysis.id)).size, 1);
    assert.equal((await owner.request(path)).data.analysis.state, 'queued');
    const other = browser();
    const {createAccount} = await import('../dist/auth/accounts.js');
    const email = `${randomUUID()}@example.org`;
    const password = 'Analysis test password 123!';
    await createAccount(pool, email, password, 'admin');
    await other.request('/api/v1/auth/session');
    await other.request('/api/v1/auth/login', {method: 'POST', body: {email, password}});
    assert.equal((await other.request(path)).status, 404);
    assert.equal((await other.request(path, {method: 'POST'})).status, 403);
    assert.equal((await owner.request('/api/v1/submissions/not-a-uuid/analysis')).status, 404);
    assert.doesNotMatch(JSON.stringify(responses), /storage_key|service_token|Bearer/);
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE submission_id=$1', [id]);
  });

  await t.test('queue capacity is atomic and completed jobs never enqueue again', async () => {
    const {enqueueAnalysis} = await import('../dist/analysis/repository.js');
    const image = await pool.query('SELECT id FROM mingocell_data.images WHERE owner_id=$1 LIMIT 1', [ownerId]);
    const ids = [];
    // Separate images avoid the (image_id,page_index) uniqueness bound of 20.
    for (let n = 0; n < 22; n++) {
      const imageId = randomUUID(), id = randomUUID();
      await pool.query(`INSERT INTO mingocell_data.images(id,owner_id,original_storage_key,sha256,byte_size,format,page_count)
        VALUES($1,$2,$3,$4,1,'png',1)`, [imageId,ownerId,`originals/test-${imageId}`, 'a'.repeat(64)]);
      await pool.query(`INSERT INTO mingocell_data.submissions(id,image_id,page_index,width,height,preview_storage_key)
        VALUES($1,$2,0,1,1,$3)`, [id,imageId,`previews/test-${id}`]);
      ids.push(id);
    }
    const results = await Promise.allSettled(ids.map(id => enqueueAnalysis(pool,id,ownerId)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 20);
    assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'ANALYSIS_QUEUE_FULL').length, 2);
    const kept = results.find(r => r.status === 'fulfilled').value.analysis;
    assert.equal((await enqueueAnalysis(pool,kept.submissionId,ownerId)).analysis.id, kept.id);
    await pool.query(`UPDATE mingocell_data.classification_jobs SET state='succeeded', result=$2::jsonb WHERE id=$1`, [kept.id, JSON.stringify({prediction:{},provenance:{}})]);
    assert.equal((await enqueueAnalysis(pool,kept.submissionId,ownerId)).analysis.state, 'succeeded');
    await pool.query("UPDATE mingocell_data.classification_jobs SET state='failed',result=NULL,attempts=1,retryable=false,error_code='INVALID_IMAGE' WHERE id=$1",[kept.id]);
    assert.equal((await enqueueAnalysis(pool,kept.submissionId,ownerId)).analysis.state,'failed');
    await pool.query('UPDATE mingocell_data.classification_jobs SET retryable=true WHERE id=$1',[kept.id]);
    const retry=await enqueueAnalysis(pool,kept.submissionId,ownerId);
    assert.equal(retry.analysis.state,'queued');assert.equal(retry.analysis.attempts,1);
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE submission_id=ANY($1::uuid[])', [ids]);
    const foreignOwner=randomUUID();
    await pool.query("INSERT INTO mingocell_auth.users(id,email,password_hash,role) VALUES($1,$2,'test-not-a-login','pathologist')",[foreignOwner,`${foreignOwner}@example.org`]);
    const foreignImages=Array.from({length:100},()=>randomUUID());
    const foreignSubmissions=Array.from({length:100},()=>randomUUID());
    await pool.query(`INSERT INTO mingocell_data.images(id,owner_id,original_storage_key,sha256,byte_size,format,page_count)
      SELECT id,$2,'originals/global-'||id,$3,1,'png',1 FROM unnest($1::uuid[]) id`,[foreignImages,foreignOwner,'a'.repeat(64)]);
    await pool.query(`INSERT INTO mingocell_data.submissions(id,image_id,page_index,width,height,preview_storage_key)
      SELECT s,i,0,1,1,'previews/global-'||s FROM unnest($1::uuid[],$2::uuid[]) AS x(s,i)`,[foreignSubmissions,foreignImages]);
    await pool.query(`INSERT INTO mingocell_data.classification_jobs(id,submission_id)
      SELECT gen_random_uuid(),id FROM unnest($1::uuid[]) id`,[foreignSubmissions]);
    await assert.rejects(enqueueAnalysis(pool,ids[0],ownerId),e=>e.code==='ANALYSIS_QUEUE_FULL');
    assert.equal((await enqueueAnalysis(pool,foreignSubmissions[0],foreignOwner)).analysis.state,'queued');
    await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE submission_id=ANY($1::uuid[])',[foreignSubmissions]);
    await pool.query('DELETE FROM mingocell_data.submissions WHERE id=ANY($1::uuid[])',[foreignSubmissions]);
    await pool.query('DELETE FROM mingocell_data.images WHERE id=ANY($1::uuid[])',[foreignImages]);
    await pool.query('DELETE FROM mingocell_auth.users WHERE id=$1',[foreignOwner]);
    await pool.query('DELETE FROM mingocell_data.submissions WHERE id=ANY($1::uuid[])', [ids]);
    await pool.query("DELETE FROM mingocell_data.images WHERE original_storage_key LIKE 'originals/test-%'");
  });
}
