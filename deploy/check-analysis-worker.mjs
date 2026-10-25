import {spawnSync} from 'node:child_process';
import {dirname,basename,join} from 'node:path';
import {realpath} from 'node:fs/promises';
import {loadClassifierConfig} from '../dist/analysis/config.js';
import {createClassifierClient} from '../dist/analysis/classifier.js';

try {
  const config=await loadClassifierConfig();
  const client=createClassifierClient(config);
  const signal=AbortSignal.timeout(30_000);
  await client.ready(signal);
  const model=await client.model(signal);
  const python=join(await realpath(dirname(config.pythonPath)),basename(config.pythonPath));
  const decoder=spawnSync(python,['-c','from PIL import Image, ImageOps; import PIL; print(PIL.__version__)'],{encoding:'utf8',timeout:10_000,maxBuffer:4096});
  if(decoder.status!==0 || !/^13\.0\.0\s*$/.test(decoder.stdout))throw new Error();
  if(!process.argv.includes('--preflight')){
    const {pool}=await import('../dist/database/pool.js');
    try {
      const old=process.env.ANALYSIS_PREVIOUS_INSTANCE || null;
      const result=await pool.query(`SELECT instance_id,state FROM mingocell_data.classification_worker
        WHERE heartbeat_at>now()-interval '30 seconds' AND state IN ('ready','recovering')
        AND ($1::uuid IS NULL OR instance_id<>$1::uuid)`,[old]);
      if(result.rowCount!==1)throw new Error();
    }finally{await pool.end();}
  }
  console.log(`Analysis ${process.argv.includes('--preflight')?'preflight':'worker'} check passed; ${model.package_id} v${model.package_version}; Pillow 13.0.0.`);
}catch{
  console.error('Analysis worker check failed. Inspect private configuration, classifier readiness, decoder, and worker heartbeat.');
  process.exitCode=1;
}
