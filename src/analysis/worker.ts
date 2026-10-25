import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { ImageStorageOptions } from '../images/storage.js';
import type { Logger } from '../logging.js';
import type { ClassifierConfig } from './config.js';
import { sameModel, validatePrediction, type ClassifierClient } from './classifier.js';
import { prepareClassifierInput } from './input.js';
import { AnalysisFailure, type Claim, type AnalysisResult } from './types.js';

type WorkerSession = {client: PoolClient; instanceId: string; settlingAttemptId: string | null};
const CONTROL='mingocell_data.classification_worker';
const JOBS='mingocell_data.classification_jobs';
const LOCK="hashtextextended('mingocell:classification-worker',0)";

async function transaction<T>(client:PoolClient,work:()=>Promise<T>):Promise<T>{
  await client.query('BEGIN');
  try{const value=await work();await client.query('COMMIT');return value;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}
export async function acquireWorker(pool:Pool,serviceTimeoutMs:number):Promise<WorkerSession|null>{
  const client=await pool.connect();
  try{
    const lock=await client.query(`SELECT pg_try_advisory_lock(${LOCK}) AS acquired`);
    if(!lock.rows[0].acquired){client.release();return null;}
    const instanceId=randomUUID();
    await client.query(`UPDATE ${CONTROL} SET instance_id=$1,heartbeat_at=now(),state='recovering',error_code=NULL,
      safe_after=greatest(safe_after,now()+$2*interval '1 millisecond')`,[instanceId,serviceTimeoutMs+90_000]);
    return {client,instanceId,settlingAttemptId:null};
  }catch(error){client.release(true);throw error;}
}
export async function releaseWorker(session:WorkerSession){
  try{await session.client.query(`UPDATE ${CONTROL} SET state='offline' WHERE instance_id=$1`,[session.instanceId]);}
  finally{session.client.release(true);}
}
export async function claimNext(client:PoolClient,instanceId:string,leaseMs:number):Promise<Claim|null>{
  return transaction(client,async()=>{
    const result=await client.query(`SELECT j.id AS "jobId",s.id AS "submissionId",i.original_storage_key AS "originalStorageKey",
      i.sha256 AS "originalSha256",i.format,s.page_index AS "pageIndex",i.page_count AS "pageCount",s.width,s.height
      FROM ${JOBS} j JOIN mingocell_data.submissions s ON s.id=j.submission_id
      JOIN mingocell_data.images i ON i.id=s.image_id
      WHERE j.state='queued' AND j.attempts<3 AND j.available_at<=now()
        AND EXISTS(SELECT 1 FROM ${CONTROL} WHERE instance_id=$1 AND safe_after<=now() AND state<>'suspended')
      ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[instanceId]);
    if(!result.rowCount) return null;
    const row=result.rows[0];const attemptId=randomUUID();
    const updated=await client.query(`UPDATE ${JOBS} SET state='running',attempts=attempts+1,attempt_id=$2,
      lease_until=now()+$3*interval '1 millisecond',started_at=now(),finished_at=NULL,dispatched_at=NULL,error_code=NULL
      WHERE id=$1 RETURNING attempts`,[row.jobId,attemptId,leaseMs]);
    return {...row,attemptId,attempts:updated.rows[0].attempts} as Claim;
  });
}
export async function renewAttempt(client:PoolClient,claim:Claim,instanceId:string,leaseMs:number):Promise<boolean>{
  const result=await client.query(`UPDATE ${JOBS} SET lease_until=now()+$4*interval '1 millisecond'
    WHERE id=$1 AND attempt_id=$2 AND state='running' AND lease_until>now()
    AND EXISTS(SELECT 1 FROM ${CONTROL} WHERE instance_id=$3)`,[claim.jobId,claim.attemptId,instanceId,leaseMs]);
  return result.rowCount===1;
}
export async function finishAttempt(client:PoolClient,claim:Claim,instanceId:string,result:AnalysisResult):Promise<boolean>{
  return transaction(client,async()=>{
    const saved=await client.query(`UPDATE ${JOBS} SET state='succeeded',result=$4::jsonb,finished_at=now(),lease_until=NULL,
      error_code=NULL,retryable=false WHERE id=$1 AND attempt_id=$2 AND state='running' AND lease_until>now()
      AND EXISTS(SELECT 1 FROM ${CONTROL} WHERE instance_id=$3) RETURNING submission_id`,[claim.jobId,claim.attemptId,instanceId,JSON.stringify(result)]);
    if(!saved.rowCount)return false;
    await client.query("UPDATE mingocell_data.submissions SET status='analyzed' WHERE id=$1",[claim.submissionId]);
    return true;
  });
}
export async function failAttempt(client:PoolClient,claim:Claim,instanceId:string,failure:AnalysisFailure):Promise<void>{
  await transaction(client,async()=>{
    const current=await client.query(`SELECT dispatched_at FROM ${JOBS} WHERE id=$1 AND attempt_id=$2 AND state='running'
      AND lease_until>now() AND EXISTS(SELECT 1 FROM ${CONTROL} WHERE instance_id=$3) FOR UPDATE`,[claim.jobId,claim.attemptId,instanceId]);
    if(!current.rowCount)return;
    const restore=failure.classification==='suspend' && !current.rows[0].dispatched_at;
    const terminal=failure.classification==='permanent' || (!restore && claim.attempts>=3);
    if(failure.classification==='suspend')await client.query(`UPDATE ${CONTROL} SET state='suspended',error_code=$2 WHERE instance_id=$1`,[instanceId,failure.code]);
    await client.query(`UPDATE ${JOBS} SET state=$3,attempts=attempts-$4,lease_until=NULL,error_code=$5,retryable=false,
      available_at=greatest(now()+$6*interval '1 millisecond',CASE WHEN $7 THEN (SELECT safe_after FROM ${CONTROL}) ELSE now() END),
      finished_at=CASE WHEN $3='failed' THEN now() ELSE NULL END WHERE id=$1 AND attempt_id=$2`,
    [claim.jobId,claim.attemptId,terminal?'failed':'queued',restore?1:0,failure.code,claim.attempts===1?30_000:120_000,failure.uncertain]);
    if(terminal)await client.query("UPDATE mingocell_data.submissions SET status='failed' WHERE id=$1",[claim.submissionId]);
  });
}
export async function recoverAttempts(client:PoolClient,instanceId:string,safetyMs:number){
  await transaction(client,async()=>{
    const recovered=await client.query(`UPDATE ${JOBS} SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
      available_at=greatest(now(),lease_until+$2*interval '1 millisecond',(SELECT safe_after FROM ${CONTROL})),
      lease_until=NULL,error_code='WORKER_INTERRUPTED',retryable=false,
      finished_at=CASE WHEN attempts>=3 THEN now() ELSE NULL END
      WHERE state='running' AND lease_until<=now() AND EXISTS(SELECT 1 FROM ${CONTROL} WHERE instance_id=$1)
      RETURNING submission_id,state`,[instanceId,safetyMs]);
    for(const row of recovered.rows)if(row.state==='failed')await client.query("UPDATE mingocell_data.submissions SET status='failed' WHERE id=$1",[row.submission_id]);
  });
}
export type WorkerOptions={pool:Pool;storage:ImageStorageOptions;config:ClassifierConfig;client:ClassifierClient;signal:AbortSignal;log:Logger};

export async function executeClaim(session:WorkerSession,claim:Claim,options:WorkerOptions,signal:AbortSignal):Promise<void>{
  const {client:db,instanceId}=session;const {config,client,storage}=options;
  try{
    const owner=await db.query(`SELECT u.active FROM mingocell_auth.users u JOIN mingocell_data.images i ON i.owner_id=u.id
      JOIN mingocell_data.submissions s ON s.image_id=i.id WHERE s.id=$1`,[claim.submissionId]);
    if(!owner.rows[0]?.active)throw new AnalysisFailure('OWNER_INACTIVE','permanent');
    await client.ready(signal);
    const before=await client.model(signal);
    const input=await prepareClassifierInput(claim,storage,config,signal);
    // Commit dispatch boundary before HTTP; crash here conservatively counts an attempt.
    const dispatch=await transaction(db,async()=>{
      const updated=await db.query(`UPDATE ${JOBS} SET dispatched_at=now() WHERE id=$1 AND attempt_id=$2 AND state='running'
        AND lease_until>now() AND EXISTS(SELECT 1 FROM ${CONTROL} WHERE instance_id=$3) RETURNING id`,[claim.jobId,claim.attemptId,instanceId]);
      if(updated.rowCount)await db.query(`UPDATE ${CONTROL} SET safe_after=now()+$2*interval '1 millisecond' WHERE instance_id=$1`,[instanceId,config.serviceTimeoutMs+90_000]);
      return updated.rowCount===1;
    });
    if(!dispatch)return;
    const response=await client.classify(input,signal);
    const after=await client.model(signal);
    if(!sameModel(before,after))throw new AnalysisFailure('CLASSIFIER_IDENTITY_CHANGED','suspend',true);
    const prediction=validatePrediction(response,before);
    session.settlingAttemptId=claim.attemptId;
    const saved=await finishAttempt(db,claim,instanceId,{prediction,provenance:{originalSha256:claim.originalSha256,inputSha256:input.sha256,
      pageIndex:claim.pageIndex,extractionVersion:input.extractionVersion,pillowVersion:input.pillowVersion,model:before,analyzedAt:new Date().toISOString()}});
    if(saved){
      // A completed HTTP response + metadata check resolves uncertainty; next job need not wait.
      await db.query(`UPDATE ${CONTROL} SET safe_after=now() WHERE instance_id=$1`,[instanceId]);
      options.log('info','analysis.succeeded',{jobId:claim.jobId,submissionId:claim.submissionId});
    }
  }catch(error){
    if(signal.aborted)throw error;
    const failure=error instanceof AnalysisFailure?error:new AnalysisFailure('ANALYSIS_UNAVAILABLE','transient',true);
    session.settlingAttemptId=claim.attemptId;
    await failAttempt(db,claim,instanceId,failure);
    options.log('warn','analysis.attempt.failed',{jobId:claim.jobId,code:failure.code});
  }
}

export async function runClassificationWorker(options:WorkerOptions):Promise<void>{
  const {pool,config,signal,log}=options;
  let session:WorkerSession|null=null;
  while(!signal.aborted && !session){session=await acquireWorker(pool,config.serviceTimeoutMs);if(!session)await delay(2000,undefined,{signal}).catch(()=>{});}
  if(!session)return;
  const {client:db,instanceId}=session;
  const lost=new AbortController();
  const onLost=()=>lost.abort();
  db.on('error',onLost);db.on('end',onLost);
  let active:Claim|null=null,heartbeatBusy=false;
  const heartbeat=setInterval(async()=>{
    if(heartbeatBusy || lost.signal.aborted)return;
    heartbeatBusy=true;
    try{
      const updated=await db.query(`UPDATE ${CONTROL} SET heartbeat_at=now() WHERE instance_id=$1`,[instanceId]);
      if(!updated.rowCount){lost.abort();return;}
      const claim=active;
      if(claim && session.settlingAttemptId!==claim.attemptId){
        const renewed=await renewAttempt(db,claim,instanceId,config.serviceTimeoutMs+90_000);
        // Completion may clear running state while this renewal is in flight.
        // Only an executing, unchanged attempt can lose its lease here. Terminal
        // publication still enforces UUID/instance/lease fences independently.
        if(!renewed && active===claim && session.settlingAttemptId!==claim.attemptId)lost.abort();
      }
    }catch{lost.abort();}finally{heartbeatBusy=false;}
  },10_000);
  log('info','analysis.worker.started',{instanceId});
  try{
    while(!signal.aborted && !lost.signal.aborted){
      await recoverAttempts(db,instanceId,config.serviceTimeoutMs+90_000);
      const control=(await db.query(`SELECT state,safe_after<=now() AS available FROM ${CONTROL} WHERE instance_id=$1`,[instanceId])).rows[0];
      if(!control)break;
      if(control.state==='suspended'){
        try{
          await options.client.ready(lost.signal);
          const before=await options.client.model(lost.signal);
          const after=await options.client.model(lost.signal);
          if(!sameModel(before,after))throw new Error();
          await db.query(`UPDATE ${CONTROL} SET state='recovering',error_code=NULL WHERE instance_id=$1`,[instanceId]);
        }catch{await delay(60_000,undefined,{signal:AbortSignal.any([signal,lost.signal])}).catch(()=>{});}
        continue;
      }
      if(control.available){
        await db.query(`UPDATE ${CONTROL} SET state='ready' WHERE instance_id=$1`,[instanceId]);
        session.settlingAttemptId=null;
        active=await claimNext(db,instanceId,config.serviceTimeoutMs+90_000);
        if(active){await executeClaim(session,active,options,lost.signal);active=null;continue;}
      }
      await delay(2000,undefined,{signal:AbortSignal.any([signal,lost.signal])}).catch(()=>{});
    }
  }finally{
    clearInterval(heartbeat);
    db.removeListener('error',onLost);db.removeListener('end',onLost);
    if(lost.signal.aborted)db.release(true);else await releaseWorker(session);
  }
}
