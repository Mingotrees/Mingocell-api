// Executed under command aliases in a disposable deployment fixture, never on server.
import {appendFile,readFile,writeFile,access,cp,rm} from 'node:fs/promises';
import {basename,join} from 'node:path';
const root=process.env.TEST_DEPLOY_ROOT;
if(!root||!root.includes('analysis-lifecycle-'))throw new Error('Disposable fixture root required.');
const command=basename(process.argv[1]),args=process.argv.slice(2);
const file=path=>join(root,path);
const record=event=>appendFile(file('events'),`${event}\n`);
const requireFile=async(path,expected)=>{if((await readFile(file(path),'utf8'))!==expected)throw new Error(`Unexpected artifact: ${path}`);};
try{
  if(command==='node'){
    if(args.includes('--preflight')){
      await requireFile('.classifier-analysis-stage/scripts/extract-classifier-page.py','new helper');
      await record('preflight');
    }else if(args.includes('--input-type=module'))process.stdout.write('3594d0a6-c993-4518-8e6c-cd32e098e351');
    else{await access(file('started'));await record('check');}
  }else if(command==='pm2'){
    if(args[0]==='describe')process.exit(0);
    if(args[0]==='stop'){
      await requireFile('dist/cli/classification-worker.js','old worker');
      await record('stop');
      if(process.env.TEST_STOP_FAIL==='true')process.exit(1);
      await writeFile(file('stopped'),'yes');
    }else if(args[0]==='startOrRestart'){
      await access(file('migrated'));
      await requireFile('dist/cli/classification-worker.js','new worker');
      await requireFile('scripts/extract-classifier-page.py','new helper');
      await requireFile('deploy/ecosystem.config.cjs','new ecosystem');
      await writeFile(file('started'),'yes');await record('start');
    }else{await access(file('migrated'));await record('api restart');}
  }else if(command==='rsync'){
    await access(file('stopped'));
    const paths=args.filter(arg=>!arg.startsWith('-')),destination=paths.pop();
    for(const source of paths){
      const target=source.endsWith('/')?file(destination):join(file(destination),basename(source));
      if(args.includes('--delete-delay'))await rm(target,{recursive:true,force:true});
      await cp(file(source),target,{recursive:true});
    }
    await record('transfer');
  }else if(command==='npm'){
    if(args[0]==='ci'){await requireFile('package.json','new package');await writeFile(file('installed'),'yes');await record('install');}
    else{await access(file('installed'));await requireFile('migrations/005_classification_jobs.sql','new migration');await writeFile(file('migrated'),'yes');await record('migrate');}
  }else if(command==='curl'){await access(file('started'));}
  else throw new Error('Unexpected command');
}catch(error){console.error(error.message);process.exitCode=1;}
