/* Synthetic regression tests for model.js. No network access required. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'model.js');
const posted = [];
const listeners = {};

globalThis.window = globalThis;
window.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
window.postMessage = (data) => {
  posted.push(data);
  (listeners.message || []).forEach((fn) => fn({ source: window, data }));
};
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };
globalThis.location = { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' };

let nextBody = '';
let nextType = 'text/event-stream';
let nextHeaders = {};
window.fetch = async () => new Response(nextBody, { headers: { 'content-type': nextType, ...nextHeaders } });

class FakeSocket {
  constructor(url) { this.url = url; this.handlers = []; }
  addEventListener(type, fn) { if (type === 'message') this.handlers.push(fn); }
  emit(data) { this.handlers.forEach((fn) => fn({ data })); }
}
window.WebSocket = FakeSocket;

globalThis.XMLHttpRequest = class {
  constructor() {
    this.handlers = {};
    this.responseText = '';
    this.responseType = '';
    this.response = null;
    this._responseHeaders = {};
  }
  open() {}
  send() {}
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  getResponseHeader(name) { return this._responseHeaders[String(name).toLowerCase()] || ''; }
  getAllResponseHeaders() { return Object.entries(this._responseHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n'); }
  complete() { (this.handlers.loadend || []).forEach((fn) => fn()); }
};
window.XMLHttpRequest = globalThis.XMLHttpRequest;

vm.runInThisContext(fs.readFileSync(SRC, 'utf8'), { filename: SRC });

const sleep = (ms = 220) => new Promise((r) => setTimeout(r, ms));
const latest = () => {
  for (let i = posted.length - 1; i >= 0; i--) if (posted[i]?.snapshot) return posted[i].snapshot;
  return null;
};
const cur = () => latest()?.turns?.[0];
const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const named = (name, obj) => 'event: ' + name + '\ndata: ' + JSON.stringify(obj) + '\n\n';
const DONE = 'data: [DONE]\n\n';

let failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `\n         expected ${e}\n         actual   ${a}`));
}
function ok(label, value) { check(label, !!value, true); }

async function send(body, api = 'f/conversation', headers) {
  return window.fetch('/backend-api/' + api, {
    method: 'POST',
    body: JSON.stringify(body),
    headers
  });
}
function req(model, conv, extra = {}) {
  return {
    model,
    conversation_id: conv,
    messages: [{ id: 'user-' + conv, author: { role: 'user' } }],
    ...extra
  };
}
function ev(pathNeedle) {
  return cur().evidence.find((x) => x.path.includes(pathNeedle));
}

(async () => {
  console.log('\n[1] STE authoritative mismatch => ROUTED');
  nextType = 'text/event-stream'; nextHeaders = {};
  nextBody = sse({
    conversation_id: 'c1',
    message: { id: 'a1', author: { role: 'assistant' }, metadata: { parent_id: 'user-c1', model_slug: 'gpt-5-6-thinking' } }
  }) + named('server_ste_metadata', { model_slug: 'gpt-5-5-mini', requested_model_experience: 'thinking', server_ttfvt_ms: 40 }) + DONE;
  await send(req('gpt-5-6-thinking', 'c1'));
  await sleep();
  check('decision', cur().decision, 'ROUTED');
  check('requested', cur().requested, 'gpt-5-6-thinking');
  check('effective', cur().effective, 'gpt-5-5-mini');
  check('message echo category', ev('message.metadata.model_slug').category, 'requested');
  check('STE category', cur().evidence.find((x) => x.event === 'server_ste_metadata' && x.path.endsWith('model_slug')).category, 'effective');

  console.log('\n[2] snapshot suffix canonicalization => MATCH');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking-2026-09-20' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c2'));
  await sleep();
  check('decision', cur().decision, 'MATCH');
  check('effective canonical', cur().effectiveCanonical, 'gpt-5-6-thinking');

  console.log('\n[3] auxiliary candidate alone never proves route');
  nextBody = sse({ fasterModel: 'gpt-5-6-instant', retry_model: 'gpt-5-5-mini', fallback_model: 'gpt-5-4-mini' }) + DONE;
  await send(req('gpt-5-6-thinking', 'c3'));
  await sleep();
  check('decision', cur().decision, 'SUSPICIOUS');
  check('no effective model', cur().effective, '');
  check('faster category', ev('fasterModel').category, 'auxiliary');
  check('retry category', ev('retry_model').category, 'auxiliary');
  check('fallback category', ev('fallback_model').category, 'auxiliary');

  console.log('\n[4] same-model auxiliary evidence => UNKNOWN');
  nextBody = sse({ fasterModel: 'gpt-5-6-thinking' }) + DONE;
  await send(req('gpt-5-6-thinking', 'c4'));
  await sleep();
  check('decision', cur().decision, 'UNKNOWN');

  console.log('\n[5] response.created/model and response.completed/model are authoritative');
  nextBody = named('response.created', { response: { model: 'gpt-5-6-thinking' } })
    + named('response.completed', { response: { model: 'gpt-5-6-instant' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c5'));
  await sleep();
  check('completed outranks created => routed', cur().decision, 'ROUTED');
  check('decisive effective', cur().effective, 'gpt-5-6-instant');
  ok('both authoritative values retained in raw evidence', cur().evidence.filter((x) => x.category === 'effective' && x.identity).length >= 2);

  console.log('\n[6] completed response mismatch alone => ROUTED');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-instant' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c6'));
  await sleep();
  check('decision', cur().decision, 'ROUTED');
  check('source', ev('response.model').source, 'SSE');

  console.log('\n[7] unknown model field is retained and can make result suspicious');
  nextBody = sse({ routing_debug: { mystery_model: 'gpt-4o', model_experience: 'thinking' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c7'));
  await sleep();
  check('decision', cur().decision, 'SUSPICIOUS');
  check('unknown category', ev('mystery_model').category, 'unknown');
  check('raw value', ev('mystery_model').raw, 'gpt-4o');
  ok('non-identity model metadata retained', ev('model_experience') && ev('model_experience').identity === false);

  console.log('\n[8] nested historical request model is retained but excluded from verdict');
  nextBody = DONE;
  await send(req('gpt-5-6-thinking', 'c8', {
    messages: [
      { id: 'old-a', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-4o' } },
      { id: 'user-c8', author: { role: 'user' } }
    ]
  }));
  await sleep();
  check('decision', cur().decision, 'UNKNOWN');
  const hist = ev('messages[0].metadata.model_slug');
  ok('historical evidence retained', hist);
  check('historical evidence relevant=false', hist.relevant, false);

  console.log('\n[9] JSON response.model is authoritative');
  nextType = 'application/json';
  nextBody = JSON.stringify({ response: { model: 'gpt-5-6-instant' }, created_at: 1 });
  await send(req('gpt-5-6-thinking', 'c9'), 'conversation');
  await sleep();
  check('decision', cur().decision, 'ROUTED');
  check('response source', ev('response.model').source, 'response');

  console.log('\n[10] model-related headers are preserved');
  nextType = 'text/event-stream';
  nextHeaders = { 'x-effective-model': 'gpt-5-6-instant' };
  nextBody = DONE;
  await send(req('gpt-5-6-thinking', 'c10'), 'f/conversation', { 'x-selected-model': 'gpt-5-6-thinking' });
  await sleep();
  check('header authoritative mismatch => routed', cur().decision, 'ROUTED');
  const reqHeader = ev('request.header.x-selected-model');
  const resHeader = ev('response.header.x-effective-model');
  check('request header source', reqHeader.source, 'header');
  check('request header category', reqHeader.category, 'requested');
  check('response header category', resHeader.category, 'effective');

  console.log('\n[11] Work handoff + WebSocket encoded SSE');
  nextHeaders = {};
  nextBody = sse({ type: 'stream_handoff', conversation_id: 'c11', turn_exchange_id: 'tex-11' });
  await send(req('gpt-6-astra-wm', 'c11'));
  await sleep();
  check('handoff remains open', cur().closed, false);
  const ws = new window.WebSocket('wss://ws.chatgpt.com/v1/stream');
  const inner = sse({
    conversation_id: 'c11',
    message: { id: 'a11', author: { role: 'assistant' }, metadata: { turn_exchange_id: 'tex-11', model_slug: 'gpt-6-astra-wm' } }
  }) + named('server_ste_metadata', { model_slug: 'gpt-5-6-instant', requested_model_experience: 'agentic', server_ttfvt_ms: 55 });
  ws.emit(JSON.stringify({ type: 'conversation-turn-stream', data: { encoded_item: Buffer.from(inner, 'utf8').toString('base64') } }));
  await sleep();
  check('websocket STE => routed', cur().decision, 'ROUTED');
  ok('transport retained', cur().transports.includes('WebSocket'));
  ok('SSE source retained', cur().evidence.some((x) => x.source === 'SSE' && x.category === 'effective'));

  console.log('\n[12] JSON patch model path is classified by semantic destination');
  nextBody = sse({ p: '/response/completed/model', o: 'replace', v: 'gpt-5-6-instant' }) + DONE;
  await send(req('gpt-5-6-thinking', 'c12'));
  await sleep();
  check('patch mismatch => routed', cur().decision, 'ROUTED');
  const patch = ev('patch:/response/completed/model');
  check('patch category', patch.category, 'effective');

  console.log('\n[13] equal-rank final evidence conflict => SUSPICIOUS');
  nextBody = named('response.completed', { response: { completed: { model: 'gpt-5-6-instant' }, final: { model: 'gpt-5-5-mini' } } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c13'));
  await sleep();
  check('same authority conflict', cur().decision, 'SUSPICIOUS');

  console.log('\n[14] canonicalization does not merge model families/modes');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking-mini' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c14'));
  await sleep();
  check('mini remains distinct', cur().decision, 'ROUTED');
  check('mini canonical remains distinct', cur().effectiveCanonical, 'gpt-5-6-thinking-mini');

  console.log('\n[15] XHR resume stream contributes evidence to the current turn');
  nextType = 'text/event-stream';
  nextBody = sse({ type: 'stream_handoff', conversation_id: 'c15', turn_exchange_id: 'tex-15' });
  await send(req('gpt-5-6-thinking', 'c15'));
  await sleep();
  const xhr = new window.XMLHttpRequest();
  xhr.open('GET', '/backend-api/f/conversation/c15/stream_status');
  xhr._responseHeaders = { 'content-type': 'text/event-stream', 'x-effective-model': 'gpt-5-6-instant' };
  xhr.responseText = named('response.completed', { response: { model: 'gpt-5-6-instant' } });
  xhr.send();
  xhr.complete();
  await sleep();
  check('XHR resume routes', cur().decision, 'ROUTED');
  ok('XHR/resume evidence retained', cur().transports.includes('stream_status'));
  ok('XHR response header retained', cur().evidence.some((x) => x.path === 'response.header.x-effective-model'));

  console.log('\n[16] noise endpoints do not create turns');
  const before = cur().n;
  nextType = 'application/json'; nextBody = '{"ok":true}';
  await window.fetch('/backend-api/f/conversation/prepare', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o' }) });
  await window.fetch('/backend-api/models');
  await sleep();
  check('current turn unchanged', cur().n, before);

  console.log('\n[17] snapshot only exposes the current turn');
  nextType = 'text/event-stream'; nextBody = DONE;
  for (let i = 0; i < 8; i++) await send(req('gpt-5-6-thinking', 'z' + i));
  await sleep();
  check('one public turn', latest().turns.length, 1);
  check('snapshot schema', latest().v, 3);

  console.log('\n[18] lower authoritative tier disagreeing => SUSPICIOUS (not silently MATCH)');
  nextType = 'text/event-stream'; nextHeaders = {};
  nextBody = named('server_ste_metadata', { model_slug: 'gpt-5-6-thinking', requested_model_experience: 'thinking', server_ttfvt_ms: 1 })
    + named('response.completed', { response: { model: 'gpt-5-5-mini' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c18'));
  await sleep();
  check('cross-tier conflict', cur().decision, 'SUSPICIOUS');
  check('display still from top tier', cur().effective, 'gpt-5-6-thinking');

  console.log('\n[19] MATCH with another model in non-authoritative evidence => matchUncertain');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking' } }) + sse({ some_new_field: { model: 'gpt-5-5-mini' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c19'));
  await sleep();
  check('decision', cur().decision, 'MATCH');
  check('match uncertain', cur().matchUncertain, true);
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c19b'));
  await sleep();
  check('clean match not uncertain', cur().matchUncertain, false);

  console.log('\n[20] model-adjacent keys are shown but never feed the verdict');
  nextBody = sse({ conversation_id: 'c20', model_response_contracts: ['markdown', 'citations_v2'], model_config: { name: 'json_schema' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c20'));
  await sleep();
  check('not suspicious', cur().decision, 'UNKNOWN');
  check('adjacent category', ev('model_response_contracts[0]').category, 'adjacent');
  check('adjacent not identity', ev('model_config.name').identity, false);

  console.log('\n[21] unanchored (approx) evidence never decides');
  nextBody = sse({ type: 'stream_handoff', conversation_id: 'c21', turn_exchange_id: 'tex-21' });
  await send(req('gpt-5-6-thinking', 'c21'));
  await sleep();
  const ws21 = new window.WebSocket('wss://ws.chatgpt.com/v1/stream');
  ws21.emit(JSON.stringify({ type: 'server_ste_metadata', model_slug: 'gpt-5-5-mini', requested_model_experience: 'x', server_ttfvt_ms: 1 }));
  await sleep();
  check('approx STE does not affect verdict', cur().decision, 'UNKNOWN');
  check('approx STE does not mark uncertainty', cur().matchUncertain, false);
  check('no effective from approx', cur().effective, '');
  check('approx retained', cur().evidence.some((x) => x.approx && x.raw === 'gpt-5-5-mini'), true);

  console.log('\n[22] Work: lone STE frame anchored by handoff topic_id');
  nextBody = sse({ type: 'stream_handoff', conversation_id: 'c22', turn_exchange_id: 'tex-22',
    options: [{ type: 'subscribe_ws_topic', topic_id: 'conversation-turn-tex-22' }] });
  await send(req('gpt-6-astra-wm', 'c22'));
  await sleep();
  const ws22 = new window.WebSocket('wss://ws.chatgpt.com/p13/ws/user/u');
  const inner22 = named('server_ste_metadata', { model_slug: 'gpt-5-6-instant', requested_model_experience: 'agentic', server_ttfvt_ms: 9 });
  ws22.emit(JSON.stringify({ topic_id: 'conversation-turn-tex-22', type: 'message', data: { encoded_item: inner22 } }));
  await sleep();
  check('topic-anchored STE routes', cur().decision, 'ROUTED');
  check('not approx', cur().evidence.find((x) => x.raw === 'gpt-5-6-instant').approx, false);

  console.log('\n[23] canonicalization: version keywords need a number; dots compare equal to dashes');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-reviewer' } }) + DONE;
  await send(req('gpt-5-6', 'c23'));
  await sleep();
  check('reviewer is not a version suffix', cur().decision, 'ROUTED');
  nextBody = named('response.completed', { response: { model: 'gpt-5.6-thinking' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c23b'));
  await sleep();
  check('dot vs dash => MATCH', cur().decision, 'MATCH');

  console.log('\n[24] image-generation messages are sub-dispatch, not judged');
  nextBody = sse({ conversation_id: 'c24', message: { id: 'a24', author: { role: 'tool' }, metadata: { parent_id: 'user-c24', image_generation: { model: 'gpt-image-2' } } } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c24'));
  await sleep();
  check('image message sub-dispatch', ev('image_generation.model').category, 'subdispatch');
  check('no effective', cur().effective, '');

  console.log('\n[25] patch values are re-rooted under their path (object v / parent path)');
  nextBody = sse({ p: '/response/completed/model_info', o: 'replace', v: { slug: 'gpt-5-5-mini' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c25'));
  await sleep();
  check('object patch captured', cur().decision, 'ROUTED');
  ok('patch path kept', ev('patch:/response/completed/model_info.slug'));
  nextBody = sse({ p: '/response/completed', o: 'add', v: { model: 'gpt-5-5-mini' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c25b'));
  await sleep();
  check('parent-path patch captured', cur().decision, 'ROUTED');

  console.log('\n[26] resolved_* is unknown, never decisive');
  nextBody = named('server_ste_metadata', { resolved_model_slug: 'gpt-5-5-mini', requested_model_experience: 't', server_ttfvt_ms: 1 }) + DONE;
  await send(req('gpt-5-6-thinking', 'c26'));
  await sleep();
  check('resolved category', ev('resolved_model_slug').category, 'unknown');
  check('not routed', cur().decision, 'SUSPICIOUS');

  console.log('\n[27] evidence carries endpoint api');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c27'));
  await sleep();
  check('api on evidence', ev('response.model').api, 'f/conversation');

  console.log('\n[28] frames naming another window\'s conversation are dropped');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c28'));
  await sleep();
  const ws28 = new window.WebSocket('wss://ws.chatgpt.com/p13/ws/user/u');
  ws28.emit(JSON.stringify({ type: 'conversation-update', payload: { conversation_id: 'other-window', update_content: {
    message: { id: 'm-sol', author: { role: 'assistant' }, metadata: { model_slug: 'gpt-5.6-sol-wm' } } } } }));
  await sleep();
  check('still clean MATCH', cur().decision, 'MATCH');
  check('no uncertainty mark', cur().matchUncertain, false);
  ok('foreign evidence not attached', !cur().evidence.some((x) => x.raw === 'gpt-5.6-sol-wm'));

  console.log('\n[29] own-conversation update with image-gen auto combo is not a downgrade');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking' } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c29'));
  await sleep();
  const ws29 = new window.WebSocket('wss://ws.chatgpt.com/p13/ws/user/u');
  ws29.emit(JSON.stringify({ type: 'conversation-update', payload: { conversation_id: 'c29', update_content: { messages: [{
    id: 'm-img', author: { role: 'assistant' }, metadata: { parent_id: 'user-c29',
      requested_model_slug: 'gpt-5-4-auto-thinking', default_model_slug: 'gpt-5-6-thinking',
      resolved_model_slug: 'gpt-5-4-auto-thinking', model_slug: 'gpt-5-4-thinking' } }] } } }));
  await sleep();
  check('verdict unchanged', cur().decision, 'MATCH');
  check('no uncertainty mark', cur().matchUncertain, false);
  check('combo shown as sub-dispatch', ev('payload.update_content.messages[0].metadata.model_slug').category, 'subdispatch');

  console.log('\n[30] a differing echo that is NOT the auto combo still marks MATCH?');
  nextBody = named('response.completed', { response: { model: 'gpt-5-6-thinking' } })
    + sse({ message: { id: 'a30', author: { role: 'assistant' }, metadata: { parent_id: 'user-c30', model_slug: 'gpt-5-5-mini' } } }) + DONE;
  await send(req('gpt-5-6-thinking', 'c30'));
  await sleep();
  check('MATCH', cur().decision, 'MATCH');
  check('marked', cur().matchUncertain, true);

  console.log(failed ? `\n${failed} test(s) failed\n` : '\nAll tests passed\n');
  process.exit(failed ? 1 : 0);
})();
