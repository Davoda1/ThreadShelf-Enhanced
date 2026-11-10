// Synthetic provider archive regressions. No saved messages, remote requests or actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRichMarkdown} from '../client/src/enhanced-renderer/rich-parser.js';
import {grokAt, grokFenceAt, collectGrokCards, createGrokContextResolver, grokChartConfig, GROK_LIMITS} from '../client/src/enhanced-renderer/grok-renderer.js';
import {createRichContextResolver, referencesFor} from '../client/src/enhanced-renderer/rich-context.js';
const sample='<grok:render card_id="93cdac" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">0</argument></grok:render>';
const grokRecords=source=>[...prepareRichMarkdown(source).records.values()].filter(n=>n.kind==='grok');
test('exact reported Grok XML becomes an inline reference with preserved IDs and markup',()=>{
 const [node]=grokRecords('Before '+sample+' after.');assert.equal(node.family,'citation_card');assert.deepEqual(node.ids,['93cdac']);assert.equal(node.args.citation_id,'0');assert.equal(node.source,sample);assert.equal(node.inline,true);
});
test('raw tags, URI-encoded DOM forms, groups and citation link targets normalize consistently',()=>{
 const cases=[['<grok-card data-id="id%20a" data-type="image_card" data-plain-type="render_searched_image" data-arg-caption="Hello%20world"></grok-card>','image_card','id a'],['<grok type="render_card" id="opaque" />','','opaque'],['<grok:richcontent type="finance_card" id="stock"></grok:richcontent>','finance_card','stock'],['<grok-card-list data-id="a%2Cb" data-type="citation_card_list"></grok-card-list>','citation_card_list','a'],['[](grok_render_citation_card_json={"cardIds":["a","b"]})','citation_card_list','a']];
 for(const [raw,family,id]of cases){const [node]=grokRecords(raw);assert.ok(node,raw);assert.equal(node.family,family);assert.equal(node.ids[0],id);assert.equal(node.source,raw);}
 assert.equal(grokRecords(cases[0][0])[0].args.caption,'Hello world');
});
test('code examples, escaped markers, unrelated HTML and math remain literal',()=>{
 for(const raw of ['```xml\n'+sample+'\n```','`'+sample+'`','    '+sample+'\n','\\'+sample,'<div>\n'+sample+'\n</div>','[example '+sample+'](https://example.org)','\\('+sample+'\\)','$x '+sample+'$'])assert.equal(grokRecords(raw).length,0,raw);
 const source='Examples:\n\n```xml\n'+sample+'\n```\n\nActual '+sample;
 assert.equal(grokRecords(source).length,1);assert.ok(prepareRichMarkdown(source).content.includes('```xml\n'+sample));
});
test('missing and malformed envelopes retain original source without swallowing later code',()=>{
 const opening='<grok:render card_type="future_card" card_id="unknown">',source=opening+'\n\n```js\nconst preserved=1;\n```\n\n'+sample;
 const found=grokRecords(source);assert.equal(found.length,2);assert.equal(found[0].incomplete,true);assert.equal(found[0].source,opening);assert.ok(prepareRichMarkdown(source).content.includes('const preserved=1;'));
 const bad='<grok:render card_type="image_card" card_id="a" card_id="b"></grok:render>';
 assert.equal(grokRecords(bad)[0].malformed,true);
 const hostile='<grok:render card_type="ui_card" onclick="alert(1)"><argument name="html"><![CDATA[<script>bad()</script>]]></argument></grok:render>';
 assert.equal(grokRecords(hostile)[0].args.html,'<script>bad()</script>');
});
test('metadata resolves exact retained card ID across observed container encodings',()=>{
 for(const key of ['cardAttachment','cardAttachmentsJson','card_attachments_json']){
  const card={id:'93cdac',cardType:'citation_card',url:'https://example.org/source',title:'Actual source'};
  const message={[key]:key==='cardAttachment'?JSON.stringify(card):JSON.stringify([card])},before=JSON.stringify(message);
  assert.equal(collectGrokCards(message)['93cdac'].url,card.url);assert.equal(JSON.stringify(message),before);
 }
 const collision={cardAttachment:[{id:'same',url:'https://example.org/a'},{id:'same',url:'https://example.org/b'}]};assert.equal(collectGrokCards(collision).same,undefined);
 assert.equal(Object.keys(collectGrokCards({cardAttachment:[{url:'https://example.org/no-id'}]})).length,0);
 const getter={id:'danger'};Object.defineProperty(getter,'url',{get(){throw new Error('Getter ran');}});assert.doesNotThrow(()=>collectGrokCards({cardAttachment:getter}));assert.equal(collectGrokCards({cardAttachment:getter}).danger,undefined);
 assert.equal(Object.keys(collectGrokCards({cardAttachment:'{"id":"bad","__proto__":{"x":1}}'})).length,0);
});
test('per-message metadata does not cross-bind duplicate IDs or citation numeric positions',()=>{
 const first={_id:'one',card_attachments_json:JSON.stringify([{id:'93cdac',url:'https://example.org/one'}])},second={response_id:'two',card_attachments_json:JSON.stringify([{id:'93cdac',url:'https://example.org/two'}])},thread={raw:{responses:[{response:first},{response:second}]}};
 const resolve=createRichContextResolver(thread);assert.equal(resolve({source_message_id:'one'}).grokCards['93cdac'].url,'https://example.org/one');assert.equal(resolve({source_message_id:'two'}).grokCards['93cdac'].url,'https://example.org/two');assert.equal(Object.keys(resolve({source_message_id:'missing'}).grokCards||{}).length,0);assert.equal(resolve({source_message_id:'one'}).grokCards['0'],undefined);
 thread.raw.responses.push({response:first});assert.equal(Object.keys(createGrokContextResolver(thread)({source_message_id:'one'}).grokCards).length,0);
});
test('Chart.js finite numeric subset retains semantics; unsupported callbacks, stacks and axes fall back',()=>{
 const cfg={type:'bar',data:{labels:['A','B'],datasets:[{label:'Measured',data:[-2,5],backgroundColor:'#123456'}]},options:{indexAxis:'y',plugins:{title:{display:true,text:'Saved chart'}}}};
 const before=JSON.stringify(cfg),chart=grokChartConfig(cfg);assert.equal(chart.orientation,'horizontal');assert.equal(chart.title,'Saved chart');assert.deepEqual(chart.series[0].values,[-2,5]);assert.equal(JSON.stringify(cfg),before);
 for(const extra of [{type:'radar'},{options:{scales:{y:{type:'logarithmic'}}}},{options:{scales:{y:{stacked:true}}}},{options:{plugins:{tooltip:{callbacks:{label:'evil()'}}}}},{options:{parsing:false}}])assert.equal(grokChartConfig({...cfg,...extra}),null);
 assert.equal(grokChartConfig({...cfg,data:{labels:['A'],datasets:[{data:[NaN]}]}}),null);
 assert.equal(grokChartConfig({...cfg,data:{labels:['A'],datasets:[{data:[1],hidden:true}]}}),null);
 assert.equal(grokChartConfig({type:'scatter',data:{datasets:[{data:[{x:1,y:2,r:3}]}]}}),null);
});
test('data fences require explicit complete language and preserve original code separately',()=>{
 const body='{"type":"line","data":{"labels":["A","B"],"datasets":[{"data":[1,2]}]}}',source='```chartjs\n'+body+'\n```\n';const node=grokFenceAt(source,0,source.length).node;
 assert.equal(node.source,source);assert.equal(node.codeSource,body);assert.equal(node.family,'chart_card');
 const task='~~~xaitask\n{"name":"Saved reminder","prompt":"Do not execute","cadence":"daily"}\n~~~';assert.equal(grokFenceAt(task,0,task.length).node.family,'automation_card');
 for(const raw of ['```js\n'+body+'\n```','```chartjs\nnot json\n```','```chartjs\n'+body])assert.equal(grokFenceAt(raw,0,raw.length),null);
});
test('artifacts and tool records remain passive source with Unicode intact',()=>{
 const artifact='<xaiArtifact artifact_id="a" artifact_version_id="v" title="漢字" contentType="text/html"><script>fetch("https://evil.test")</script><h1>Saved</h1></xaiArtifact>';
 const a=grokRecords(artifact)[0];assert.equal(a.family,'artifact');assert.equal(a.attrs.title,'漢字');assert.equal(a.body,'<script>fetch("https://evil.test")</script><h1>Saved</h1>');
 const tool='<xai:tool_usage_card><xai:tool_name>web_search</xai:tool_name><xai:tool_args><![CDATA[{"query":"saved"}]]></xai:tool_args></xai:tool_usage_card>';assert.equal(grokRecords(tool)[0].family,'tool_usage_card');
});
test('oversized and adversarial shapes are bounded without evaluating input',()=>{
 assert.equal(Object.keys(collectGrokCards({cardAttachment:'x'.repeat(GROK_LIMITS.span+1)})).length,0);
 const cycle={id:'cyclic'};cycle.data=cycle;assert.equal(collectGrokCards({cardAttachment:cycle}).cyclic,undefined);
 assert.equal(grokAt('<grok:render card_type="citation_card" card_id="a" />').node.ids[0],'a');
 assert.equal(grokChartConfig({type:'line',data:{labels:['a'],datasets:[{data:[1]}]},options:{scales:{y:{beginAtZero:true}}}}),null);
});

