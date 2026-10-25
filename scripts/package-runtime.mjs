import {cp,lstat,mkdir,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';

const root=process.cwd();
const output=resolve(process.argv[2]||'runtime');
const required=['dist/server.js','dist/cli/classification-worker.js','migrations/005_classification_jobs.sql','migrations/006_expert_reviews.sql','scripts/extract-classifier-page.py','deploy/check-analysis-worker.mjs','deploy/ecosystem.config.cjs','package.json','package-lock.json'];
const paths=['dist','migrations','scripts/extract-classifier-page.py','deploy/check-analysis-worker.mjs','deploy/ecosystem.config.cjs','package.json','package-lock.json'];
for(const path of required){const details=await lstat(join(root,path));if(!details.isFile()||details.isSymbolicLink())throw new Error(`Missing runtime file: ${path}`);}
// Refuse existing output rather than delete anything the caller might own.
await mkdir(output);
try{
  for(const path of paths){
    await mkdir(dirname(join(output,path)),{recursive:true});
    await cp(join(root,path),join(output,path),{recursive:true,filter:async source=>{if((await lstat(source)).isSymbolicLink())throw new Error('Runtime artifact cannot contain symlinks.');return true;}});
  }
  console.log('Validated runtime artifact packaged.');
}catch(error){await rm(output,{recursive:true,force:true});throw error;}
