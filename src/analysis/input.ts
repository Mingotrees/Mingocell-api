import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ClassifierConfig } from './config.js';
import { resolveStorageKey, type ImageStorageOptions, MAX_IMAGE_BYTES } from '../images/storage.js';
import { AnalysisFailure, type Claim } from './types.js';

export type PreparedInput={bytes:Uint8Array;filename:string;mediaType:string;sha256:string;extractionVersion:string;pillowVersion:string|null};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function prepareClassifierInput(claim:Claim, storage:ImageStorageOptions, config:ClassifierConfig,signal:AbortSignal):Promise<PreparedInput>{
  signal.throwIfAborted();
  let original:Buffer;
  try {
    const handle=await open(resolveStorageKey(storage,claim.originalStorageKey),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const stat=await handle.stat();if(!stat.isFile() || stat.size>MAX_IMAGE_BYTES) throw new Error();original=await handle.readFile();}
    finally {await handle.close();}
  } catch {throw new AnalysisFailure('ORIGINAL_UNAVAILABLE','transient');}
  if(hash(original)!==claim.originalSha256) throw new AnalysisFailure('ORIGINAL_INTEGRITY_FAILED','permanent');
  if(claim.pageCount===1) return {bytes:original,filename:`original.${claim.format==='jpeg'?'jpg':claim.format}`,mediaType:`image/${claim.format}`,sha256:claim.originalSha256,extractionVersion:'original-bytes-v1',pillowVersion:null};
  let python:string;
  // Resolve release symlink, not the executable symlink: realpath(python) would
  // bypass its virtualenv and lose Pillow.
  try {python=join(await realpath(dirname(config.pythonPath)),basename(config.pythonPath));}
  catch {throw new AnalysisFailure('CLASSIFIER_DECODER_UNAVAILABLE','suspend');}
  const output=await new Promise<{bytes:Buffer;meta:string}>((resolve,reject)=>{
    const child=spawn(python,[fileURLToPath(new URL('../../scripts/extract-classifier-page.py',import.meta.url)),String(claim.pageIndex)],{stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let bytes=0,meta='',failure:AnalysisFailure|undefined;
    const stop=(error:AnalysisFailure)=>{failure??=error;child.kill('SIGKILL');};
    const abort=()=>stop(new AnalysisFailure('ANALYSIS_ABORTED','transient'));
    const timer=setTimeout(()=>stop(new AnalysisFailure('CLASSIFIER_DECODER_TIMEOUT','permanent')),30_000);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted) abort();
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>9*1024*1024) stop(new AnalysisFailure('CLASSIFIER_INPUT_TOO_LARGE','permanent'));else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{meta+=chunk.toString('utf8');if(meta.length>4096) stop(new AnalysisFailure('CLASSIFIER_DECODER_INVALID','suspend'));});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{failure=new AnalysisFailure('CLASSIFIER_DECODER_UNAVAILABLE','suspend');});
    child.on('close',code=>{
      clearTimeout(timer);signal.removeEventListener('abort',abort);
      if(failure) reject(failure);
      else if(code!==0) reject(new AnalysisFailure(code===4?'CLASSIFIER_DECODER_UNAVAILABLE':code===3?'CLASSIFIER_INPUT_TOO_LARGE':'CLASSIFIER_INPUT_INVALID',code===4?'suspend':'permanent'));
      else resolve({bytes:Buffer.concat(chunks),meta});
    });
    child.stdin.end(original);
  });
  let metadata;
  try {metadata=JSON.parse(output.meta);if(metadata.extractionVersion!=='pillow-page-rgb-v1' || metadata.pillowVersion!=='13.0.0' || !output.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error();}
  catch {throw new AnalysisFailure('CLASSIFIER_DECODER_INVALID','suspend');}
  return {bytes:output.bytes,filename:`page-${claim.pageIndex}.png`,mediaType:'image/png',sha256:hash(output.bytes),extractionVersion:metadata.extractionVersion,pillowVersion:metadata.pillowVersion};
}
