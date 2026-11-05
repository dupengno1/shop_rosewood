import {createOperation,readOperation,OperationWriteError,type OperationApi,type OperationDocument} from './operation-store';
import {MAX_QUALITY_SCAN,type QualityScan} from './quality-scan';
import {isResourceId} from './list-queries';

export const QUALITY_REPORT_CONTAINER='rw-mc-pim-reports';
export type QualityReport={schemaVersion:1;ruleVersion:'catalog-basic-v1';recordedAt:string;snapshot:QualityScan};
export type QualityReportDocument=OperationDocument<QualityReport>;
export type ReportMarkerStore=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

export function validQualitySnapshot(value:QualityScan):boolean{
  if(!value||!Number.isSafeInteger(value.checked)||value.checked<0||value.checked>MAX_QUALITY_SCAN||!Array.isArray(value.rows)||value.checked!==value.rows.length||typeof value.complete!=='boolean'||typeof value.limited!=='boolean'||value.complete&&value.limited)return false;
  const seen=new Set<string>();
  return value.rows.every(row=>{
    if(!row||!isResourceId(row.id)||seen.has(row.id.toLowerCase())||typeof row.name!=='string'||!Array.isArray(row.skus)||!row.skus.every(sku=>typeof sku==='string')||typeof row.published!=='boolean'||typeof row.hasStagedChanges!=='boolean')return false;
    if(![row.variantCount,row.errorCount,row.warningCount].every(number=>Number.isSafeInteger(number)&&number>=0)||row.version!==undefined&&(!Number.isSafeInteger(row.version)||row.version<1))return false;
    seen.add(row.id.toLowerCase());return true;
  });
}
export function validateQualityReport(document:QualityReportDocument):QualityReportDocument{
  const value=document?.value;
  if(document?.container!==QUALITY_REPORT_CONTAINER||!isResourceId(document?.key||'')||!value||value.schemaVersion!==1||value.ruleVersion!=='catalog-basic-v1'||typeof value.recordedAt!=='string'||!Number.isFinite(Date.parse(value.recordedAt))||!validQualitySnapshot(value.snapshot))throw new Error('报告格式不可识别，未载入，也不会解除待核对状态。');
  return document;
}
function markerKey(project:string):string{
  if(!project||project.length>256||/[\u0000-\u001f\u007f]/.test(project))throw new Error('项目上下文无效，不能保存报告。');
  return `rosewood-mc:pending-quality-report:${encodeURIComponent(project)}`;
}
export function pendingQualityReport(store:ReportMarkerStore,project:string):string{
  const key=store.getItem(markerKey(project));
  if(key!==null&&!isResourceId(key))throw new Error('报告恢复标识无效，请联系管理员核对；已暂停新报告保存。');
  return key||'';
}
function begin(store:ReportMarkerStore,project:string,key:string){
  if(!isResourceId(key))throw new Error('报告编号必须是有效 UUID。');
  if(pendingQualityReport(store,project))throw new Error('上次报告保存结果尚未确认，请先回读原报告；不能创建新报告。');
  store.setItem(markerKey(project),key);
  if(pendingQualityReport(store,project)!==key)throw new Error('无法持久保存报告恢复标识，未提交报告。');
}
function complete(store:ReportMarkerStore,project:string,key:string){
  if(pendingQualityReport(store,project)!==key)throw new Error('报告恢复标识已变化，请重新读取核对；不会清除其他操作。');
  store.removeItem(markerKey(project));
  if(pendingQualityReport(store,project))throw new Error('无法清除已核对的恢复标识，请重新读取；已暂停新报告保存。');
}

// Only the UUID is persisted, never report rows, product information or tokens.
// No write retry: unknown outcomes are recovered by reading the original key.
export async function saveQualityReport(api:OperationApi,store:ReportMarkerStore,project:string,snapshot:QualityScan,options:{newKey?:()=>string;now?:()=>string}={}):Promise<QualityReportDocument>{
  if(!snapshot.checked||!validQualitySnapshot(snapshot))throw new Error('当前检查结果无效，请重新检查。');
  const value:QualityReport={schemaVersion:1,ruleVersion:'catalog-basic-v1',recordedAt:(options.now||(()=>new Date().toISOString()))(),snapshot};
  if(new TextEncoder().encode(JSON.stringify(value)).length>2*1024*1024)throw new Error('报告超过本应用 2 MiB 上限，未保存；请缩小检查范围。');
  const key=(options.newKey||(()=>crypto.randomUUID()))();
  begin(store,project,key);
  let saved:QualityReportDocument;
  try{saved=validateQualityReport(await createOperation(api,QUALITY_REPORT_CONTAINER,key,value));}
  catch(error){
    // Only an explicit rejection of this request is known not to have created it.
    // Conflict, timeout, invalid responses and missing GET results stay locked.
    if(error instanceof OperationWriteError&&error.outcome==='rejected')complete(store,project,key);
    throw error;
  }
  complete(store,project,key);
  return saved;
}
export async function readQualityReport(api:OperationApi,key:string):Promise<QualityReportDocument|undefined>{
  if(!isResourceId(key))throw new Error('报告编号必须是有效 UUID。');
  const document=await readOperation<QualityReport>(api,QUALITY_REPORT_CONTAINER,key);
  return document?validateQualityReport(document):undefined;
}
export async function recoverQualityReport(api:OperationApi,store:ReportMarkerStore,project:string):Promise<QualityReportDocument|undefined>{
  const key=pendingQualityReport(store,project);
  if(!key)return undefined;
  const saved=await readQualityReport(api,key);
  if(saved)complete(store,project,key);
  return saved;
}
