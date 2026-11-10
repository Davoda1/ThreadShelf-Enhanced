/** Grok archive presentation adapters. No imported markup, URLs, scripts or
 * requests execute. Original source and metadata stay available for inspection.
 * Protocol names follow the November 2026 evidence catalogue, not a universal
 * xAI schema. All limits apply before creating DOM or parsing nested JSON. */
export const GROK_LIMITS = Object.freeze({ message: 2000000, span: 200000, cards: 256, nodes: 12000, depth: 12, string: 200000, fields: 256 });
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TAGS = new Set(['grok:render', 'grok:richcontent', 'grok', 'grok-card', 'grok-card-list', 'grok-generated-images', 'grok-file-card-group', 'xaiArtifact', 'xai:tool_usage_card', 'image-card', 'file-mention']);
const OPERATIONS = Object.freeze({ render_inline_citation:'citation_card', render_searched_image:'image_card', render_generated_image:'generated_image_card', render_edited_image:'generated_image_card', render_file:'rendered_file_card', render_chart:'chart_card', render_visualization:'visualization_card', render_ui:'ui_card', ui:'ui_card' });
const LABELS = Object.freeze({citation_card:'Source', citation_card_list:'Sources', image_card:'Image', images_card:'Images', generated_image_card:'Generated image', generated_video_card:'Video', generated_audio_card:'Audio', media_variant_card:'Media variant', rendered_file_card:'File', chart_card:'Chart', visualization_card:'Visualization', places_card:'Places', weather_card:'Weather', sports_card:'Sports', finance_card:'Market data', x_posts_card:'X posts', x_users_card:'X profiles', mcp_app_card:'Archived app', ui_card:'Archived interface', ask_user_question_card:'Archived question', request_permission_card:'Archived permission request', request_connector_auth_card:'Archived connection request', location_request_card:'Archived location request', checkout_form_card:'Archived checkout form', automation_card:'Archived task', safety_warning:'Saved warning', artifact:'Artifact', tool_usage_card:'Archived tool activity'});
const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value,key) => {
  if ((!plain(value) && !Array.isArray(value)) || BAD_KEYS.has(key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value,key);
  return descriptor && Object.hasOwn(descriptor,'value') ? descriptor.value : undefined;
};
const str = (value,max=4096) => typeof value === 'string' && value.length <= max ? value : '';
const idText = value => (typeof value === 'number' && Number.isSafeInteger(value)) ? String(value) : str(value,512);
function safeUrl(value) {
  // eslint-disable-next-line no-control-regex -- Reject executable or ambiguous archive URLs.
  if (!str(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function snapshot(input) {
  let nodes=0, chars=0; const seen=new Set();
  function copy(value,depth) {
    if (++nodes>GROK_LIMITS.nodes || depth>GROK_LIMITS.depth) throw new Error('Grok data exceeds display limits');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { chars+=value.length; if(value.length>GROK_LIMITS.string || chars>GROK_LIMITS.message) throw new Error('Grok text limit'); return value; }
    if ((!plain(value) && !Array.isArray(value)) || seen.has(value)) throw new Error('Grok data is not literal');
    seen.add(value); const result=Array.isArray(value)?[]:Object.create(null), descriptors=Object.getOwnPropertyDescriptors(value);
    if(Object.getOwnPropertySymbols(value).length) throw new Error('Grok symbol property');
    const keys=Object.keys(descriptors); if(keys.length>GROK_LIMITS.fields+1) throw new Error('Grok field limit');
    for(const key of keys) {
      if(Array.isArray(value)&&key==='length') continue;
      if(BAD_KEYS.has(key)||key.length>256||!Object.hasOwn(descriptors[key],'value')||(Array.isArray(value)&&! /^(0|[1-9][0-9]*)$/.test(key))) throw new Error('Grok unsafe property');
      result[key]=copy(descriptors[key].value,depth+1);
    }
    if(Array.isArray(value)&&(result.length!==value.length||Object.keys(result).length!==value.length)) throw new Error('Grok sparse array');
    seen.delete(value); return result;
  }
  return copy(input,0);
}
function json(value) { if(typeof value!=='string') return value; if(value.length>GROK_LIMITS.span) throw new Error('Grok JSON limit'); return JSON.parse(value); }
function decode(value) { try { return decodeURIComponent(value); } catch { return value; } }
function xmlText(value) {
  const cdata=value.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/); if(cdata) return cdata[1];
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-fA-F]{1,6});/g,match=>{
    const names={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}; if(names[match]) return names[match];
    const n=match[2]==='x'?parseInt(match.slice(3,-1),16):parseInt(match.slice(2,-1),10);
    return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):match;
  });
}
function attributes(text) {
  const result=Object.create(null); let at=0,count=0;
  while(at<text.length) {
    const ws=/^\s+/.exec(text.slice(at)); if(ws)at+=ws[0].length;
    if(at===text.length)break;
    const m=/^([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(text.slice(at));
    if(!m||++count>64||BAD_KEYS.has(m[1])||Object.hasOwn(result,m[1])) throw new Error('Malformed Grok attributes');
    result[m[1]]=xmlText(m[3]); at+=m[0].length;
  }
  return result;
}
function opening(source,start) {
  const head=/^<([A-Za-z][\w:.-]*)(?=[\s/>])/.exec(source.slice(start)); if(!head||!TAGS.has(head[1]))return null;
  let at=start+head[0].length, quote='';
  for(;at<source.length && at-start<=GROK_LIMITS.span;at++) {
    const c=source[at]; if(quote) {if(c===quote)quote='';} else if(c==='"'||c==="'")quote=c; else if(c==='>')break;
  }
  if(source[at]!=='>') return {tag:head[1],end:Math.min(source.length,start+GROK_LIMITS.span),incomplete:true,attrs:Object.create(null)};
  const tail=source.slice(start+head[0].length,at), self=/\/\s*$/.test(tail);
  try { return {tag:head[1],end:at+1,self,attrs:attributes(self?tail.replace(/\/\s*$/,''):tail)}; }
  catch { return {tag:head[1],end:at+1,self,attrs:Object.create(null),malformed:true}; }
}
function argumentValues(body) {
  const args=Object.create(null); let cursor=0,count=0;
  for(const match of body.matchAll(/<argument\s+name\s*=\s*(["'])([\w.-]+)\1\s*>([\s\S]*?)<\/argument\s*>/g)) {
    if(body.slice(cursor,match.index).trim() || ++count>64 || BAD_KEYS.has(match[2]) || Object.hasOwn(args,match[2]))return null;
    const value=xmlText(match[3]); args[match[2]]=value; cursor=match.index+match[0].length;
  }
  return body.slice(cursor).trim()?null:args;
}
function familyFor(tag,attrs) {
  if(tag==='xaiArtifact') return 'artifact'; if(tag==='xai:tool_usage_card')return 'tool_usage_card';
  if(tag==='image-card')return 'image_card'; if(tag==='file-mention')return 'rendered_file_card';
  if(tag==='grok-card-list')return 'citation_card_list'; if(tag==='grok-generated-images')return 'images_card'; if(tag==='grok-file-card-group')return 'rendered_file_card';
  if(tag==='grok:richcontent')return str(attrs.type,128);
  return str(attrs.card_type||decode(attrs['data-type']||''),128)||own(OPERATIONS,str(attrs.type||decode(attrs['data-plain-type']||''),128))||'';
}
function escaped(source,pos) {let n=0;while(pos>0&&source[--pos]==='\\')n++;return n%2===1;}
/** Recognizes one bounded presentation envelope without creating an XML/HTML DOM. */
export function grokAt(source,pos=0,{protectedRanges=[]}={}) {
  if(escaped(source,pos))return null;
  if(source.startsWith('[](grok_render_citation_card_json=',pos)) {
    const start=pos+'[](grok_render_citation_card_json='.length,end=source.indexOf(')',start); if(end<0||end-start>GROK_LIMITS.span)return null;
    try { const payload=snapshot(json(source.slice(start,end))),ids=payload.cardIds;
      if(!Array.isArray(ids)||!ids.length||ids.length>64||ids.some(id=>!str(id,512)))return null;
      return {end:end+1,node:{kind:'grok',family:'citation_card_list',ids,attrs:Object.create(null),args:Object.create(null),source:source.slice(pos,end+1),inline:true}};
    } catch{return null;}
  }
  const open=opening(source,pos);if(!open)return null;
  let end=open.end,body='',incomplete=!!open.incomplete;
  if(!open.self&&!incomplete) {
    const close=`</${open.tag}>`,stop=source.indexOf(close,open.end),nested=source.indexOf(`<${open.tag}`,open.end);
    if(stop>=0&&stop-pos<=GROK_LIMITS.span&&!(nested>=0&&nested<stop)&&!protectedRanges.some(range=>range[0]<=stop&&stop<range[1])) {body=source.slice(open.end,stop);end=stop+close.length;}
    else {end=open.end;body='';incomplete=true;}
  }
  const attrs=open.attrs,family=familyFor(open.tag,attrs),args=argumentValues(body)||Object.create(null);
  for(const [key,value] of Object.entries(attrs))if(key.startsWith('data-arg-')&&!BAD_KEYS.has(key.slice(9)))args[key.slice(9)]=decode(value);
  const id=idText(attrs.card_id||attrs.id||decode(attrs['data-id']||''));
  const ids=family==='citation_card_list'||open.tag==='grok-generated-images'||open.tag==='grok-file-card-group'?id.split(',').map(s=>s.trim()).filter(Boolean).slice(0,64):id?[id]:[];
  return {end,node:{kind:'grok',family,tag:open.tag,ids,attrs,args,body,source:source.slice(pos,end),incomplete,malformed:!!open.malformed,inline:!incomplete&&!open.malformed&&['citation_card','citation_card_list'].includes(family)}};
}
/** Recognize only explicit data-fence languages; other code examples remain
 * untouched. Caller supplies a Markdown code token's exact protected range. */
export function grokFenceAt(source,start,end) {
  const raw=source.slice(start,end);if(raw.length>GROK_LIMITS.span)return null;
  const lines=raw.split(/\r?\n/),open=/^ {0,3}(`{3,}|~{3,})[ \t]*(chartjs|xaitask)[ \t]*$/.exec(lines[0]||'');if(!open)return null;
  let last=lines.length-1;while(last>0&&lines[last]==='')last--;
  const close=/^ {0,3}(`+|~+)[ \t]*$/.exec(lines[last]||'');if(!close||close[1][0]!==open[1][0]||close[1].length<open[1].length||last<2)return null;
  const firstBreak=raw.indexOf('\n')+1,closingOffset=raw.lastIndexOf(lines[last]);
  const body=raw.slice(firstBreak,closingOffset).replace(/\r?\n$/,'');
  let embeddedCard;try {const payload=snapshot(json(body));if(!plain(payload))return null;embeddedCard=open[2]==='chartjs'?{config:payload}:payload;}catch{return null;}
  return {end,node:{kind:'grok',family:open[2]==='chartjs'?'chart_card':'automation_card',ids:[],attrs:Object.create(null),args:Object.create(null),body,source:raw,codeSource:body,embeddedCard,inline:false}};
}
export function prepareGrokMarkdown(content,{protectedRanges=[]}={}) {
  const source=String(content??''),records=new Map();if(source.length>GROK_LIMITS.message)return {content:source,records};
  let out='',last=0,pos=0,index=0;const ranges=[...protectedRanges].sort((a,b)=>a[0]-b[0]);
  while(pos<source.length&&records.size<GROK_LIMITS.cards) {
    while(ranges[index]&&ranges[index][1]<=pos)index++;
    if(ranges[index]&&ranges[index][0]<=pos){pos=ranges[index][1];continue;}
    if(source[pos]!=='<'&&!source.startsWith('[](grok_render_',pos)){pos++;continue;}
    const found=grokAt(source,pos,{protectedRanges:ranges});if(!found){pos++;continue;}
    const words=new Uint32Array(4);if(!globalThis.crypto?.getRandomValues)break;globalThis.crypto.getRandomValues(words);
    const marker=`TSGROK${Array.from(words,n=>n.toString(16).padStart(8,'0')).join('')}END`;
    if(source.includes(marker)||records.has(marker)){pos++;continue;}
    records.set(marker,found.node);out+=source.slice(last,pos)+(found.node.inline?marker:`\n\n${marker}\n\n`);last=pos=found.end;
  }
  return {content:out+source.slice(last),records};
}
/** Explicit card IDs only; conflicting bindings are removed instead of guessed.
 * Container spellings are separate observed transports, not positional sources. */
export function collectGrokCards(message) {
  const cards=Object.create(null),conflicts=new Set();let visited=0,total=0;
  function add(value,depth=0) {
    if(++visited>GROK_LIMITS.cards*4||depth>5)return;
    try {if(typeof value==='string')value=json(value);}catch{return;}
    if(Array.isArray(value)){for(let i=0;i<Math.min(value.length,GROK_LIMITS.cards);i++)add(own(value,String(i)),depth+1);return;}
    if(!plain(value))return;
    const id=idText(own(value,'id')??own(value,'card_id')??own(value,'cardId'));
    if(id&&!BAD_KEYS.has(id)) {
      try {const card=snapshot(value);total+=JSON.stringify(card).length;if(total>GROK_LIMITS.message||conflicts.has(id))return;
        if(cards[id]&&JSON.stringify(cards[id])!==JSON.stringify(card)){delete cards[id];conflicts.add(id);}else cards[id]=Object.freeze(card);
      }catch{/* Malformed/accessor/cyclic metadata is never read or executed. */}
      return;
    }
    // Some observed responses wrap the literal card list under cards.
    const nested=own(value,'cards');if(Array.isArray(nested))add(nested,depth+1);
  }
  for(const root of [message,own(message,'metadata'),own(message,'raw'),own(own(message,'raw'),'metadata')])for(const key of ['cardAttachment','cardAttachmentsJson','card_attachments_json','cardAttachments'])add(own(root,key));
  return Object.freeze(cards);
}
const EMPTY_CONTEXT=Object.freeze({grokCards:Object.freeze(Object.create(null))});
export function createGrokContextResolver(thread) {
  const raw=own(thread,'raw'),responses=own(raw,'responses');
  const messages=new Map(),duplicates=new Set(),cache=new WeakMap();
  if(Array.isArray(responses)&&responses.length<=20000)for(let index=0;index<responses.length;index++) {
    const wrapper=own(responses,String(index)),message=own(wrapper,'response')||wrapper,id=idText(own(message,'id')??own(message,'uuid')??own(message,'_id')??own(message,'response_id')??own(message,'responseId'));
    if(!id||!plain(message))continue;if(messages.has(id))duplicates.add(id);else messages.set(id,message);
  }
  return turn=>{
    // A retained per-turn container is an explicit binding; never search another
    // turn merely because its content, image title or numeric citation matches.
    const local=collectGrokCards(turn);if(Object.keys(local).length)return {grokCards:local};
    const id=idText(own(turn,'source_message_id'));if(!id||duplicates.has(id))return EMPTY_CONTEXT;
    const message=messages.get(id);if(!message)return EMPTY_CONTEXT;
    if(!cache.has(message))cache.set(message,Object.freeze({grokCards:collectGrokCards(message)}));return cache.get(message);
  };
}
const SVG='http://www.w3.org/2000/svg';
const ICONS={source:['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2','M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'],image:['M3 3h18v18H3z','m3 17 6-7 5 6 3-3 4 5','M16 7h.01'],file:['M14 2H5v20h14V7z','M14 2v6h5','M8 12h8M8 16h8'],chart:['M4 3v18h17','M8 17V9M13 17V5M18 17v-6'],activity:['M4 4h16v16H4z','m8 9 3 3-3 3M13 15h4'],info:['M12 8h.01M12 11v6','M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0']};
function el(document,tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;}
function icon(document,name){const s=document.createElementNS(SVG,'svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('aria-hidden','true');s.setAttribute('focusable','false');s.setAttribute('width','18');s.setAttribute('height','18');s.classList.add('rich-icon','grok-icon');for(const d of ICONS[name]||ICONS.info){const p=document.createElementNS(SVG,'path');for(const [k,v] of Object.entries({d,fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round'}))p.setAttribute(k,v);s.append(p);}return s;}
function link(document,url,label){const a=el(document,'a','grok-link',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;}
function inspect(document,source,title='Original markup'){const detail=el(document,'details','grok-source'),summary=el(document,'summary','',title),pre=el(document,'pre'),code=el(document,'code','',source);pre.append(code);detail.append(summary,pre);return detail;}
function cardFor(node,context,id=node.ids?.[0]) {if(node.embeddedCard)return node.embeddedCard;const cards=context?.grokCards;return cards instanceof Map?cards.get(id):own(cards,id);}
function cardData(card) {return own(card,'card')||own(card,'data')||card||Object.create(null);}
function formatValue(value) {return typeof value==='string'?value:JSON.stringify(value,null,2);}
function fields(document,parent,data,exclude=new Set(),depth=0) {
  if(!plain(data)||depth>3)return;const dl=el(document,'dl','grok-fields');let count=0;
  for(const [key,value] of Object.entries(data)) {
    if(exclude.has(key)||['id','card_id','cardId','cardType','card_type'].includes(key)||++count>24)continue;
    if(value===undefined||value===null||key==='html'||key==='document'||key==='config')continue;
    const dt=el(document,'dt','',key.replace(/_/g,' ')),dd=el(document,'dd');
    if(plain(value)&&Object.keys(value).length<=12)fields(document,dd,value,new Set(),depth+1);
    else if(Array.isArray(value)) {const ul=el(document,'ul');for(const item of value.slice(0,24)){const li=el(document,'li');if(plain(item))fields(document,li,item,new Set(),depth+1);else li.textContent=str(formatValue(item),8000)||'[Saved data]';ul.append(li);}dd.append(ul);}
    else dd.textContent=str(formatValue(value),8000)||'[Saved data]';dl.append(dt,dd);
  }
  if(dl.childNodes.length)parent.append(dl);
}
function mediaUrl(family,data,node) {
  if(family==='image_card')return safeUrl(own(own(data,'image'),'original')||own(own(data,'image'),'thumbnail')||own(data,'url')||node.attrs.src);
  if(family==='generated_image_card')return safeUrl(own(own(data,'image_chunk'),'imageUrl')||own(data,'imageUrl')||own(data,'url'));
  if(family==='generated_video_card')return safeUrl(own(own(data,'video_chunk'),'videoUrl')||own(data,'videoUrl')||own(data,'url'));
  return safeUrl(own(data,'url')||own(data,'media_url'));
}
/** Exact image URLs the renderer can display for this bound presentation node.
 * Used by the privileged resource policy; unrelated card/link URLs do not gain
 * image-fetch authority. Unknown, malformed and missing cards authorize none. */
export function grokImageUrls(node,context={}) {
  if(!node||node.kind!=='grok'||node.incomplete||node.malformed)return [];
  const card=cardFor(node,context),data=cardData(card),family=node.family||str(own(card,'cardType')||own(card,'card_type')||own(data,'cardType')||own(data,'card_type'),128);
  if(['image_card','generated_image_card'].includes(family)) {const url=mediaUrl(family,data,node);return url?[url]:[];}
  if(family==='images_card')return [...new Set((node.ids||[]).slice(0,32).flatMap(id=>{const member=cardFor(node,context,id),type=str(own(member,'cardType')||own(member,'card_type'));return ['image_card','generated_image_card'].includes(type)?grokImageUrls({...node,ids:[id],family:type},context):[];}))];
  return [];
}
function markdownImage(url,label){return `![${String(label).replace(/[\\[\]\r\n]/g,' ')}](<${url.replace(/</g,'%3C').replace(/>/g,'%3E')}>)`;}
/** Translate only Chart.js semantics that the local SVG chart supports. Every
 * unsupported semantic option keeps the source as data; no callback is run. */
export function grokChartConfig(input) {
  try {
    const c=snapshot(json(input));if(c.schema==='threadshelf-chart')return c;
    if(!plain(c)||!['bar','line','pie','doughnut','scatter'].includes(c.type)||Object.keys(c).some(k=>!['type','data','options'].includes(k)))return null;
    const data=c.data;if(!plain(data)||Object.keys(data).some(k=>!['labels','datasets'].includes(k))||!Array.isArray(data.datasets)||!data.datasets.length||data.datasets.length>8)return null;
    const options=c.options||{};if(!plain(options)||Object.keys(options).some(k=>!['responsive','maintainAspectRatio','animation','plugins','indexAxis','scales'].includes(k)))return null;
    if(options.indexAxis!==undefined&&!(c.type==='bar'&&['x','y'].includes(options.indexAxis)))return null;
    const out={schema:'threadshelf-chart',version:1,type:c.type,series:[]};if(options.indexAxis==='y')out.orientation='horizontal';
    const plugins=options.plugins||{};if(!plain(plugins)||Object.keys(plugins).some(k=>!['title','legend','tooltip'].includes(k)))return null;
    if(plugins.title!==undefined){if(!plain(plugins.title)||Object.keys(plugins.title).some(k=>!['display','text','color','font','padding','position','align'].includes(k)))return null;if(plugins.title.display!==false&&typeof plugins.title.text==='string')out.title=plugins.title.text;}
    // Tooltip/legend presentation is local; callbacks and custom plugin data
    // stay unsupported even when represented as strings in an exported object.
    for(const k of ['legend','tooltip'])if(plugins[k]!==undefined&&(!plain(plugins[k])||Object.keys(plugins[k]).some(x=>!['display','enabled','position','align'].includes(x))))return null;
    if(options.scales!==undefined) {
      if(!plain(options.scales)||Object.keys(options.scales).some(k=>!['x','y'].includes(k)))return null;
      for(const [key,axis]of Object.entries(options.scales)){if(!plain(axis)||Object.keys(axis).some(k=>!['min','max','beginAtZero','title','type'].includes(k)))return null;if(axis.beginAtZero===true&&c.type!=='bar')return null;if(axis.type!==undefined&&!['linear','category'].includes(axis.type))return null;if(axis.type==='category'&&(c.type==='scatter'||key==='y'&&out.orientation!=='horizontal'))return null;
        const target=out.orientation==='horizontal'?(key==='x'?'yAxis':'xAxis'):(key+'Axis'),a={};
        if(axis.min!==undefined)a.min=axis.min;if(axis.max!==undefined)a.max=axis.max;
        if(axis.title!==undefined){if(!plain(axis.title)||Object.keys(axis.title).some(k=>!['display','text'].includes(k)))return null;if(axis.title.display!==false&&typeof axis.title.text==='string')a.label=axis.title.text;}
        if(Object.keys(a).length)out[target]=a;
      }
    }
    if(c.type!=='scatter'){if(!Array.isArray(data.labels)||data.labels.length>200||data.labels.some(v=>typeof v!=='string'&&typeof v!=='number'))return null;out.categories=data.labels.map(String);}
    for(const ds of data.datasets){if(!plain(ds)||Object.keys(ds).some(k=>!['label','data','backgroundColor','borderColor','borderWidth','pointRadius','pointBackgroundColor','tension','fill','hidden'].includes(k))||!Array.isArray(ds.data)||ds.hidden===true||ds.fill===true||ds.fill&&ds.fill!==false||ds.tension&&ds.tension!==0)return null;
      const s={};if(ds.label!==undefined){if(typeof ds.label!=='string')return null;s.label=ds.label;}
      if(c.type==='scatter'){if(ds.data.length>1000||ds.data.some(p=>!plain(p)||Object.keys(p).some(k=>!['x','y'].includes(k))||typeof p.x!=='number'||typeof p.y!=='number'||!Number.isFinite(p.x)||!Number.isFinite(p.y)))return null;s.points=ds.data.map(p=>({x:p.x,y:p.y}));}
      else{if(ds.data.length!==out.categories.length||ds.data.some(v=>typeof v!=='number'||!Number.isFinite(v)))return null;s.values=ds.data;}
      out.series.push(s);
    }
    if(['pie','doughnut'].includes(c.type)&&out.series.length!==1)return null;return out;
  }catch{return null;}
}
export function renderGrokNode(node,{document=globalThis.document,t=value=>value,context={},renderMarkdown,renderChart,grokBudget={remaining:GROK_LIMITS.message}}={}) {
  const bound=cardFor(node,context);let card;try{if(bound!==undefined)card=snapshot(bound);}catch{/* Invalid metadata remains unavailable. */}
  const data=cardData(card),savedFamily=str(own(card,'cardType')||own(card,'card_type')||own(data,'cardType')||own(data,'card_type'),128);
  const family=node.family||savedFamily||'unknown',label=t(own(LABELS,family)||'Archived Grok content');
  // Rendering uses a shared message budget, including repeated references to
  // the same large metadata object. Parsing limits alone cannot bound that
  // expansion. The immutable conversation and whole-message Copy stay exact.
  let savedDataText='';if(card&&!node.inline){try{savedDataText=JSON.stringify(snapshot(card),null,2);}catch{savedDataText=t('Metadata exceeds display limits');}}
  const size=(node.source?.length||0)+(node.body?.length||0)+savedDataText.length+JSON.stringify(node.args||{}).length;
  if(size>GROK_LIMITS.span||size*3>grokBudget.remaining) {
    const aside=el(document,'aside','grok-card rich-passive');aside.dataset.grokFamily=family;
    const header=el(document,'div','grok-card-header');header.append(icon(document,'info'),el(document,'strong','',label));aside.append(header,el(document,'p','grok-status',t('Component exceeds display limits. Original message remains available through Copy.')));
    const take=Math.min(4096,Math.max(0,grokBudget.remaining));if(take&&node.source){const source=node.source.slice(0,take);aside.append(inspect(document,source+(source.length<node.source.length?'\n[Display truncated]':''),t('Original markup preview')));grokBudget.remaining-=take;}return aside;
  }
  grokBudget.remaining-=size*3;
  if(node.inline&&['citation_card','citation_card_list'].includes(family)) {
    const span=el(document,'span','rich-citation grok-citation');span.append(icon(document,'source'));
    const ids=node.ids?.length?node.ids:[null];
    for(const id of ids){const binding=cardData(cardFor(node,context,id)),url=safeUrl(own(binding,'url')),title=str(own(binding,'title'));
      const cost=(String(url||'').length+title.length+String(id||'').length+(node.source?.length||0)+256)*3;
      if(cost>grokBudget.remaining){span.append(el(document,'span','grok-status',t('Additional references exceed display limits')));break;}
      grokBudget.remaining-=cost;
      const item=url?link(document,url,new URL(url).hostname.replace(/^www\./,'')):el(document,'span','rich-citation-unresolved',t('Source unavailable'));
      item.title=[title||url||t('Saved source metadata is unavailable'),id&&`card_id: ${id}`,node.args.citation_id!==undefined&&`citation_id: ${node.args.citation_id}`,node.source].filter(Boolean).join('\n');
      item.setAttribute('aria-label',item.title);span.append(item);
    }return span;
  }
  const aside=el(document,'aside','grok-card rich-passive');aside.dataset.grokFamily=family;
  const header=el(document,'div','grok-card-header');header.append(icon(document,/image/.test(family)?'image':family==='chart_card'?'chart':family==='rendered_file_card'||family==='artifact'?'file':/tool|request|task|automation|ui|app|form/.test(family)?'activity':'info'),el(document,'strong','',label));aside.append(header);
  if(node.incomplete||node.malformed)aside.append(el(document,'p','grok-status',t('Incomplete or malformed saved component')));
  else if(family==='artifact') {
    if(node.attrs.title)aside.append(el(document,'div','grok-title',node.attrs.title));
    if(node.attrs.contentType)aside.append(el(document,'div','grok-status',node.attrs.contentType));
    // Artifact HTML and scripts are shown as source. Markdown may be rendered
    // by the existing safe Markdown path; SVG keeps the existing explicit
    // source/preview control through a fenced block.
    const mime=node.attrs.contentType||'';
    if(renderMarkdown&&mime==='text/markdown'){const template=el(document,'template');template.innerHTML=renderMarkdown(node.body);aside.append(template.content);}
    else {const pre=el(document,'pre'),code=el(document,'code','',node.body);if(mime==='image/svg+xml'){pre.setAttribute('data-fence-language','svg');pre.setAttribute('data-language','SVG');}pre.append(code);aside.append(pre);}
  } else if(/^(?:image_card|generated_image_card)$/.test(family)) {
    const url=mediaUrl(family,data,node),description=str(own(data,'caption')||own(own(data,'image'),'title')||node.args.caption||node.attrs.alt)||label;
    if(url&&renderMarkdown){const template=el(document,'template');template.innerHTML=renderMarkdown(markdownImage(url,description));aside.append(template.content);}
    else aside.append(el(document,'p','grok-status',t('Image unavailable in this export')));
    if(description!==label)aside.append(el(document,'div','grok-caption',description));
    const source=safeUrl(own(own(data,'image'),'link'));if(source)aside.append(link(document,source,t('Image source')));
  } else if(['generated_audio_card','generated_video_card','media_variant_card','rendered_file_card'].includes(family)) {
    const url=mediaUrl(family,data,node),name=str(own(data,'file_name')||own(data,'title')||node.args.file_path||node.attrs.path)||label;
    aside.append(url?link(document,url,name):el(document,'p','grok-status',`${name} — ${t('Asset unavailable in this export')}`));
  } else if(family==='chart_card') {
    const config=own(data,'config')??node.args.chartjs_config??node.args.config,normalized=config===undefined?null:grokChartConfig(config);
    if(normalized&&renderChart)aside.append(renderChart(normalized,{document,t,family:'Chart'}));
    else aside.append(el(document,'p','grok-status',t('Chart retained as saved data')));
  } else if(family==='tool_usage_card') {
    const name=/<xai:tool_name>([\s\S]*?)<\/xai:tool_name>/.exec(node.body)?.[1];if(name)aside.append(el(document,'div','',xmlText(name)));
    aside.append(el(document,'p','grok-status',t('Saved tool activity; no tool is run')));
  } else if(family==='images_card'&&node.ids.length) {
    for(const id of node.ids.slice(0,32)){const member=cardFor(node,context,id),f=str(own(member,'cardType')||own(member,'card_type'));if(['image_card','generated_image_card'].includes(f))aside.append(renderGrokNode({...node,ids:[id],family:f,source:'',inline:false},{document,t,context,renderMarkdown,renderChart,grokBudget}));}
    if(aside.childNodes.length===1)aside.append(el(document,'p','grok-status',t('Images unavailable in this export')));
  } else {
    fields(document,aside,data);if(!card)aside.append(el(document,'p','grok-status',t('Saved component metadata is unavailable')));
    if(['visualization_card','ui_card','mcp_app_card'].includes(family))aside.append(el(document,'p','grok-status',t('Interactive content is archived as source')));
  }
  if(node.ids?.length)aside.append(el(document,'div','grok-identity',`ID: ${node.ids.join(', ')}`));
  if(Object.keys(node.args||{}).length)fields(document,aside,node.args);
  if(card)aside.append(inspect(document,savedDataText,t('Saved component data')));
  if(node.source)aside.append(inspect(document,node.codeSource??node.source,t(node.codeSource!==undefined?'Original code':'Original markup')));return aside;
}
