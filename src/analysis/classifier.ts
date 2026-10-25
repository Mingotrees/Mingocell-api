import type { ClassifierConfig } from './config.js';
import { AnalysisFailure, type ModelMetadata, type Prediction } from './types.js';

export const CLASS_ORDER=['MYO','PMO','MYB','MMZ','NGB','NGS'];
const ARCHITECTURES=['vgg16','inceptionv3','densenet201','resnet152','swin_tiny'];
function invalid(): never {throw new AnalysisFailure('CLASSIFIER_RESPONSE_INVALID','suspend',true);}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string,unknown>;
}
const unit=(value: unknown): value is number => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1;
const equal=(a: unknown,b: unknown) => JSON.stringify(a)===JSON.stringify(b);
export function validateModel(value: unknown): ModelMetadata {
  const m=object(value);
  if (typeof m.package_id!=='string' || !/^[A-Za-z0-9._-]{1,128}$/.test(m.package_id)
    || !Number.isSafeInteger(m.package_version) || (m.package_version as number)<1
    || !equal(m.class_order,CLASS_ORDER) || !equal(m.architecture_order,ARCHITECTURES)
    || typeof m.temperature!=='number' || !Number.isFinite(m.temperature) || m.temperature<0.05 || m.temperature>10
    || !unit(m.abstention_threshold) || typeof m.device!=='string' || !/^(cpu|cuda(?::\d+)?)$/.test(m.device)) return invalid();
  return {package_id:m.package_id,package_version:m.package_version as number,class_order:[...CLASS_ORDER],architecture_order:[...ARCHITECTURES],temperature:m.temperature,abstention_threshold:m.abstention_threshold,device:m.device};
}
export function sameModel(a: ModelMetadata,b: ModelMetadata) {return equal(validateModel(a),validateModel(b));}
export function validatePrediction(value: unknown, model: ModelMetadata): Prediction {
  const p=object(value), m=validateModel(model);
  if(p.schema_version!==1 || p.package_id!==m.package_id || p.package_version!==m.package_version
    || !equal(p.class_order,m.class_order) || !Array.isArray(p.probabilities) || p.probabilities.length!==6
    || !p.probabilities.every(unit)) return invalid();
  const probabilities=p.probabilities as number[];
  const max=Math.max(...probabilities), index=probabilities.indexOf(max);
  const entropy=-probabilities.reduce((sum,x)=>sum+(x===0?0:x*Math.log(x)),0)/Math.log(6);
  if(Math.abs(probabilities.reduce((a,b)=>a+b,0)-1)>1e-6 || p.predicted_class!==m.class_order[index]
    || !unit(p.calibrated_confidence) || Math.abs(p.calibrated_confidence-max)>1e-6
    || !unit(p.normalized_entropy) || Math.abs(p.normalized_entropy-entropy)>1e-6
    || typeof p.abstained!=='boolean' || p.abstained!==(p.normalized_entropy>m.abstention_threshold)) return invalid();
  return {schema_version:1,package_id:m.package_id,package_version:m.package_version,class_order:m.class_order,
    probabilities:[...probabilities],predicted_class:m.class_order[index],calibrated_confidence:p.calibrated_confidence,normalized_entropy:p.normalized_entropy,abstained:p.abstained};
}
export type ClassifierClient = {
  ready(signal: AbortSignal): Promise<void>;
  model(signal: AbortSignal): Promise<ModelMetadata>;
  classify(input: {bytes: Uint8Array; filename: string; mediaType: string},signal: AbortSignal): Promise<unknown>;
};
export function createClassifierClient(config: ClassifierConfig, fetchImpl: typeof fetch = fetch): ClassifierClient {
  // Validate target here as well: injectable callers cannot forward a service token elsewhere.
  const target=new URL(config.baseUrl);
  if(target.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(target.hostname) || target.username || target.password || target.pathname!=='/' || target.search || target.hash) throw new AnalysisFailure('CLASSIFIER_CONFIG_INVALID','suspend');
  async function request(path: string,signal: AbortSignal,body?: FormData): Promise<unknown> {
    const dispatched=body!==undefined;
    try {
      const response=await fetchImpl(`${target.origin}${path}`,{method:body?'POST':'GET',body,
        headers:{Authorization:`Bearer ${config.token}`},redirect:'error',
        signal:AbortSignal.any([signal,AbortSignal.timeout(body?config.serviceTimeoutMs+30_000:10_000)])});
      if(!response.ok) {
        await response.body?.cancel();
        const classification=[401,403].includes(response.status)?'suspend':response.status>=500?'transient':'permanent';
        throw new AnalysisFailure(classification==='suspend'?'CLASSIFIER_AUTH_FAILED':classification==='permanent'?'CLASSIFIER_INPUT_REJECTED':'CLASSIFIER_UNAVAILABLE',classification,dispatched && classification!=='permanent');
      }
      const chunks:Uint8Array[]=[];let size=0;
      if(response.body) for await(const chunk of response.body){size+=chunk.byteLength;if(size>65536) return invalid();chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(error) {
      if(error instanceof AnalysisFailure) throw error;
      if(error instanceof SyntaxError) return invalid();
      throw new AnalysisFailure('CLASSIFIER_UNAVAILABLE','transient',dispatched);
    }
  }
  return {
    async ready(signal){const value=object(await request('/api/ready',signal));if(value.status!=='ready') return invalid();},
    async model(signal){return validateModel(await request('/api/model',signal));},
    async classify(input,signal){const form=new FormData();form.set('image',new Blob([Buffer.from(input.bytes)],{type:input.mediaType}),input.filename);return request('/api/classify',signal,form);},
  };
}
