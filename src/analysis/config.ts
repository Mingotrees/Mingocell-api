import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AnalysisFailure } from './types.js';

export type ClassifierConfig = {baseUrl: string; token: string; serviceTimeoutMs: number; pythonPath: string};
export async function loadClassifierConfig(environment: NodeJS.ProcessEnv = process.env): Promise<ClassifierConfig> {
  const root='/data/users/s22101440/mingocell-classifier-runtime';
  try {
    const url = new URL(environment.CLASSIFIER_URL ?? 'http://127.0.0.1:20301');
    if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    const pythonPath=environment.CLASSIFIER_PYTHON ?? `${root}/current/.venv/bin/python`;
    if (!isAbsolute(pythonPath)) throw new Error();
    const file=await open(environment.CLASSIFIER_CONFIG_PATH ?? `${root}/server.json`,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat=await file.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 16384) throw new Error();
      const config=JSON.parse(await file.readFile('utf8'));
      const timeout=config.timeout ?? 120;
      if (typeof config.service_token !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(config.service_token)
        || !Number.isInteger(timeout) || timeout <= 0 || timeout > 3600) throw new Error();
      return {baseUrl:url.origin,pythonPath,token:config.service_token,serviceTimeoutMs:timeout*1000};
    } finally {await file.close();}
  } catch {throw new AnalysisFailure('CLASSIFIER_CONFIG_INVALID','suspend');}
}
