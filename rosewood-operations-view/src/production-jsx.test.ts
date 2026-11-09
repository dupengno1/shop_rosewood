import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {IntlProvider} from 'react-intl';
import type {Order,Product} from './api';

// tsx uses the automatic JSX runtime, but Connect can use Application Kit's
// supported classic runtime. Execute that production output, not tsx's output.
const sourceDirectory=dirname(fileURLToPath(import.meta.url));
const requireFromSource=createRequire(import.meta.url);
const babel=requireFromSource('@babel/core');
function compile(file:string,source=readFileSync(join(sourceDirectory,file),'utf8')){
 const previous=process.env.BABEL_ENV;
 process.env.BABEL_ENV='production';
 try{const production=babel.transformSync(source,{
  filename:join(sourceDirectory,file),babelrc:false,configFile:false,
  presets:[[requireFromSource.resolve('@commercetools-frontend/babel-preset-mc-app'),{runtime:'classic'}]],
 }).code;
 // Module conversion happens after the official preset injects Emotion imports.
 return babel.transformSync(production,{babelrc:false,configFile:false,plugins:[requireFromSource.resolve('@babel/plugin-transform-modules-commonjs')]}).code as string;
 }finally{if(previous===undefined)delete process.env.BABEL_ENV;else process.env.BABEL_ENV=previous;}
}
function load(file:string,source?:string,api:unknown=()=>{throw new Error('Rendering must not call a Commerce API.');}){
 const output=compile(file,source);
 assert.match(output,/@emotion\/react/,'The regression must exercise the official classic JSX/Emotion transform.');
 assert.doesNotMatch(output,/react\/jsx-runtime/);
 const module={exports:{} as Record<string,React.ComponentType<any>>};
 const requireDependency=(name:string)=>name==='./api'
  ? {useCommerceApi:()=>api}
  :requireFromSource(name);
 // No global React is supplied: a missing component import must fail.
 const run=new Script(`(function(require,module,exports){${output}\n})`,{filename:file}).runInNewContext({console,process,window:globalThis.window});
 run(requireDependency,module,module.exports);
 return module.exports;
}
const render=(component:React.ComponentType<any>,props:Record<string,unknown>)=>renderToStaticMarkup(
 React.createElement(IntlProvider,{locale:'en',messages:{}},React.createElement(component,props))
);
const productData={name:{en:'QA product'},masterVariant:{id:1,sku:'QA-SKU'},variants:[]};
const product:Product={id:'QA-PRODUCT',key:'QA',version:1,masterData:{current:productData,staged:productData,published:true,hasStagedChanges:false}};
const order:Order={id:'QA-ORDER',version:1,orderNumber:'QA-ORDER',lineItems:[],customLineItems:[],totalPrice:{centAmount:100,currencyCode:'USD'},paymentState:'Pending'};

