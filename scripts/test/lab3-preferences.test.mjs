import test from 'node:test';
import assert from 'node:assert/strict';
import {blindOrder,compare,improveInput,judgeInput,solveInput,unblind,validateDataset} from '../lab3/preference-experiment.mjs';

const cases=['train','holdout'].map((split,i)=>({id:'case-'+i,split,task:'task '+i,source:'private origin '+i,checks:['condition '+i,'action '+i,'wording '+i]}));
const answers={baseline:{'case-0':'x','case-1':'y'},revision:{'case-0':'z','case-1':'w'}};
test('solver excludes references, optimizer excludes holdout, blind judge excludes ordering metadata',()=>{
  validateDataset({version:1,baseline:'initial',cases});
  assert(!solveInput('initial',cases[0]).includes('condition'));
  const improve=improveInput('initial',[cases[0]],answers.baseline);
  assert(improve.includes('condition 0')&&!improve.includes('task 1'));
  assert.throws(()=>improveInput('initial',cases,answers.baseline));
  const order=blindOrder(cases);
  const blind=judgeInput(cases,answers,order);
  for(const hidden of ['private origin','baseline','revision','holdout']) assert(!blind.includes(hidden));
});
test('equal results or a boundary regression keep the original; malformed judge output is rejected',()=>{
  const order={'case-0':'baseline','case-1':'revision'};
  const side=(scores)=>({scores,reason:'reason'});
  const raw=cases.map(c=>({id:c.id,A:side([2,1,1]),B:side([2,1,1])}));
  const result=()=>compare(unblind(JSON.stringify(raw),cases,order));
  assert.equal(result().recommended,'baseline');
  raw[1].A.scores=[2,2,1];
  assert.equal(result().recommended,'revision');
  raw[0].B.scores=[1,2,2];
  assert.equal(result().recommended,'baseline');
  raw[0].B.scores=[2,3,2];
  assert.throws(result);
  assert.throws(()=>unblind('[]',cases,order));
});
