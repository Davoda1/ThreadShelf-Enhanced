import { createHash, randomUUID } from 'node:crypto';
import { normalizeServerUrl } from './state.mjs';

export const serverIdentity=(serverUrl,item)=>({kind:'threadshelf',serverUrl:normalizeServerUrl(serverUrl),collection:String(item.collection),sourceFile:String(item.sourceFile),conversationKey:String(item.conversationKey??'')});
export const remoteId=(url,item)=>'server:'+createHash('sha256').update(JSON.stringify(serverIdentity(url,item))).digest('hex');
// ThreadShelf 1.2.0 and 1.2.3 share this API contract (validation.ts/routes/search.ts).
// The server returns one bounded ranked set, without a result-count or paging API.
export const SERVER_SEARCH_CAPABILITIES=Object.freeze({
  source:'server',modes:Object.freeze(['titles','keyword','semantic']),maxResults:50,
  resultUnit:'passages',titleResultUnit:'conversations',exhaustive:false,
  keywordMatch:'substring',semanticExecution:'server',localModelRequired:false,
  roles:Object.freeze(['user','ai','thinking']),providerFilter:'client',roleFilter:'server',
});
export function serverSearchLimit(value=SERVER_SEARCH_CAPABILITIES.maxResults){
  const number=Number(value);
  return Number.isFinite(number)?Math.min(50,Math.max(1,Math.trunc(number))):50;
}
function searchRole(value){
  if(value===undefined||value===null||value===''||value==='all')return undefined;
  const role=value==='assistant'?'ai':value;
  if(!SERVER_SEARCH_CAPABILITIES.roles.includes(role))throw new Error('ThreadShelf Server supports User, Assistant, and Thinking role filters.');
  return role;
}
function validIndex(v){if(typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v))v=Number(v);return Number.isSafeInteger(v)&&v>=0?v:undefined;}

