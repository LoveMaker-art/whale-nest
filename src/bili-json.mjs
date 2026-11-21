/** Keep platform IDs exact before IEEE-754 rounding can lose their digits. */
export function parseBiliJson(text){return JSON.parse(text,(_key,value,context)=>typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)?context?.source??String(value):value);}