test('a closing envelope inside literal code cannot consume or destroy that code',()=>{
 for(const literal of ['```xml\n</grok:render>\n```','`</grok:render>`','    </grok:render>\n']) {
  const source='<grok:render card_id="a" card_type="citation_card">\n\n'+literal;
  const result=prepareRichMarkdown(source),found=[...result.records.values()].filter(n=>n.kind==='grok');assert.equal(found.length,1);assert.equal(found[0].incomplete,true);assert.ok(result.content.includes(literal));
 }
});

test('prototype names and hostile array accessors never supply presentation behavior',()=>{
 const result=grokAt('<grok type="constructor" id="x" />');assert.equal(result.node.family,'');
 const array=[];Object.defineProperty(array,'0',{get(){throw new Error('Array getter ran');}});array.length=1;
 assert.doesNotThrow(()=>collectGrokCards({cardAttachment:array}));
 assert.doesNotThrow(()=>createGrokContextResolver({raw:{responses:array}}));
});
import {normalizeChart} from '../client/src/enhanced-renderer/rich-charts.js';
const records=source=>[...prepareRichMarkdown(source).records.values()];

test('native web and file citation tokens preserve exact references and line ranges',()=>{
 const citation='citeturn0search1turn3view2',file='fileciteturn2file0L12-L19';
 const nodes=records('Saved source '+citation+' and '+file+'.');
 assert.equal(nodes.length,2);assert.deepEqual(nodes[0].refs,['turn0search1','turn3view2']);
 assert.deepEqual(nodes[1].refs,['turn2file0']);assert.deepEqual(nodes[1].lines,['L12-L19']);
 assert.equal(nodes[0].source,citation);assert.equal(nodes[1].source,file);
 for(const malformed of ['cite','citebad id','fileciteL12-L19','citeturn0search1'])assert.equal(records(malformed).length,0);
});