// This is the stock /api/insights response, not the Reader search extension.
// Counts are deliberately kept in their original units: activity, models, and
// roles describe indexed passages; provider and thread counts describe turns.
// Do not fill missing data with zero or derive analytics by fetching threads.
function validateInsights(value,collection){
  const invalid=field=>{throw new Error(`ThreadShelf returned invalid Insights data (${field}).`);};
  const object=(v,field)=>{if(!v||typeof v!=='object'||Array.isArray(v))invalid(field);return v;};
  const count=(v,field)=>{if(!Number.isSafeInteger(v)||v<0)invalid(field);return v;};
  const string=(v,field,{empty=true}={})=>{if(typeof v!=='string'||v.length>1_000_000||(!empty&&!v.trim()))invalid(field);return v;};
  const rows=(v,field)=>{if(!Array.isArray(v)||v.length>10000)invalid(field);return v;};
  const timestamp=(v,field)=>{if(v===null)return null;string(v,field,{empty:false});if(!Number.isFinite(Date.parse(v)))invalid(field);return v;};
  const r=object(value,'response'),scope=string(r.collection,'collection',{empty:false});
  if(scope!==collection)invalid('collection does not match the selected scope');
  const totals=object(r.totals,'totals'),result={collection:scope,totals:{}};
  for(const key of ['collections','files','chunks','conversations','turns'])result.totals[key]=count(totals[key],`totals.${key}`);
  // Some older deployments omit role aggregates. Absence is unavailable data,
  // not evidence that those roles have no passages.
  if(r.roles!==undefined&&r.roles!==null){const roles=object(r.roles,'roles');result.roles={};for(const key of ['user','thinking','ai'])result.roles[key]=count(roles[key],`roles.${key}`);}
  const months=new Set();let previousMonth='';
  result.activity=rows(r.activity,'activity').map((row,index)=>{
    const item=object(row,`activity[${index}]`),month=string(item.month,`activity[${index}].month`);
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||months.has(month)||month<previousMonth)invalid(`activity[${index}].month`);
    months.add(month);previousMonth=month;return {month,count:count(item.count,`activity[${index}].count`)};
  });
  result.topModels=rows(r.topModels,'topModels').map((row,index)=>{const item=object(row,`topModels[${index}]`);return {model:string(item.model,`topModels[${index}].model`,{empty:false}),count:count(item.count,`topModels[${index}].count`)};});
  result.providers=rows(r.providers,'providers').map((row,index)=>{const item=object(row,`providers[${index}]`);return {provider:string(item.provider,`providers[${index}].provider`,{empty:false}),conversations:count(item.conversations,`providers[${index}].conversations`),turns:count(item.turns,`providers[${index}].turns`)};});
  result.longestThreads=rows(r.longestThreads,'longestThreads').map((row,index)=>{
    const item=object(row,`longestThreads[${index}]`),thread={};
    for(const key of ['collection','sourceFile','conversationKey','title','provider','lastTurnAt'])thread[key]=string(item[key],`longestThreads[${index}].${key}`,{empty:!['collection','sourceFile'].includes(key)});
    if(collection!=='all'&&thread.collection!==collection)invalid(`longestThreads[${index}].collection does not match the selected scope`);
    thread.turnCount=count(item.turnCount,`longestThreads[${index}].turnCount`);return thread;
  });
  result.firstActivity=timestamp(r.firstActivity,'firstActivity');result.lastActivity=timestamp(r.lastActivity,'lastActivity');
  if((result.firstActivity===null)!==(result.lastActivity===null)||result.firstActivity!==null&&Date.parse(result.firstActivity)>Date.parse(result.lastActivity))invalid('activity date range');
  return result;
}
export class ThreadShelfClient {
  constructor(url,{signal,fetchImpl=fetch}={}){this.url=normalizeServerUrl(url);this.signal=signal;this.fetch=fetchImpl;}
  async get(endpoint,params={},signal=this.signal){
    const url=new URL(endpoint.replace(/^\//,''),this.url);
    for(const [k,v] of Object.entries(params))if(v!==undefined&&v!==null)url.searchParams.set(k,String(v));
    const timeout=AbortSignal.timeout(60000);const combined=signal?AbortSignal.any([signal,timeout]):timeout;
    let response;
    try{response=await this.fetch(url,{headers:{Accept:'application/json'},signal:combined,redirect:'error'});}catch(e){if(signal?.aborted)throw e;throw new Error(`Cannot reach ThreadShelf at ${this.url}: ${e.message}`);}
    const max=128*1024*1024;
    if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new Error('ThreadShelf response is too large.');}
    const reader=response.body?.getReader();const chunks=[];let bytes=0;
    if(reader){while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max){await reader.cancel();throw new Error('ThreadShelf response is too large.');}chunks.push(value);}}
    const text=Buffer.concat(chunks).toString('utf8');let body;
    try{body=JSON.parse(text);}catch{throw Object.assign(new Error(`ThreadShelf returned an invalid JSON response (${response.status}). Check the server address.`),{status:response.status});}
    if(!response.ok)throw Object.assign(new Error(body.error||`ThreadShelf request failed (${response.status}).`),{status:response.status});
    return body;
  }
  async health(){const r=await this.get('api/health');if(r.ok!==true)throw new Error('The address did not return a healthy ThreadShelf API.');return r;}
  async insights(collection='all'){
    if(typeof collection!=='string'||!collection.trim()||collection.length>1024)throw new Error('Choose a valid ThreadShelf collection for Insights.');
    this.signal?.throwIfAborted();let response;
    try{response=await this.get('api/insights',{collection});}
    catch(error){if(error.status===404)throw Object.assign(new Error('This ThreadShelf server does not provide Insights (/api/insights).'),{status:404});throw error;}
    this.signal?.throwIfAborted();return validateInsights(response,collection);
  }
  async allFiles(collection='all'){
    const r=await this.get('api/files',{collection});if(!Array.isArray(r.files))throw new Error('ThreadShelf returned an invalid conversation list.');
    return r.files.filter(f=>f&&typeof f.sourceFile==='string'&&typeof f.collection==='string'&&(collection==='all'||f.collection===collection)).map(f=>({...f,id:remoteId(this.url,f),title:String(f.title||f.conversationKey||f.sourceFile.split(/[\\/]/).pop()),turnCount:Number.isFinite(f.turnCount)?f.turnCount:0}));
  }
  async collections(){
    const [r,files]=await Promise.all([this.get('api/collections'),this.allFiles()]);
    if(!Array.isArray(r.collections))throw new Error('ThreadShelf returned an invalid collection list.');
    const counts=new Map();for(const f of files)if(f.turnCount>0)counts.set(f.collection,(counts.get(f.collection)||0)+1);
    return [...new Set([...r.collections,...counts.keys()])].filter(n=>typeof n==='string'&&counts.get(n)>0).map(name=>({name,count:counts.get(name)})).sort((a,b)=>a.name.localeCompare(b.name));
  }
  async files({collection='all',page=1,pageSize=50,sort='updated',q='',provider}={}){
    let files=await this.allFiles(collection);files=files.filter(f=>f.turnCount>0&&(!provider||provider==='all'||f.provider===provider)&&(!q||f.title.toLocaleLowerCase().includes(q.toLocaleLowerCase())));
    files.sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):sort==='length'?b.turnCount-a.turnCount:(Date.parse(b.lastTurnAt)||0)-(Date.parse(a.lastTurnAt)||0)||a.title.localeCompare(b.title));
    pageSize=Math.max(1,Math.min(500,Math.trunc(Number(pageSize))||50));page=Math.max(1,Math.min(Math.ceil(files.length/pageSize)||1,Math.trunc(Number(page))||1));
    return {files:files.slice((page-1)*pageSize,page*pageSize),total:files.length,page,pageSize};
  }
  async thread(item){
    if(typeof item.collection!=='string'||typeof item.sourceFile!=='string')throw new Error('A server conversation needs its collection and complete source identity.');
    const r=await this.get('api/thread',{collection:item.collection,sourceFile:item.sourceFile,conversationKey:item.conversationKey??''});
    if(!Array.isArray(r.turns))throw new Error('ThreadShelf returned an invalid thread.');
    return {...item,...r,id:remoteId(this.url,item),collection:item.collection,provider:r.provider||item.provider,sourceFile:item.sourceFile,conversationKey:item.conversationKey??r.conversationKey??'',turnCount:r.turns.length,sourceIdentity:serverIdentity(this.url,item)};
  }
  async search({q,collection='all',searchMode='keyword',provider,role,limit=50}){
    if(!['keyword','semantic'].includes(searchMode))throw new Error('ThreadShelf Server supports text and semantic search. Use the conversation filter to search titles.');
    if(typeof q!=='string'||q.length>4000)throw new Error('ThreadShelf search text must contain at most 4000 characters.');
    const mode=searchMode,n=serverSearchLimit(limit),requestedRole=searchRole(role);
    const postFiltered=!!provider&&provider!=='all';
    const searchInfo={source:'server',mode,resultUnit:'passages',limit:n,maxResults:50,exhaustive:false,keywordMatch:'substring',localModelRequired:false,postFiltered};
    const notice=`ThreadShelf returns up to ${n} matching passages (server maximum 50), not an exhaustive total of matching conversations.${postFiltered?' The provider filter is applied to that returned set; it may reduce the displayed matches.':''}`;
    q=q.trim();
    if(!q)return {results:[],total:0,notice,searchInfo:{...searchInfo,serverReturnedPassages:0,returnedPassages:0},capabilities:SERVER_SEARCH_CAPABILITIES};
    // Apply supported role filters on the server before its top-n selection.
    // Never over-fetch for client-side provider filtering: n>50 is rejected.
    const [r,files]=await Promise.all([this.get('api/search',{q,collection,mode,n,roles:requestedRole}),this.allFiles(collection)]);
    if(!Array.isArray(r.results))throw new Error('ThreadShelf returned invalid search results.');
    const byId=new Map(files.map(f=>[f.id,f]));
    const bounded=r.results.slice(0,n);
    const results=bounded.map(hit=>{
      if(!hit||typeof hit!=='object')return null;
      const m=hit.metadata||{};const ident={collection:m.collection||(collection!=='all'?collection:''),sourceFile:m.sourceFile,conversationKey:m.conversationKey??''};
      if(!ident.collection||typeof ident.sourceFile!=='string')return null;
      const id=remoteId(this.url,ident);const summary=byId.get(id)||ident;
      return {...summary,conversationId:id,id,passageId:hit.id===undefined?undefined:`${id}:${String(hit.id)}`,sourceIdentity:serverIdentity(this.url,ident),turnIndex:validIndex(m.turnIndex),role:m.role==='ai'?'assistant':m.role,text:String(hit.document??''),score:Number.isFinite(hit.distance)?undefined:hit.score,title:summary.title||m.title||ident.conversationKey,provider:summary.provider||m.provider,sourceFile:ident.sourceFile,conversationKey:ident.conversationKey,collection:ident.collection,distance:hit.distance};
    }).filter(h=>h&&(!provider||provider==='all'||h.provider===provider)&&(!requestedRole||(h.role==='assistant'?'ai':h.role)===requestedRole)&&(collection==='all'||h.collection===collection));
    return {results,total:results.length,notice,searchInfo:{...searchInfo,serverReturnedPassages:bounded.length,returnedPassages:results.length},capabilities:SERVER_SEARCH_CAPABILITIES};
  }
}

