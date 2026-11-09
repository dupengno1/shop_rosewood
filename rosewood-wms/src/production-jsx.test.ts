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
function load(file:string,source?:string,api:unknown=()=>{throw new Error('Rendering must not call a Commerce API.');},context:unknown={user:null}){
 const output=compile(file,source);
 assert.match(output,/@emotion\/react/,'The regression must exercise the official classic JSX/Emotion transform.');
 assert.doesNotMatch(output,/react\/jsx-runtime/);
 const module={exports:{} as Record<string,React.ComponentType<any>>};
 const requireDependency=(name:string)=>name==='./api'
  ? {useCommerceApi:()=>api}
  :name==='@commercetools-frontend/application-shell-connectors'?{useApplicationContext:(select:(value:unknown)=>unknown)=>select(context)}:requireFromSource(name);
 // No global React is supplied: a missing component import must fail.
 const run=new Script(`(function(require,module,exports){${output}\n})`,{filename:file}).runInNewContext({console,process,setInterval,clearInterval,crypto:globalThis.crypto,window:globalThis.window});
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
test('production order information labels a digital-only category without claiming delivery execution',()=>{
 const components=load('oms-presentation.tsx');
 const digitalOrder:Order={...order,lineItems:[{id:'gift',name:{en:'Gift'},quantity:1,variant:{sku:'GIFT',attributes:[{name:'rwProductInfo',value:JSON.stringify({kind:'digital'})}]}}]};
 const html=render(components.OrderInformation,{order:digitalOrder});
 assert.match(html,/Digital Delivery \(item classification\)/);assert.doesNotMatch(html,/>Completed<|>Delivered<|>Paid</);
 const mixed=render(components.OrderInformation,{order:{...digitalOrder,lineItems:[...digitalOrder.lineItems,{id:'unknown',name:{en:'Unclassified'},quantity:1,variant:{sku:'UNKNOWN'}}]}});
 assert.doesNotMatch(mixed,/Digital Delivery/);assert.match(mixed,/Not recorded/);
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
  assert.match(text(),/Store & Fulfilment Information/);assert.match(text(),/Asia Warehouse/);assert.match(text(),/Total Available Inventory: 8/);assert.match(text(),/QA-SKU/);assert.match(text(),/Reserved Inventory/);assert.match(text(),/up to 10 seconds/);
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

test('production digital recorder protects permissions, versions and uncertain writes while preserving operator audit',async()=>{
 const configRequire=createRequire(requireFromSource.resolve('@commercetools-frontend/application-config')),{JSDOM}=configRequire('jsdom');
 const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.example.invalid'}),globals=globalThis as any,previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(name,Object.getOwnPropertyDescriptor(globals,name));Object.defineProperty(globals,name,{value,writable:true,configurable:true});
 }
 const id=(n:number)=>`12345678-1234-1234-1234-${String(n).padStart(12,'0')}`;
 let liveOrder:any={id:id(1),version:1,orderState:'Open',totalPrice:{centAmount:100,currencyCode:'USD'},lineItems:[{id:id(2),quantity:1,name:{en:'Digital QA'},variant:{sku:'QA-DIGITAL'},custom:{fields:{rwFulfillmentType:'digital'}}}],customLineItems:[]};
 let document:any,posts=0,loseResponse=false;const requests:string[]=[];
 const api=async(path:string,payload?:any)=>{requests.push(path);if(payload){assert.equal(path,'custom-objects','Digital status must never write Orders, Inventory or Payments.');posts++;assert.equal(payload.version,document?.version||0);document={id:id(20),container:payload.container,key:payload.key,version:(document?.version||0)+1,createdAt:'2026-11-09T08:00:00Z',lastModifiedAt:'2026-11-09T08:00:00Z',value:structuredClone(payload.value)};if(loseResponse){loseResponse=false;throw Error('response lost');}return structuredClone(document);}if(path.startsWith('orders/'))return structuredClone(liveOrder);if(path.startsWith('custom-objects/')){if(!document)throw {statusCode:404};return structuredClone(document);}throw Error('Unexpected API '+path);};
 const context={user:{id:'mc-qa-operator'}},component=load('oms-workflows.tsx',undefined,api,context).default,{createRoot}=requireFromSource('react-dom/client'),root=createRoot(dom.window.document.getElementById('root'));
 const renderApp=async(canManage:boolean,key:string)=>{await React.act(async()=>{root.render(React.createElement(IntlProvider,{locale:'en',messages:{}},React.createElement(component,{key,order:liveOrder,canManage})));});};
 const text=()=>dom.window.document.body.textContent||'';
 const button=(label:string)=>Array.from(dom.window.document.querySelectorAll('button')).find((e:any)=>e.textContent?.includes(label)) as HTMLButtonElement;
 const click=async(label:string)=>{const e=button(label);assert.ok(e,`Missing button ${label}`);assert.equal(e.disabled,false,`${label} disabled`);await React.act(async()=>{e.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});};
 const fill=async(name:string,value:string)=>{const e=dom.window.document.querySelector(`input[name="${name}"]`) as HTMLInputElement;assert.ok(e,name);await React.act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(e,value);e.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});};
 const choose=async(label:string,value:string)=>{const l=Array.from(dom.window.document.querySelectorAll('label')).find((e:any)=>e.textContent?.includes(label)) as HTMLLabelElement;assert.ok(l,label);const input=dom.window.document.getElementById(l.htmlFor) as HTMLInputElement;assert.ok(input,label+' input');await React.act(async()=>{input.focus();input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));});const option=Array.from(dom.window.document.querySelectorAll('[role="option"]')).find((e:any)=>e.textContent===value) as HTMLElement;assert.ok(option,`Missing ${value} option`);await React.act(async()=>{option.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});};
 const preview=async(status:string)=>{await choose('Digital Status to Record',status);await choose('Recording Basis','Simulation / QA (no delivery)');await fill('digital-note','QA operator note; no message sent');await click('Review Digital Status Record');assert.match(text(),/Confirm Operation/);};
 try{
  await renderApp(false,'readonly');assert.equal(button('Review Digital Status Record').disabled,true);assert.equal(posts,0);
  context.user.id='';await renderApp(true,'anonymous');assert.match(text(),/operator identity is unavailable/);assert.equal(button('Review Digital Status Record').disabled,true);
  context.user.id='mc-qa-operator';await renderApp(true,'manager');await preview('Pending');liveOrder={...liveOrder,version:2};await click('Confirm Save');assert.equal(posts,0);assert.match(text(),/changed. Refresh and review again/);
  await click('Refresh Operations / Verify Result');await preview('Pending');await click('Confirm Save');assert.equal(posts,1);assert.equal(document.value.digitalFulfilment[0].recordedBy.userId,'mc-qa-operator');assert.match(text(),/Pending \(simulated record\)/);
  await preview('Completed');loseResponse=true;await click('Confirm Save');assert.equal(posts,2);assert.match(text(),/unconfirmed|no automatic retry/);assert.equal(button('Review Digital Status Record').disabled,true);
  await click('Refresh Operations / Verify Result');assert.equal(posts,2,'Ambiguous write recovery must read exact record, never resubmit.');assert.match(text(),/previous operation was confirmed/);assert.match(text(),/Completed \(simulated record\)/);assert.equal(document.value.digitalFulfilment.length,2);
  assert.equal(dom.window.sessionStorage.length,0);assert.equal(liveOrder.version,2,'Digital records must not change native order state/version.');assert.ok(requests.every(path=>path.startsWith('orders/')||path.startsWith('custom-objects')));
 }finally{await React.act(async()=>{root.unmount();});dom.window.close();for(const [name,descriptor]of previous)if(descriptor)Object.defineProperty(globals,name,descriptor);else delete globals[name];}
});