test('native tokens and GenUI remain literal in Markdown examples, links, escapes and math',()=>{
 for(const marker of ['citeturn0search0','fileciteturn1file0','genui{"unknown":{"label":"Example"}}']) {
  for(const source of ['`'+marker+'`','```text\n'+marker+'\n```','    '+marker+'\n','[Example '+marker+'](https://example.com)','\\'+marker,'\\('+marker+'\\)'])assert.equal(records(source).length,0,source);
 }
});

test('native entity labels are data; unknown and changed GenUI schemas retain their original source',()=>{
 const entity=records('entity["company","<img onerror=bad>","Saved description"]')[0];
 assert.equal(entity.tag,'Entity');assert.equal(entity.attrs.value,'<img onerror=bad>');
 for(const marker of ['genui{"unknown":{"label":"Example","script":"alert(1)"}}','genui{"chart":{"content":{},"version":9}}','genui{"suggest_automation":{"label":"Example","action":"run"}}','iturn0image0turn0image1','navlistSaved sourcesturn0search0;A saved title','new_future_widget{"title":"Example"}']) {
  const node=records(marker)[0];assert.equal(node.kind,'archived-widget');assert.equal(node.source,marker);
 }
 for(const marker of ['genui{"unknown":{"__proto__":{}}}','genui{"unknown":window.desktop}'])assert.equal(records(marker).length,0);
});

