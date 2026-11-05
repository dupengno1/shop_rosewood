import React, {useCallback,useEffect,useRef,useState} from 'react';
import LoadingSpinner from '@commercetools-uikit/loading-spinner';
import DataTable from '@commercetools-uikit/data-table';
import Spacings from '@commercetools-uikit/spacings';
import Text from '@commercetools-uikit/text';
import TextField from '@commercetools-uikit/text-field';
import SelectField from '@commercetools-uikit/select-field';
import PrimaryButton from '@commercetools-uikit/primary-button';
import SecondaryButton from '@commercetools-uikit/secondary-button';
import {ContentNotification} from '@commercetools-uikit/notifications';
import {useCommerceApi,localized,type Inventory} from './api';
import {errorMessage} from './domain';
import {readInventoryRows} from './inventory-data';
import {
  INVENTORY_ADJUSTMENT_REASONS, buildInventoryAdjustment, inventoryAdjustmentBlock,
  inventoryAdjustmentReasonLabel, latestInventoryAdjustment, previewInventoryAdjustment,
  type InventoryAdjustmentPreview,
} from './inventory-adjustment';
import {Notice} from './shared';
import {inspectInventoryReceipt} from './inventory-workflow';

type Props = {canManage:boolean} & ({sku:string;entryId?:never}|{entryId:string;sku?:never});