test('production OMS renders verified Cart reservations and clears old balances on an inaccessible refresh without writes',async()=>{
 const configRequire=createRequire(requireFromSource.resolve('@commercetools-frontend/application-config')),{JSDOM}=configRequire('jsdom');
 const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.example.invalid'}),globals=globalThis as any,previous=new Map<string,PropertyDescriptor|undefined>();
 for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true})){
  previous.set(name,Object.getOwnPropertyDescriptor(globals,name));Object.defineProperty(globals,name,{value,writable:true,configurable:true});
 }
 const id=(n:number)=>`12345678-1234-1234-1234-${String(n).padStart(12,'0')}`;
 const line={id:id(2),key:'QA-RESERVATION-LINE',quantity:2,name:{en:'Reservation QA'},variant:{sku:'QA-RESERVATION'},supplyChannel:{id:id(3),obj:{key:'rw-warehouse-asia'}}};
 const native:Order={id:id(1),version:1,cart:{typeId:'cart',id:id(4)},totalPrice:{centAmount:200,currencyCode:'USD'},lineItems:[line],customLineItems:[]};
 const cart:any={id:id(4),version:2,cartState:'Ordered',lineItems:[{...line,reservation:{id:id(5),typeId:'reservation',obj:{id:id(5),version:1,quantity:2,state:'Created',expiresAt:'2099-11-09T08:15:00Z',owner:{id:id(4),typeId:'cart'},lineItemId:id(2),inventoryEntry:{id:id(6),typeId:'inventory-entry',obj:{id:id(6),sku:'QA-RESERVATION',supplyChannel:line.supplyChannel}}}}}]};
 let denyCart=false;const paths:string[]=[];
 const api=async(path:string,payload?:unknown)=>{assert.equal(payload,undefined,'Reservation inspection must never write.');paths.push(path);if(path.startsWith('orders/'))return structuredClone(native);if(path.startsWith('custom-objects/'))throw {statusCode:404};if(path.startsWith(`carts/${cart.id}?`)){if(denyCart)throw {statusCode:403};return structuredClone(cart);}throw Error('Unexpected request '+path);};
 const component=load('oms-workflows.tsx',undefined,api,{user:null}).default,{createRoot}=requireFromSource('react-dom/client'),root=createRoot(dom.window.document.getElementById('root'));
 const text=()=>dom.window.document.body.textContent||'';
 const refresh=async()=>{const button=Array.from(dom.window.document.querySelectorAll('button')).find((e:any)=>e.textContent?.includes('Refresh Operations / Verify Result')) as HTMLButtonElement;assert.ok(button);assert.equal(button.disabled,false);await React.act(async()=>{button.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});};
 try{
  await React.act(async()=>{root.render(React.createElement(IntlProvider,{locale:'en',messages:{}},React.createElement(component,{order:native,canManage:false})));});
  assert.match(text(),/Native Quantity: 2 · Active Reserved: 2 · Committed: 0/);assert.match(text(),/Asia Warehouse/);assert.match(text(),new RegExp(cart.id));
  cart.lineItems[0].reservation.obj.expiresAt='2020-01-01T00:00:00Z';await refresh();assert.match(text(),/Expiry processing/);assert.match(text(),/Active Reserved: Unknown/);
  cart.lineItems[0].reservation.obj.state='Committed';await refresh();assert.match(text(),/Native Quantity: 2 · Active Reserved: 0 · Committed: 2/);assert.match(text(),/not an active hold/);
  denyCart=true;await refresh();assert.match(text(),/could not be read/);assert.match(text(),/Native Quantity: Unknown · Active Reserved: Unknown/);assert.doesNotMatch(text(),/Active Reserved: 2/);
  assert.equal(paths.filter(path=>path.startsWith('carts/')).length,4,'One bounded source-Cart GET per refresh.');assert.ok(paths.filter(path=>path.startsWith('carts/')).every(path=>path.endsWith('?expand=lineItems[*].reservation.inventoryEntry.supplyChannel')));
 }finally{await React.act(async()=>{root.unmount();});dom.window.close();for(const [name,descriptor]of previous)if(descriptor)Object.defineProperty(globals,name,descriptor);else delete globals[name];}
});