test('explicit metadata identities resolve without positional lookup and unsafe links remain unavailable',()=>{
 const message={id:'m',metadata:{content_references:[
  {type:'grouped_webpages',items:[{url:'https://example.com/a',title:'Source',refs:['turn0search0']}]},
  {type:'file',ref_id:'turn2file0',filename:'Report.pdf'},
  {type:'file',ref_id:'unsafe',filename:'Unsafe.svg',url:'javascript:alert(1)'},
  {type:'file',filename:'No identity.pdf'},
  {type:'webpage',ref_id:'direct',title:'Direct',url:'https://example.com/direct'}
 ]}};
 const thread={raw:{mapping:{n:{message}}}},before=JSON.stringify(thread);
 const refs=createRichContextResolver(thread)({source_node_id:'n',source_message_id:'m'}).references;
 assert.equal(refs.turn0search0.url,'https://example.com/a');assert.equal(refs.turn2file0.filename,'Report.pdf');assert.equal(refs.turn2file0.url,null);
 assert.equal(refs.unsafe.url,null);assert.equal(refs.direct.url,'https://example.com/direct');assert.equal(refs.turn0file0,undefined);
 assert.equal(Object.keys(refs).length,4);assert.equal(JSON.stringify(thread),before);
});

test('native area and doughnut chart adapters use explicit types and retain exact values',()=>{
 const area={chartType:'area',xKey:'label',series:[{dataKey:'value',valueSuffix:' V'}],data:[{label:'A',value:-2.5},{label:'B',value:3.125}]};
 const result=normalizeChart(area);assert.equal(result.ok,true);assert.equal(result.chart.type,'area');assert.deepEqual(result.chart.series[0].values,[-2.5,3.125]);
 const ring={chartType:'doughnut',nameKey:'label',valueKey:'value',series:[{dataKey:'value'}],data:[{label:'A',value:2},{label:'B',value:3}]};
 assert.equal(normalizeChart(ring).ok,true);ring.data[0].value=-1;assert.equal(normalizeChart(ring).ok,false);
 area.stacked=true;assert.equal(normalizeChart(area).ok,false);
});

test('server per-turn metadata resolves only explicit source identities and preserves legacy tuple types', () => {
  const metadata = { content_references: [
    { type: 'grouped_webpages', items: [
      { title: 'Legacy product', url: 'https://example.test/product', refs: [{ turn_index: 4, ref_index: 2, ref_type: 'product' }] },
      { title: 'Source', url: 'https://example.test/source', refs: ['saved-source'] },
    ] },
    { type: 'file', ref_id: 'file-opaque', filename: 'Report.pdf' },
  ] };
  const before = JSON.stringify(metadata);
  const context = referencesFor({ metadata });
  assert.equal(context.references.turn4product2.url, 'https://example.test/product');
  assert.equal(context.references['saved-source'].url, 'https://example.test/source');
  assert.equal(context.references['file-opaque'].filename, 'Report.pdf');
  assert.equal(context.references.turn0search0, undefined);
  assert.equal(JSON.stringify(metadata), before);
  assert.equal(referencesFor({ metadata: {} }).references['saved-source'], undefined);
});

test('server citation metadata collisions and unsafe URLs cannot gain navigation authority', () => {
  const metadata = { content_references: [
    { type: 'webpage', ref_id: 'same', url: 'https://example.test/a' },
    { type: 'webpage', ref_id: 'same', url: 'https://example.test/b' },
    { type: 'webpage', ref_id: '__proto__', url: 'https://example.test/proto' },
    { type: 'webpage', ref_id: 'script', url: 'javascript:alert(1)' },
    { type: 'webpage', ref_id: 'credential', url: 'https://username:password@example.test' },
    { type: 'webpage', ref_id: 'controls', url: 'https://example.test/\u0000x' },
  ] };
  const refs = referencesFor({ metadata }).references;
  for (const id of ['same', '__proto__', 'script', 'credential', 'controls']) assert.equal(Object.hasOwn(refs, id), false);
  let getterRan = false;
  const hostile = {};
  Object.defineProperty(hostile, 'content_references', { get() { getterRan = true; return metadata.content_references; } });
  assert.equal(Object.keys(referencesFor({ metadata: hostile }).references).length, 0);
  assert.equal(getterRan, false);
});