// The stock ThreadShelf search route has no offset/cursor. Its top-50 response
// must never be treated as a complete result set or repeated to fake paging.
// Text search can read the live conversations without importing them. Meaning
// search needs the optional server extension to retain server-side ranking.
const PAGE_CACHE_SIZE=8, SESSION_CACHE_SIZE=4, SESSION_TTL=15*60*1000;
function pageNumber(value,fallback=1,max=Number.MAX_SAFE_INTEGER){const n=Number(value);return Number.isSafeInteger(n)&&n>=1?Math.min(n,max):fallback;}
function abort(client){client.signal?.throwIfAborted();}
function textParts(turn){
  if(!turn||typeof turn!=='object')return [];
  const parts=[];
  for(const [key,role] of [['user','user'],['thinking','thinking'],['ai','ai'],['assistant','ai'],['system','system'],['tool','tool'],['function','tool']]){
    if(typeof turn[key]==='string')parts.push({role,text:turn[key]});
  }
  if(!parts.length&&(typeof turn.text==='string'||typeof turn.content==='string'))parts.push({role:turn.role==='assistant'?'ai':String(turn.role||'unknown'),text:turn.text??turn.content});
  return parts;
}
function excerpt(text,index){const start=Math.max(0,index-120),end=Math.min(text.length,Math.max(index+400,start+800));return (start?'…':'')+text.slice(start,end)+(end<text.length?'…':'');}
function normalizeHit(client,hit,collection,byId){
  if(!hit||typeof hit!=='object')throw new Error('ThreadShelf returned an invalid paged search hit.');
  const m=hit.metadata||{},ident={collection:m.collection||(collection!=='all'?collection:''),sourceFile:m.sourceFile,conversationKey:m.conversationKey??''};
  if(!ident.collection||typeof ident.sourceFile!=='string')throw new Error('ThreadShelf returned a search hit without its source identity.');
  const id=remoteId(client.url,ident),summary=byId.get(id)||ident,text=String(hit.document??'');
  return {...summary,conversationId:id,id,passageId:`${id}:${String(hit.id??`${m.turnIndex}:${m.role}`)}`,sourceIdentity:serverIdentity(client.url,ident),turnIndex:validIndex(m.turnIndex),role:m.role==='ai'?'assistant':m.role,text:excerpt(text,0),score:hit.score,distance:hit.distance,title:summary.title||m.title||ident.conversationKey,provider:summary.provider||m.provider,...ident};
}

