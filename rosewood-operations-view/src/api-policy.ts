const containers=new Set(['rw-mc-wms-operations','rw-mc-oms-operations','rw-mc-pim-reports']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only application-owned document containers may use the generic JSON store.
// The Merchant Center gateway remains responsible for server-side authorization.
export function validateCommerceRequest(path:string,payload?:unknown):void {
  if(typeof path!=='string'||/[\\#\u0000-\u001f]/.test(path)||path.startsWith('/')||path.includes('://'))throw new Error('Unsupported commerce request.');
  const pathname=path.split('?')[0];
  let decoded:string;
  try{decoded=decodeURIComponent(pathname);}catch{throw new Error('Invalid commerce path.');}
  if(decoded.split('/').some(part=>part==='.'||part==='..')||decoded.includes('\\'))throw new Error('Invalid commerce path.');
  if(/^(products|orders|inventory)(\/|$)/.test(pathname))return;
  if(/^channels(\/|$)/.test(pathname)&&payload===undefined)return;
  if(/^product-selections(\/|$)/.test(pathname)&&payload===undefined)return;
  if(payload===undefined&&pathname.startsWith('carts/')){
    const parts=pathname.split('/'),query=new URLSearchParams(path.slice(pathname.length+1));
    // Only the source Cart of an opened order is read by the caller. No Cart
    // listing, arbitrary expansion, mutation or customer lookup is exposed.
    if(parts.length===2&&uuid.test(parts[1])&&[...query].length===1&&query.get('expand')==='lineItems[*].reservation.inventoryEntry.supplyChannel')return;
  }
  if(pathname==='custom-objects'&&payload&&typeof payload==='object'){
    const body=payload as Record<string,unknown>;
    if(typeof body.container==='string'&&containers.has(body.container)&&typeof body.key==='string'&&uuid.test(body.key)&&Number.isSafeInteger(body.version)&&Number(body.version)>=0&&body.value!==undefined)return;
  }
  const parts=pathname.split('/');
  if(payload===undefined&&parts[0]==='custom-objects'&&containers.has(parts[1])&&(parts.length===2||parts.length===3&&uuid.test(parts[2])))return;
  throw new Error('Unsupported commerce resource or operation.');
}
