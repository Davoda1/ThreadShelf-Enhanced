import {createHash} from 'node:crypto';
export function parseJSON(text) {
  return JSON.parse(Buffer.isBuffer(text) ? text.toString('utf8').replace(/^\uFEFF/,'') : String(text).replace(/^\uFEFF/,''),
    (key,value,context) => typeof value === 'number' && context?.source && /^-?\d+$/.test(context.source) && !Number.isSafeInteger(value) ? BigInt(context.source) : value);
}
export function stringifyJSON(value, space=2) {
  return JSON.stringify(value,(_,v)=>typeof v==='bigint'?JSON.rawJSON(v.toString()):v,space);
}
export function pythonJSON(value) {
  if(value===null) return 'null';
  if(Array.isArray(value)) return '['+value.map(pythonJSON).join(', ')+']';
  if(typeof value==='object') return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+pythonJSON(v)).join(', ')+'}';
  if(typeof value==='bigint') return value.toString();
  return JSON.stringify(value);
}
export function sha256(value) {return createHash('sha256').update(value).digest('hex');}
export function utcNow() {return new Date().toISOString().replace(/\.\d{3}Z$/,'Z');}
export function safeName(value) {return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,160)||'export';}
/** Display-only date normalization. Never changes the archival source or IDs. */
export function creationTimeMs(value) {
  if (typeof value === 'string') {
    value = value.trim();
    if (!value) return null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) value = Number(value);
    else {
      const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(value);
      if (!parts) return null;
      const day = Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
      if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== parts[0].slice(0, 10)) return null;
      // The existing importers interpret an ISO timestamp without a zone as UTC.
      if (value.length > 10 && !/Z$|[+-]\d{2}(?::?\d{2})?$/i.test(value)) value += 'Z';
      const result = Date.parse(value);
      return Number.isFinite(result) ? result : null;
    }
  }
  if (!['number', 'bigint'].includes(typeof value)) return null;
  const number = Number(value), result = Math.trunc(Math.abs(number) < 10000000000 ? number * 1000 : number);
  return Number.isFinite(result) && Math.abs(result) <= 8640000000000000 ? result : null;
}
/** Equal dates retain their input order via JavaScript's stable Array.sort. */
export function compareConversationNewest(a, b) {
  const left = Number.isFinite(a.createdAtMs) ? a.createdAtMs : null;
  const right = Number.isFinite(b.createdAtMs) ? b.createdAtMs : null;
  return left === null ? right === null ? 0 : 1 : right === null ? -1 : right - left;
}
export function cleanReasoning(value) {
  let count=0;
  function visit(obj){
    if(!obj||typeof obj!=='object')return;
    for(const key of Object.keys(obj)){
      if(typeof obj[key]==='string'){
        const at=obj[key].indexOf('\n\n__ENCRYPTED_REASONING__');
        if(at>=0){obj[key]=obj[key].slice(0,at)+'\n';count++;}
      }else visit(obj[key]);
    }
  }
  visit(value);return count;
}
