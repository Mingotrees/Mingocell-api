import { pool } from '../database/pool.js';
import { imageStorageOptions, initializeImageStorage } from '../images/storage.js';
import { loadClassifierConfig } from '../analysis/config.js';
import { createClassifierClient } from '../analysis/classifier.js';
import { runClassificationWorker } from '../analysis/worker.js';
import { logger } from '../logging.js';

const stop=new AbortController();
let grace=210_000;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
  if(stop.signal.aborted)process.exit(1);
  stop.abort();
  setTimeout(()=>process.exit(1),grace).unref();
});
try{
  const config=await loadClassifierConfig();
  grace=config.serviceTimeoutMs+90_000;
  const storage=imageStorageOptions(pool);
  await initializeImageStorage(storage);
  await runClassificationWorker({pool,storage,config,client:createClassifierClient(config),signal:stop.signal,log:logger});
}catch{logger('error','analysis.worker.failed');process.exitCode=1;}
finally{await pool.end();}