test('server retained metadata supports Grok cards without source-thread reconstruction', () => {
  const card = { id: 'card-local', cardType: 'citation_card', url: 'https://example.test/exact' };
  const metadata = { cardAttachmentsJson: JSON.stringify([card]) };
  const before = JSON.stringify(metadata);
  assert.equal(collectGrokCards({ metadata })['card-local'].url, card.url);
  assert.equal(JSON.stringify(metadata), before);
  assert.equal(Object.keys(collectGrokCards({ metadata: {} })).length, 0);
});

test('previous server legacy marker families retain their established presentations', () => {
  for (const family of ['entity_metadata', 'product', 'product_entity']) {
    const [node] = records(`${family}["category","Saved label"]`);
    assert.equal(node.tag, 'Entity', family);
    assert.equal(node.attrs.value, 'Saved label', family);
  }
  const [memory] = records('memciteturn0search2');
  assert.equal(memory.tag, 'Cite');
  assert.deepEqual(memory.attrs.refs, ['turn0search2']);
  for (const family of ['image', 'images', 'imagegroup', 'image_group']) {
    const [node] = records(`${family}{"queries":["Saved query"]}`);
    assert.equal(node.tag, 'AsyncImageGroup', family);
    assert.deepEqual(node.attrs.query, ['Saved query']);
  }
  const [link] = records('urlSaved titlehttps://example.test/saved');
  assert.equal(link.tag, 'Link');
  assert.deepEqual(link.attrs, { title: 'Saved title', url: 'https://example.test/saved' });
});

import { Marked } from 'marked';
import { createFileCitationExtension, parseFileCitation, fileTypeLabel, MAX_FILE_CITATION_LENGTH } from '../client/src/enhanced-renderer/file-citations.js';

test('display-only file references preserve filename spelling and identify compound suffixes', () => {
  const raw = ':codex-file-citation{purpose="output" path="sandbox:/work/árvíz%20日本語.TAR.GZ"}';
  assert.deepEqual(parseFileCitation(raw + ' trailing'), { raw, filename: 'árvíz 日本語.TAR.GZ' });
  assert.equal(fileTypeLabel('archive.TAR.GZ'), 'TAR.GZ');
  assert.equal(fileTypeLabel('types.d.ts'), 'TypeScript Declaration');
  assert.equal(fileTypeLabel('LICENSE'), '');
  assert.equal(fileTypeLabel('.env'), '');
  const html = new Marked({ extensions: [createFileCitationExtension({ style: 'chip' })] }).parse(raw);
  assert.match(html, /ts-file-chip/);
  assert.match(html, /árvíz 日本語.TAR.GZ/);
  assert.doesNotMatch(html, /\bhref=|\bsrc=|\bdownload=|sandbox:/);
});

test('file citations remain literal in code, escaped examples and links', () => {
  const raw = ':codex-file-citation{path="sandbox:/work/report.pdf"}';
  const parser = new Marked({ extensions: [createFileCitationExtension()] });
  for (const source of ['`' + raw + '`', '```text\n' + raw + '\n```', '    ' + raw, '\\' + raw,
    `[${raw}](https://example.test)`, `![${raw}](https://example.test/image.png)`]) {
    assert.doesNotMatch(parser.parse(source), /ts-file-citation/, source);
  }
  assert.equal((parser.parse('`' + raw + '` then ' + raw).match(/ts-file-citation/g) || []).length, 1);
});

test('malformed, oversized and hostile file labels cannot become active markup', () => {
  const parser = new Marked({ extensions: [createFileCitationExtension()] });
  for (const source of [':codex-file-citation{}', ':codex-file-citation{path="a.pdf" path="b.txt"}',
    ':codex-file-citation{path="bad\nname.pdf"}', ':codex-file-citation{path="bad\u202ename.pdf"}',
    ':codex-file-citation{path="sandbox:/folder/"}', ':codex-file-citation{path="' + 'a'.repeat(MAX_FILE_CITATION_LENGTH) + '"}']) {
    assert.equal(parseFileCitation(source), null);
    assert.doesNotMatch(parser.parse(source), /ts-file-citation/);
  }
  const hostile = ':codex-file-citation{path="sandbox:/<img onerror=alert(1)>.txt"}';
  const html = parser.parse(hostile);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;.txt/);
  assert.doesNotMatch(html, /<img\b|<script\b| href=| src=/);
});

