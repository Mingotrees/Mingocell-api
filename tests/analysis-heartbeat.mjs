import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {model,prediction} from './analysis-fixtures.mjs';

export async function heartbeatTests(t,{pool,storage,owner,ownerId}){
  for(const outcome of ['succeeded','failed'])for(const phase of ['settling','inflight'])await t.test(`heartbeat ${phase} during ${outcome} transition does not stop next image`,async st=>{
    const {runClassificationWorker}=await import('../dist/analysis/worker.js');
    const {enqueueAnalysis}=await import('../dist/analysis/repository.js');
    const {AnalysisFailure}=await import('../dist/analysis/types.js');
    st.mock.timers.enable({apis:['setInterval']});
    const stop=new AbortController();let running;
    const ids=[];
    try{
      const bytes=await sharp({create:{width:3,height:3,channels:3,background:'blue'}}).png().toBuffer();
      for(let i=0;i<2;i++){
        const uploaded=await owner.upload(bytes,randomUUID(),'heartbeat.png','image/png');
        const id=uploaded.data.submissions[0].id;ids.push(id);await enqueueAnalysis(pool,id,ownerId);
      }
      const db=await pool.connect();
      const query=db.query.bind(db);
      let overlapped=false,heartbeatDone;
      let renewalStarted,terminalUpdated,renewalDone;
      const renewalPending=new Promise(resolve=>{renewalStarted=resolve;});
      const terminal=new Promise(resolve=>{terminalUpdated=resolve;});
      const renewed=new Promise(resolve=>{renewalDone=resolve;});
      let started;const startup=new Promise(resolve=>{started=resolve;});
      const heartbeat=new Promise(resolve=>{heartbeatDone=resolve;});
      // Keep real PostgreSQL side effects, delaying only terminal-query delivery
      // so interval renewal overlaps the settled row deterministically.
      db.query=async(text,...args)=>{
        const renewal=typeof text==='string'&&text.includes('SET lease_until=now()');
        if(renewal&&phase==='inflight'&&!overlapped){renewalStarted();await terminal;}
        const result=await query(text,...args);
        if(renewal)renewalDone();
        if(typeof text==='string'&&text.includes("state='recovering'"))started();
        if(typeof text==='string'&&text.includes('SET heartbeat_at=now()'))heartbeatDone();
        const settled=typeof text==='string'&&(outcome==='succeeded'?text.includes("SET state='succeeded'"):text.includes('SET state=$3')&&args[0]?.[2]==='failed');
        if(settled&&!overlapped){
          overlapped=true;
          if(phase==='settling'){st.mock.timers.tick(10000);await heartbeat;}
          else{terminalUpdated();await renewed;}
          await new Promise(resolve=>setImmediate(resolve));
        }
        return result;
      };
      let calls=0,second;
      const processed=new Promise(resolve=>{second=resolve;});
      const client={ready:async()=>{},model:async()=>model,classify:async()=>{
        calls++;
        if(calls===1&&phase==='inflight'){st.mock.timers.tick(10000);await renewalPending;}
        if(calls===1&&outcome==='failed')throw new AnalysisFailure('CLASSIFIER_INPUT_REJECTED','permanent');
        if(calls===2){second('second');stop.abort();}
        return prediction;
      }};
      running=runClassificationWorker({pool:{connect:async()=>db},storage,config:{serviceTimeoutMs:120000},client,signal:stop.signal,log:()=>{}});
      await startup;
      await pool.query('UPDATE mingocell_data.classification_worker SET safe_after=now()');
      // A resolved permanent rejection leaves a conservative dispatch margin;
      // advance it in this fixture after the failed transaction has committed.
      if(outcome==='failed'){
        for(let n=0;n<200;n++){
          const row=await pool.query("SELECT 1 FROM mingocell_data.classification_jobs WHERE submission_id=ANY($1::uuid[]) AND state='failed'",[ids]);
          if(row.rowCount){await pool.query('UPDATE mingocell_data.classification_worker SET safe_after=now()');break;}
          await delay(20);
        }
      }
      assert.equal(await Promise.race([processed,running.then(()=> 'exited'),delay(6000).then(()=> 'timeout')]),'second');
      await running;
      assert.equal(calls,2);assert.equal(overlapped,true);
    }finally{
      stop.abort();await running?.catch(()=>{});st.mock.timers.reset();
      await pool.query('DELETE FROM mingocell_data.classification_jobs WHERE submission_id=ANY($1::uuid[])',[ids]);
    }
  });
}