test('Product Operations workbench and native product panel render real classic production JSX',()=>{
 const components=load('product-operations.tsx');
 assert.match(render(components.default,{project:'qa-project'}),/Product Operations/);
 assert.match(render(components.ProductOperationsDetail,{product}),/Store &amp; Fulfilment Information/);
});
test('OMS order information renders real classic production JSX without implying paid funds',()=>{
 const components=load('oms-presentation.tsx');
 const html=render(components.OrderInformation,{order});
 assert.match(html,/Order Information/);assert.match(html,/Pending/);assert.match(html,/Not recorded/);
 const simulated=render(components.OrderInformation,{order:{...order,custom:{fields:{rwPaymentMethod:'payme',rwPaymentStatus:'simulated-approved'}}}});
 assert.match(simulated,/PayMe \(simulated selection\)/);assert.match(simulated,/Pending/);
 assert.match(simulated,/not evidence of a payment capture/);assert.doesNotMatch(simulated,/>Paid</);
});
test('production rendering regression rejects the original missing React fragment import',()=>{
 for(const [file,exportName,props] of [
  ['product-operations.tsx','default',{project:'qa-project'}],
  ['oms-presentation.tsx','OrderInformation',{order}],
 ] as const){
  const source=readFileSync(join(sourceDirectory,file),'utf8').replace(/^import React,/, 'import ').replace(/^import React from 'react';\n/, '');
  const component=load(file,source)[exportName];
  assert.throws(()=>render(component,props),/React is not defined/,file);
 }
});
test('production Product Operations loads 544 products in two bounded pages, opens details and returns to the list',async()=>{
 // jsdom is already a locked dependency of official application-config.
 const configRequire=createRequire(requireFromSource.resolve('@commercetools-frontend/application-config'));
 const {JSDOM}=configRequire('jsdom');
 const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.example.invalid'});
 const globals=globalThis as any;
 const previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(name,Object.getOwnPropertyDescriptor(globals,name));Object.defineProperty(globals,name,{value,writable:true,configurable:true});
 }
 const reads:string[]=[];
 const catalog=[product,...Array.from({length:543},(_,index)=>({...product,id:`QA-PRODUCT-${String(index).padStart(4,'0')}`,key:`QA-${index}`}))];
 const inventory={id:'QA-INVENTORY',version:1,sku:'QA-SKU',quantityOnStock:10,availableQuantity:8,supplyChannel:{id:'QA-CHANNEL',obj:{key:'rw-warehouse-asia'}}};
 const api=async(path:string,options?:unknown)=>{
  assert.equal(options,undefined,'The operational product panel must only read.');reads.push(path);
  if(path.startsWith('products?')){
   const query=new URLSearchParams(path.slice('products?'.length)),limit=Number(query.get('limit'));
   assert.ok(limit>0&&limit<=500,'Product requests must stay within the platform page limit.');
   assert.equal(query.get('sort'),'id asc');
   const after=query.get('where');const cursor=after?JSON.parse(after.slice('id > '.length)):'';
   return {results:catalog.filter(row=>row.id>cursor).slice(0,limit)};
  }
  if(path.startsWith('inventory?'))return {results:[inventory]};
  if(path.startsWith('product-selections/key=rosewood-us-catalog/products'))return {results:[{product:{id:product.id}}]};
  if(path.startsWith('product-selections/key=rosewood-hk-catalog/products'))return {results:[]};
  if(path.startsWith(`products/${product.id}/product-selections`))return {results:[{productSelection:{id:'QA-CATALOG',obj:{key:'rosewood-us-catalog'}}}]};
  throw new Error(`Unexpected product-operation request: ${path}`);
 };
 const {createRoot}=requireFromSource('react-dom/client');
 const root=createRoot(dom.window.document.getElementById('root'));
 try{
  const component=load('product-operations.tsx',undefined,api).default;
  await React.act(async()=>{root.render(React.createElement(IntlProvider,{locale:'en',messages:{}},React.createElement(component,{project:'qa-project'})));});
  const text=()=>dom.window.document.body.textContent||'';
  assert.match(text(),/544 matching products/);assert.match(text(),/QA product/);assert.match(text(),/Global Catalog/);
  assert.equal(reads.filter(path=>path.startsWith('products?')).length,2,'544 products should require two complete bounded pages, not six network round trips.');
  const click=async(label:string)=>{const button=Array.from(dom.window.document.querySelectorAll('button')).find((item:any)=>item.textContent?.includes(label)) as HTMLButtonElement|undefined;assert.ok(button,`Missing button: ${label}`);await React.act(async()=>{button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});};
  await click('View operations');
  assert.match(text(),/Store & Fulfilment Information/);assert.match(text(),/Asia Warehouse/);assert.match(text(),/Total Available Inventory: 8/);assert.match(text(),/QA-SKU/);
  await click('Refresh operational information');assert.match(text(),/Total Available Inventory: 8/);
  await click('Back to product operations');assert.match(text(),/544 matching products/);
  await click('Refresh products and stock');assert.match(text(),/QA product/);
  assert.equal(reads.filter(path=>path.startsWith('products?')).length,4,'Refresh must independently reload both complete product pages.');
  assert.ok(reads.length>=10,'Both workbench and detail refresh must read their data.');
 }finally{
  await React.act(async()=>{root.unmount();});dom.window.close();
  for(const [name,descriptor] of previous)if(descriptor)Object.defineProperty(globals,name,descriptor);else delete globals[name];
 }
});
test('all TSX production modules bind React references locally',()=>{
 const files=(directory:string):string[]=>readdirSync(join(sourceDirectory,directory),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(directory,entry.name)):entry.name.endsWith('.tsx')?[join(directory,entry.name)]:[]);
 for(const file of files('')){
  const unbound:string[]=[];
  babel.transformSync(compile(file),{babelrc:false,configFile:false,plugins:[()=>({visitor:{ReferencedIdentifier(path:any){if(path.node.name==='React'&&!path.scope.hasBinding('React'))unbound.push(file);}}})]});
  assert.deepEqual(unbound,[],`Classic JSX runtime is unbound in ${file}`);
 }
});