test('file-reference extension leaves ordinary Markdown unchanged', () => {
  const options = { gfm: true, breaks: true };
  const base = new Marked(options), enhanced = new Marked({ ...options, extensions: [createFileCitationExtension()] });
  for (const source of ['# Title\n\n**Strong** and *emphasis*', '- [x] Done\n- [ ] Pending',
    '| A | B |\n| --- | --- |\n| 1 | 2 |', '```js\nconst answer = 42;\n```', '[Link](https://example.test/path)']) {
    assert.equal(enhanced.parse(source), base.parse(source));
  }
});

test('per-turn raw Grok payloads bind beside retained metadata without searching other messages', () => {
  const card = { id: 'raw-card', cardType: 'citation_card', url: 'https://example.test/raw-card', title: 'Saved source' };
  const message = {
    raw: { cardAttachment: JSON.stringify(card) },
    metadata: { content_references: [{ type: 'webpage', ref_id: 'chatgpt-ref', url: 'https://example.test/metadata' }] },
  };
  const before = JSON.stringify(message);
  const context = referencesFor(message);
  assert.equal(context.grokCards['raw-card'].url, card.url);
  assert.equal(context.references['chatgpt-ref'].url, 'https://example.test/metadata');
  assert.equal(JSON.stringify(message), before);
  assert.equal(referencesFor({ metadata: message.metadata }).grokCards, undefined);
  const nested = referencesFor({ raw: { metadata: { cardAttachmentsJson: JSON.stringify([card]) } } });
  assert.equal(nested.grokCards['raw-card'].url, card.url);
});

test('conflicting raw and metadata Grok card IDs remain unresolved in either ordering', () => {
  const first = { id: 'conflict', cardType: 'citation_card', url: 'https://example.test/first' };
  const second = { ...first, url: 'https://example.test/second' };
  const survivor = { ...first, id: 'unambiguous' };
  for (const [rawCard, metadataCard] of [[first, second], [second, first]]) {
    const message = { raw: { cardAttachment: [rawCard, survivor] }, metadata: { cardAttachments: [metadataCard] } };
    const before = JSON.stringify(message), context = referencesFor(message);
    assert.equal(Object.hasOwn(context.grokCards, 'conflict'), false);
    assert.equal(context.grokCards.unambiguous.url, survivor.url);
    assert.equal(JSON.stringify(message), before);
  }
  const repeated = referencesFor({ raw: { cardAttachment: first }, metadata: { cardAttachments: [first] } });
  assert.equal(repeated.grokCards.conflict.url, first.url);
});

import { providerLocaleRows } from '../client/src/enhanced-renderer/provider-locale.js';
import { setRendererLocale, tr, readerLocaleCoverage } from '../client/src/enhanced-renderer/locale.js';

test('provider-owned interface labels are complete in every existing non-English locale', () => {
  const languages = ['hu', 'de', 'fr', 'ja', 'ru'];
  assert.ok(Object.keys(providerLocaleRows).length >= 60);
  for (const [source, translations] of Object.entries(providerLocaleRows)) {
    assert.equal(translations.length, languages.length, source);
    assert.ok(readerLocaleCoverage.includes(source), source);
    for (const [index, language] of languages.entries()) {
      assert.equal(typeof translations[index], 'string', `${language}: ${source}`);
      assert.ok(translations[index].trim().length > 0, `${language}: ${source}`);
      setRendererLocale(language);
      assert.equal(tr(source), translations[index], `${language}: ${source}`);
    }
    setRendererLocale('en');
    assert.equal(tr(source), source);
  }
  for (const language of languages) {
    setRendererLocale(language);
    assert.notEqual(tr('Archived Grok content'), 'Archived Grok content', language);
    assert.notEqual(tr('Saved component metadata is unavailable'), 'Saved component metadata is unavailable', language);
    assert.equal(tr('User supplied untranslated passage'), 'User supplied untranslated passage');
  }
  setRendererLocale('unsupported');
  assert.equal(tr('Archived Grok content'), 'Archived Grok content');
  setRendererLocale('en');
});
