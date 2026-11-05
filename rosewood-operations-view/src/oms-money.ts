function precision(fractionDigits:number):void {
  if(!Number.isSafeInteger(fractionDigits)||fractionDigits<0||fractionDigits>6)throw new Error('币种精度无效，请核对。');
}

/** Convert the operator's decimal string without multiplying a floating-point value. */
export function parseOmsMajorAmount(input:string,fractionDigits:number):number {
  precision(fractionDigits);
  if(typeof input!=='string'||input.length>128||/[\u0000-\u001f\u007f-\u009f]/u.test(input))throw new Error('申请金额格式不正确。');
  const value=input.trim();
  if(!/^\d+(?:\.\d+)?$/.test(value))throw new Error('请输入主币金额，仅使用数字和小数点，不支持负数、分组符或科学计数法。');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>fractionDigits)throw new Error(`此币种最多支持 ${fractionDigits} 位小数，请勿四舍五入申请金额。`);
  const digits=(whole+fraction.padEnd(fractionDigits,'0')).replace(/^0+/,'')||'0';
  const maximum=String(Number.MAX_SAFE_INTEGER);
  if(digits==='0')throw new Error('申请金额必须大于零。');
  if(digits.length>maximum.length||(digits.length===maximum.length&&digits>maximum))throw new Error('申请金额超出安全整数范围。');
  return Number(digits);
}

/** Exact decimal display, including zero and the currency's trailing fraction digits. */
export function formatOmsMajorAmount(amount:number,fractionDigits:number):string {
  precision(fractionDigits);
  if(!Number.isSafeInteger(amount)||amount<0)throw new Error('金额不是有效的最小货币单位整数。');
  const digits=String(amount).padStart(fractionDigits+1,'0');
  return fractionDigits?`${digits.slice(0,-fractionDigits)}.${digits.slice(-fractionDigits)}`:digits;
}

export function formatOmsMoney(amount:number,currencyCode:string,fractionDigits:number):string {
  if(!/^[A-Z]{3}$/.test(currencyCode))throw new Error('币种格式不正确。');
  return `${currencyCode} ${formatOmsMajorAmount(amount,fractionDigits)}`;
}
