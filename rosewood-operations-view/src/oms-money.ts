function precision(fractionDigits:number):void {
  if(!Number.isSafeInteger(fractionDigits)||fractionDigits<0||fractionDigits>6)throw new Error('Invalid currency precision.');
}

/** Convert the operator's decimal string without multiplying a floating-point value. */
export function parseOmsMajorAmount(input:string,fractionDigits:number):number {
  precision(fractionDigits);
  if(typeof input!=='string'||input.length>128||/[\u0000-\u001f\u007f-\u009f]/u.test(input))throw new Error('Invalid requested amount format.');
  const value=input.trim();
  if(!/^\d+(?:\.\d+)?$/.test(value))throw new Error('Enter a major-unit amount using digits and a decimal point only. Negative numbers, grouping separators and scientific notation are not supported.');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>fractionDigits)throw new Error(`This currency supports up to ${fractionDigits} decimal places. Do not round the requested amount.`);
  const digits=(whole+fraction.padEnd(fractionDigits,'0')).replace(/^0+/,'')||'0';
  const maximum=String(Number.MAX_SAFE_INTEGER);
  if(digits==='0')throw new Error('The requested amount must be greater than zero.');
  if(digits.length>maximum.length||(digits.length===maximum.length&&digits>maximum))throw new Error('The requested amount exceeds the safe integer range.');
  return Number(digits);
}

/** Exact decimal display, including zero and the currency's trailing fraction digits. */
export function formatOmsMajorAmount(amount:number,fractionDigits:number):string {
  precision(fractionDigits);
  if(!Number.isSafeInteger(amount)||amount<0)throw new Error('The amount is not a valid integer in minor units.');
  const digits=String(amount).padStart(fractionDigits+1,'0');
  return fractionDigits?`${digits.slice(0,-fractionDigits)}.${digits.slice(-fractionDigits)}`:digits;
}

export function formatOmsMoney(amount:number,currencyCode:string,fractionDigits:number):string {
  if(!/^[A-Z]{3}$/.test(currencyCode))throw new Error('Invalid currency format.');
  return `${currencyCode} ${formatOmsMajorAmount(amount,fractionDigits)}`;
}