export class ServerSearchPager {
  constructor({onProgress=()=>{},now=Date.now}={}){this.sessions=new Map();this.onProgress=onProgress;this.now=now;}
  clear(){this.sessions.clear();}
  async capabilities(client){
    try{
      const r=await client.get('api/reader/capabilities'),c=r.readerSearch;
      if(!c||c.version!==1||c.path!=='/api/reader/search'||c.cursor!==true||!Array.isArray(c.modes)||!c.modes.includes('keyword')||!c.modes.includes('semantic'))throw new Error('The ThreadShelf Reader search extension is incompatible. Update the extension on the server.');
      return {...c,maxPageSize:serverSearchLimit(c.maxPageSize)};
    }catch(error){
      // Express's default unknown-route response is HTML, so get() preserves
      // status even when JSON parsing fails. Connection/auth/server failures
      // remain errors; they are never reinterpreted as missing capability.
      if(error.status===404)return null;
      throw error;
    }
  }
  async search(client,args={}){
    const {q,collection='all',searchMode='keyword',provider,role}=args;
    if(!['keyword','semantic'].includes(searchMode))throw new Error('ThreadShelf Server supports text and semantic search.');
    if(typeof q!=='string'||q.length>4000)throw new Error('ThreadShelf search text must contain at most 4000 characters.');
    const requestedRole=searchRole(role),pageSize=pageNumber(args.pageSize,50,500),requestedPage=pageNumber(args.page),query=q.trim();
    const key=JSON.stringify([client.url,query,collection,searchMode,provider||'',requestedRole||'',pageSize]);
    abort(client);
    for(const [id,s] of this.sessions)if(!s.busy&&this.now()-s.touched>SESSION_TTL)this.sessions.delete(id);
    let session=args.searchSession?this.sessions.get(args.searchSession):null;
    if(session&&session.key!==key)throw new Error('The server search changed. Start again from the first page.');
    let restarted=false,page=requestedPage;
    if(!session){
      if(requestedPage!==1){page=1;restarted=true;}
      const capability=await this.capabilities(client);abort(client);
      while(this.sessions.size>=SESSION_CACHE_SIZE){
        const candidate=[...this.sessions].filter(([,s])=>!s.busy).sort((a,b)=>a[1].touched-b[1].touched)[0];
        if(!candidate)throw new Error('Several server searches are still running. Cancel them or retry shortly.');
        this.sessions.delete(candidate[0]);
      }
      session={id:randomUUID(),key,query,collection,mode:searchMode,provider:provider&&provider!=='all'?provider:undefined,role:requestedRole,pageSize,capability,kind:capability?'server-paged':searchMode==='keyword'?'live-text':'server-ranked',pages:new Map(),nextPage:1,cursor:{file:0,turn:0,part:0},thread:null,total:0,totalKnown:false,touched:this.now(),busy:0,queue:Promise.resolve()};
      this.sessions.set(session.id,session);
    }
    session.touched=this.now();session.busy++;
    const previous=session.queue;
    let release;session.queue=new Promise(resolve=>{release=resolve;});
    try{
      await previous;abort(client);
      if(session.totalKnown)page=Math.min(page,Math.max(1,Math.ceil(session.total/pageSize)));
      let result=session.pages.get(page);
      if(!result){
        if(!query)result={results:[],total:0,totalKnown:true,hasMore:false,page:1};
        else if(session.kind==='server-ranked')result=await this.rankedPage(client,session,page);
        else if(session.kind==='server-paged')result=await this.extensionPage(client,session,page);
        else result=await this.livePage(client,session,page);
      }
      abort(client);
      return {...result,pageSize,searchSession:session.id,sessionRestarted:restarted,total:session.totalKnown?session.total:result.total,totalKnown:session.totalKnown||result.totalKnown,searchInfo:{source:'server',mode:searchMode,engine:session.kind,resultUnit:session.kind==='live-text'?'messages':'passages',exhaustive:session.kind!=='server-ranked'&&(session.totalKnown||result.totalKnown),localModelRequired:false,paginationRequiresUpdate:session.kind==='server-ranked',limit:session.kind==='server-ranked'?50:undefined}};
    }finally{session.busy--;session.touched=this.now();release();}
  }
  remember(session,result){
    session.pages.delete(result.page);session.pages.set(result.page,result);
    while(session.pages.size>PAGE_CACHE_SIZE)session.pages.delete(session.pages.keys().next().value);
    if(result.totalKnown){session.total=result.total;session.totalKnown=true;}
    else session.total=Math.max(session.total,result.total);
    return result;
  }
  async loadFiles(client,session){
    if(!session.files){session.files=(await client.allFiles(session.collection)).filter(f=>f.turnCount>0&&(!session.provider||!f.provider||f.provider===session.provider));abort(client);session.byId=new Map(session.files.map(f=>[f.id,f]));}
  }
  async rankedPage(client,session,page){
    if(!session.ranked){const r=await client.search({q:session.query,collection:session.collection,searchMode:'semantic',provider:session.provider,role:session.role,limit:50});abort(client);session.ranked=r.results.map(hit=>({...hit,text:excerpt(hit.text||'',0)}));}
    const total=session.ranked.length,lastPage=Math.max(1,Math.ceil(total/session.pageSize));page=Math.min(page,lastPage);
    // This total is exact only for the returned ranked subset. searchInfo
    // explicitly marks it non-exhaustive and requiring a server update.
    return this.remember(session,{results:session.ranked.slice((page-1)*session.pageSize,page*session.pageSize),page,total,totalKnown:true,hasMore:page*session.pageSize<total});
  }
  async nextLiveHit(client,session){
    const c=session.cursor,needle=session.query.toLowerCase();
    while(c.file<session.files.length){
      abort(client);const summary=session.files[c.file];
      if(session.thread?.file!==c.file){
        this.onProgress({phase:'server-search',current:c.file,total:session.files.length,message:`Searching live server conversations: ${c.file+1} / ${session.files.length}`});
        const thread=await client.thread(summary);abort(client);session.thread={file:c.file,thread};
      }
      const thread=session.thread.thread;
      if(session.provider&&(thread.provider||summary.provider)!==session.provider){c.file++;c.turn=0;c.part=0;continue;}
      while(c.turn<thread.turns.length){
        abort(client);const turn=thread.turns[c.turn],parts=textParts(turn);
        while(c.part<parts.length){
          const partIndex=c.part++,part=parts[partIndex];if(session.role&&part.role!==session.role)continue;
          const index=part.text.toLowerCase().indexOf(needle);if(index<0)continue;
          const turnIndex=validIndex(turn.turn_index)??c.turn,id=summary.id;
          return {...summary,conversationId:id,id,passageId:`${id}:live:${c.turn}:${partIndex}`,sourceIdentity:serverIdentity(client.url,summary),turnIndex,role:part.role==='ai'?'assistant':part.role,text:excerpt(part.text,index),provider:thread.provider||summary.provider,title:thread.title||summary.title};
        }
        c.turn++;c.part=0;
      }
      c.file++;c.turn=0;c.part=0;session.thread=null;
    }
    return null;
  }
  async livePage(client,session,page){
    await this.loadFiles(client,session);
    if(page!==session.nextPage){session.cursor={file:0,turn:0,part:0};session.thread=null;session.nextPage=1;session.pages.clear();session.totalKnown=false;session.total=0;}
    let result;
    while(session.nextPage<=page){
      const currentPage=session.nextPage,start={...session.cursor},results=[];
      try{
        while(results.length<session.pageSize){const hit=await this.nextLiveHit(client,session);if(!hit)break;results.push(hit);}
        const beforeLookahead={...session.cursor};const next=results.length===session.pageSize?await this.nextLiveHit(client,session):null;
        // The lookahead is not delivered yet. Always rewind it, including at
        // file boundaries; cancelling or retrying must never skip that hit.
        session.cursor=beforeLookahead;abort(client);
        const hasMore=!!next,total=(currentPage-1)*session.pageSize+results.length+(hasMore?1:0);
        result=this.remember(session,{results,page:currentPage,total,totalKnown:!hasMore,hasMore});session.nextPage++;
        if(!hasMore)break;
      }catch(error){session.cursor=start;session.nextPage=currentPage;throw error;}
    }
    return result;
  }
  async extensionPage(client,session,page){
    await this.loadFiles(client,session);
    if(page!==session.nextPage){session.remoteCursor=undefined;session.nextPage=1;session.pages.clear();session.totalKnown=false;}
    let result;
    while(session.nextPage<=page){
      const currentPage=session.nextPage,start=session.remoteCursor,results=[];let response;
      try{
        do{
          const n=Math.min(session.capability.maxPageSize,session.pageSize-results.length);
          response=await client.get('api/reader/search',{q:session.query,collection:session.collection,mode:session.mode,n,roles:session.role,provider:session.provider,cursor:session.remoteCursor});abort(client);
          if(!Array.isArray(response.results)||!Number.isSafeInteger(response.total)||response.total<0||typeof response.hasMore!=='boolean'||(response.hasMore&&(typeof response.nextCursor!=='string'||!response.nextCursor||response.nextCursor===session.remoteCursor)))throw new Error('ThreadShelf returned an invalid paged search response.');
          if(response.results.length>n||response.hasMore&&!response.results.length)throw new Error('ThreadShelf returned an invalid paged search size.');
          const seen=(currentPage-1)*session.pageSize+results.length+response.results.length;
          if(response.total<seen||response.hasMore!==(seen<response.total))throw new Error('ThreadShelf returned an inconsistent paged search total.');
          for(const hit of response.results){const mapped=normalizeHit(client,hit,session.collection,session.byId);if((session.collection!=='all'&&mapped.collection!==session.collection)||(session.provider&&mapped.provider!==session.provider)||(session.role&&(mapped.role==='assistant'?'ai':mapped.role)!==session.role))throw new Error('The ThreadShelf search extension returned results outside the selected filters.');results.push(mapped);}
          session.remoteCursor=response.nextCursor||undefined;
        }while(response.hasMore&&results.length<session.pageSize);
        result=this.remember(session,{results,page:currentPage,total:response.total,totalKnown:true,hasMore:response.hasMore});session.nextPage++;
        if(!response.hasMore)break;
      }catch(error){session.remoteCursor=start;session.nextPage=currentPage;if(error.status===410){this.sessions.delete(session.id);throw new Error('This server search expired. Search again from the first page.');}throw error;}
    }
    return result;
  }
}
