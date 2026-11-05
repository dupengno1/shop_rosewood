import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOmsMajorAmount,formatOmsMajorAmount,formatOmsMoney} from './oms-money';

test('OMS major-unit input preserves exact minor units for zero, two and three fraction currencies',()=>{
  for(const [input,precision,expected] of [['0.01',2,1],['10.00',2,1000],['0.29',2,29],[' 00010.5 ',2,1050],['10',0,10],['0.001',3,1],['12.345',3,12345],['0.000001',6,1]] as const){
    assert.equal(parseOmsMajorAmount(input,precision),expected);
    assert.equal(parseOmsMajorAmount(formatOmsMajorAmount(expected,precision),precision),expected);
  }
  assert.equal(formatOmsMoney(1,'USD',2),'USD 0.01');
  assert.equal(formatOmsMoney(10,'JPY',0),'JPY 10');
  assert.equal(formatOmsMoney(12345,'KWD',3),'KWD 12.345');
  assert.equal(formatOmsMoney(0,'USD',2),'USD 0.00');
});

test('OMS amount input rejects rounding, grouping, exponents, non-positive values and unsafe integer overflow',()=>{
  for(const input of ['','0','0.00','-1','+1','1e2','1,000.00','.50','1.','1.234','0.000','１.００','1\n','1 00','90071992547409.92'])assert.throws(()=>parseOmsMajorAmount(input,2),{name:'Error'},input);
  assert.throws(()=>parseOmsMajorAmount('1.0',0),/0 位小数/);
  assert.throws(()=>parseOmsMajorAmount('1.0001',3),/3 位小数/);
  assert.equal(parseOmsMajorAmount('90071992547409.91',2),Number.MAX_SAFE_INTEGER);
  assert.equal(formatOmsMajorAmount(Number.MAX_SAFE_INTEGER,2),'90071992547409.91');
  assert.equal(parseOmsMajorAmount(String(Number.MAX_SAFE_INTEGER),0),Number.MAX_SAFE_INTEGER);
  for(const precision of [-1,1.5,7,NaN])assert.throws(()=>parseOmsMajorAmount('1',precision),/精度/);
  for(const amount of [-1,0.1,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>formatOmsMajorAmount(amount,2),/整数/);
  assert.throws(()=>formatOmsMoney(1,'usd',2),/币种/);
});