export default function InventoryPanel({sku,entryId,canManage}:Props) {
  const api=useCommerceApi();
  const [rows,setRows]=React.useState<Inventory[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState('');
  const [entry,setEntry]=useState<Inventory>(),[quantity,setQuantity]=useState('');
  const [reason,setReason]=useState(''),[note,setNote]=useState(''),[reference,setReference]=useState('');
  const [preview,setPreview]=useState<InventoryAdjustmentPreview>();
  const [workflowBlocks,setWorkflowBlocks]=useState<Record<string,string>>({});
  const saving=useRef(false);
  const reload=useCallback(async()=>{
    setLoading(true);setError('');setRows([]);setWorkflowBlocks({});setEntry(undefined);setPreview(undefined);
    try {
      const values=await readInventoryRows(api,entryId!==undefined ? {kind:'entry',id:entryId} : {kind:'sku',sku:sku!});
      const blocks:Record<string,string>={};
      await Promise.all(values.map(async value=>{
        if(!value.custom?.fields?.rwWorkflowReceipt&&!value.custom?.fields?.rwWorkflowDocument)return;
        try{const guard=await inspectInventoryReceipt(api,value);if(guard.blocked)blocks[value.id]=guard.message||'此库存有未核对的仓储步骤，请先返回调拨或盘点单核对。';}
        catch{blocks[value.id]='仓储步骤收据未能核对，暂不能手工更正。请刷新或打开相关单据。';}
      }));
      setRows(values);setWorkflowBlocks(blocks);
    } catch(e){setError(errorMessage(e));} finally {setLoading(false);}
  },[api,entryId,sku]);
  useEffect(()=>{void reload();},[reload]);
  async function review(){
    if(!entry||!canManage||loading||busy||(entryId!==undefined&&entry.id!==entryId))return;
    setBusy(true);setPreview(undefined);setError('');
    try{
      const fresh=await api<Inventory>(`inventory/${entry.id}?expand=supplyChannel`);
      const guard=await inspectInventoryReceipt(api,fresh);if(guard.blocked)throw new Error(guard.message||'此库存有未核对的仓储步骤。');
      if(fresh.version!==entry.version||fresh.quantityOnStock!==entry.quantityOnStock)throw new Error('库存已变化，请刷新库存并重新输入更正数量。');
      setPreview(previewInventoryAdjustment(fresh,quantity,{reason,note,reference}));
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function save() {
    if(!entry||!preview||!canManage||saving.current||loading||(entryId!==undefined&&entry.id!==entryId))return;
    saving.current=true;setBusy(true);setError('');setMessage('');
    try {
      const fresh=await api<Inventory>(`inventory/${entry.id}?expand=supplyChannel`);
      const guard=await inspectInventoryReceipt(api,fresh);if(guard.blocked)throw new Error(guard.message||'此库存有未核对的仓储步骤。');
      const update=buildInventoryAdjustment(fresh,preview);
      const updated=await api<Inventory>(`inventory/${entry.id}?expand=supplyChannel`,update);
      setRows(values=>values.map(value=>value.id===updated.id?updated:value));setEntry(undefined);setPreview(undefined);
      setMessage('库存数量与本次调整原因已一起保存。可用量以平台返回值为准。');
    } catch(e){setError(errorMessage(e));setEntry(undefined);setPreview(undefined);await reload();setError(errorMessage(e));}
    finally{saving.current=false;setBusy(false);}
  }
  return <Spacings.Stack scale="m">
    <Notice error={error} message={message}/>
    {entryId!==undefined&&<Text.Detail>当前库存记录 · SKU {rows[0]?.sku || (loading?'正在读取':'未加载')} · {entryId}</Text.Detail>}
    <Text.Detail>在库量为 commercetools 的库存记录，会随订单处理变化，并非仓内实时盘点结果。订单及预留的库存变化可能延迟数秒显示；请先与权威仓库记录核对。</Text.Detail>
    <SecondaryButton label={entryId!==undefined?'刷新当前库存记录':'刷新当前 SKU 库存'} isDisabled={busy||loading} onClick={()=>void reload()}/>
    {loading?<LoadingSpinner/>:rows.length?<DataTable<Inventory> isCondensed rows={rows} columns={[{key:'location',label:'Supply Channel'},{key:'quantity',label:'在库量'},{key:'available',label:'可用量'},{key:'reserved',label:'预留差额'},{key:'edit',label:'操作'}]} itemRenderer={(row,column)=>{
      if(column.key==='location')return row.supplyChannel?.obj?.key || (row.supplyChannel?.obj?.name?localized(row.supplyChannel.obj.name):row.supplyChannel?.id) || '无 Supply Channel';
      if(column.key==='quantity')return row.quantityOnStock;
      if(column.key==='available')return row.availableQuantity;
      if(column.key==='reserved')return row.quantityOnStock>=row.availableQuantity?row.quantityOnStock-row.availableQuantity:'—';
      const block=workflowBlocks[row.id]||inventoryAdjustmentBlock(row);
      return block?<Text.Detail>{block}</Text.Detail>:<SecondaryButton label="更正" isDisabled={!canManage||busy} onClick={()=>{setEntry(row);setQuantity(String(row.quantityOnStock));setReason('');setNote('');setReference('');setPreview(undefined);setError('');setMessage('');}}/>;
    }}/>:!error&&<ContentNotification type="info">此 SKU 没有 InventoryEntry。本面板不将缺失记录解释为零库存，也不自动创建仓库。</ContentNotification>}
    {rows.map(row=>{
      const latest=latestInventoryAdjustment(row);
      return latest&&<details key={row.id}>
        <summary>最近一次调整 · {row.sku} · {row.supplyChannel?.obj?.key || row.supplyChannel?.id || '无 Supply Channel'}</summary>
        <Spacings.Stack scale="s">
          <Text.Detail>登记时间：{latest.at} · 原因：{latest.reason}</Text.Detail>
          <Text.Detail>在库量：{latest.before ?? '—'} → {latest.after ?? '—'}</Text.Detail>
          {latest.note&&<Text.Detail>说明：{latest.note}</Text.Detail>}
          {latest.reference&&<Text.Detail>单据编号：{latest.reference}</Text.Detail>}
          <Text.Detail>此处只保留本面板最近一次登记，不是完整库存审计流水。</Text.Detail>
        </Spacings.Stack>
      </details>;
    })}
    {entry&&<Spacings.Stack scale="m">
      <Text.Detail>{entry.sku} · {entry.supplyChannel?.obj?.key || entry.supplyChannel?.id || '无 Supply Channel'} · 版本 {entry.version}</Text.Detail>
      <TextField title="更正后的在库量" name="quantity" value={quantity} isDisabled={busy} onChange={event=>{setQuantity(event.target.value);setPreview(undefined);}}/>
      <SelectField title="调整原因" name="adjustmentReason" isRequired value={reason} options={[...INVENTORY_ADJUSTMENT_REASONS]} isDisabled={busy} onChange={event=>{setReason(typeof event.target.value==='string'?event.target.value:'');setPreview(undefined);}}/>
      <TextField title={reason==='other'?'调整说明（必填，最多 500 字符）':'调整说明（可选，最多 500 字符）'} name="adjustmentNote" value={note} isDisabled={busy} onChange={event=>{setNote(event.target.value);setPreview(undefined);}}/>
      <TextField title="单据编号（可选，最多 120 字符）" name="adjustmentReference" value={reference} isDisabled={busy} onChange={event=>{setReference(event.target.value);setPreview(undefined);}}/>
      {!preview?<SecondaryButton label="预览差异" isDisabled={!canManage||busy} onClick={()=>void review()}/>:<>
        <ContentNotification type="warning">在库量 {preview.before} → {preview.after}（变化 {preview.delta>=0?'+':''}{preview.delta}）。原因：{inventoryAdjustmentReasonLabel(preview.reason)}。数量与调整记录将按版本 {preview.version} 一起更新。</ContentNotification>
        <Text.Detail>调整说明：{preview.note || '未填写'} · 单据编号：{preview.reference || '未填写'}</Text.Detail>
        <PrimaryButton label={busy?'正在保存…':'确认保存库存更正'} isDisabled={!canManage||busy||preview.delta===0} onClick={()=>void save()}/>
      </>}
      <SecondaryButton label="取消更正" isDisabled={busy} onClick={()=>{setEntry(undefined);setPreview(undefined);}}/>
    </Spacings.Stack>}
  </Spacings.Stack>;
}
