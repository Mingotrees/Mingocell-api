import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {createClassifierClient,validatePrediction,validateModel,sameModel} from '../dist/analysis/classifier.js';

import {model,prediction} from './analysis-fixtures.mjs';
test('prediction validates calibrated distribution, class, policy and model identity', () => {
  assert.deepEqual(validatePrediction(prediction,model),prediction);
  for (const change of [{probabilities:[null,0,0,0,0,0]}, {predicted_class:'PMO'}, {calibrated_confidence:0.9}, {normalized_entropy:0.5}, {abstained:true}, {package_version:2}, {class_order:[...model.class_order].reverse()}]) {
    assert.throws(() => validatePrediction({...prediction,...change},model));
  }
  const equal = {...prediction,probabilities:Array(6).fill(1/6),calibrated_confidence:1/6,normalized_entropy:1,abstained:true};
  assert.equal(validatePrediction(equal,model).abstained,true);
  assert.throws(() => validateModel({...model,temperature:0}));
  assert.equal(sameModel(model,{...model,temperature:1.5}),false);
  assert.equal(sameModel(model,{...model}),true);
});
test('classifier uses authenticated multipart and bounds untrusted responses', async t => {
  let status = 200, payload = JSON.stringify(prediction), location;
  const server = createServer(async (req,res) => {
    const body = Buffer.concat(await Array.fromAsync(req)).toString();
    assert.equal(req.headers.authorization,'Bearer '+ 't'.repeat(40));
    if (req.url === '/api/classify') { assert.match(body,/name="image"/); assert.match(body,/test original/); }
    res.writeHead(status,{'Content-Type':'application/json',...(location?{Location:location}:{})}).end(payload);
  }).listen(0,'127.0.0.1');
  await once(server,'listening'); t.after(() => new Promise(resolve=>server.close(resolve)));
  const client = createClassifierClient({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'t'.repeat(40),serviceTimeoutMs:100,pythonPath:'/test'});
  const call = () => client.classify({bytes:Buffer.from('test original'),filename:'page.png',mediaType:'image/png'},new AbortController().signal);
  assert.deepEqual(await call(),prediction);
  for (const [s,kind] of [[400,'permanent'],[413,'permanent'],[401,'suspend'],[403,'suspend'],[503,'transient']]) {
    status=s; await assert.rejects(call(),e=> e.classification===kind && !e.message.includes('tttt'));
  }
  status=200; payload='x'.repeat(70_000); await assert.rejects(call());
  payload='not json'; await assert.rejects(call());
  status=302; location='http://example.invalid/'; await assert.rejects(call());
});
