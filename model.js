(() => {
  'use strict';

  // MAIN world. Read-only side channel: never mutates request params/auth headers and never blocks page responses.
  // v0.8+: collect every model-related field first, then classify the evidence. Do not equate the mere
  // presence of retry/faster/fallback candidates with an actual route.
  if (window.__YY_MUM_MODEL__) return;
  window.__YY_MUM_MODEL__ = true;

  const OUT = 'yy-mum-model';
  const IN = 'yy-mum-widget';
  const MAX_TEXT = 2 * 1024 * 1024;
  const MAX_STREAM = 64 * 1024 * 1024;
  const MAX_TURNS = 1;
  const KEEP_TURNS = 6;
  const MAX_DEPTH = 18;
  const MAX_ARRAY = 300;
  const MAX_EVIDENCE = 320;

  // These branches can be huge. They are still scanned for model-related keys, but ordinary text is never parsed.
  const HEAVY = new Set([
    'content', 'parts', 'text', 'prompt', 'tools', 'attachments', 'safe_urls',
    'citations', 'thoughts', 'search_result_groups', 'image_results',
    'finished_text', 'initial_text', 'blocked_urls', 'aggregate_result'
  ]);

  const SLUG = /^[\w.:+\-/@]{1,160}$/;
  const STE_NAME = /server_ste_metadata|ste_metadata/i;
  const STE_HINTS = [
    'requested_model_experience', 'did_auto_switch_to_reasoning',
    'is_autoswitcher_enabled', 'server_ttfvt_ms', 'turn_use_case'
  ];
  const STE_FLAGS = [
    'product_experience', 'requested_model_experience',
    'did_auto_switch_to_reasoning', 'is_autoswitcher_enabled',
    'auto_switcher_race_winner', 'is_search', 'tool_invoked', 'tool_name',
    'turn_use_case', 'plan_type', 'server_ttfvt_ms', 'cluster_region'
  ];

  const AUX_RE = /(^|_)(faster|retry|fallback|fall_back|backup|safety|buffer|buffering|candidate|alternate|alternative|shadow|speculative|draft|race|secondary|aux|auxiliary)(_|$)/;
  // v0.8.5: 'resolved' removed; its semantics are unconfirmed, so resolved_* now lands in unknown instead of requested.
  const REQUEST_RE = /(^|_)(requested|selected|selection|chosen|choice|intended|default|target|picker|preferred)(_|$)/;
  // v0.8.5: 'generation'/'generated' removed; they matched tool paths such as image_generation.model.
  const EFFECTIVE_RE = /(^|_)(effective|authoritative|actual|executed|execution|served|serving|used|final)(_|$)/;
  const FINAL_CONTAINER_RE = /(^|_)(response|created|completed|complete|completion|final|output|result)(_|$)/;
  // Side models that are not the answering model (image tools, title generation, moderation, speech).
  const TOOL_RE = /(^|_)(image_gen|image_generation|dalle|dall_e|gen_title|title_generation|moderation|moderations|embedding|embeddings|tts|transcription)(_|$)/;
  // Keys whose value (or whose object) names a model. Other model-ish keys are collected as model-adjacent only.
  const IDENTITY_KEY_RE = /^(?:.*_)?models?(?:_(?:slug|name|id|info|identity|details|metadata|meta))?$/;
  const NON_IDENTITY_RE = /(^|_)(experience|tier|class|mode|switcher|policy|capability|context|limit|max|latency|reason|strategy)(_|$)/;
  const GENERIC_REQUEST = new Set(['auto', 'automatic', 'default', 'router', 'routing']);

  let serial = 0;
  let paused = false;
  const turns = [];
  const notes = [];
  const msgOwner = new Map();
  let flushTimer = 0;

  const parse = (s) => {
    try { return typeof s === 'string' && s.length <= MAX_TEXT ? JSON.parse(s) : null; } catch { return null; }
  };
  const id = (v) => (typeof v === 'string' && SLUG.test(v) ? v : '');
  const text = (v) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, 160) : '');

  function note(s) {
    if (!notes.includes(s)) notes.push(s);
    while (notes.length > 6) notes.shift();
  }

  function semantic(s) {
    return String(s || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
  }

  function canonicalModel(value) {
    if (typeof value !== 'string') return '';
    let s = value.trim().toLowerCase();
    if (!s || s.length > 200) return '';
    s = s.replace(/^models\//, '');

    // Only strip clear snapshot/version suffixes. Family/mode suffixes such as mini/pro/sol/luna/astra/wm stay intact.
    let prev = '';
    while (s !== prev) {
      prev = s;
      s = s
        .replace(/(?:[-_.:@])(?:snapshot|version|ver|revision|rev|build)[-_.:@]?\d[\w.]*$/i, '')
        .replace(/(?:[-_.:@])v\d+(?:\.\d+)*$/i, '')
        .replace(/(?:[-_.:@])20\d{2}[-_.]\d{2}[-_.]\d{2}$/i, '')
        .replace(/(?:[-_.:@])20\d{6}$/i, '');
    }
    return s;
  }

  // Comparison key only: gpt-5.6-x and gpt-5-6-x are the same model. Display keeps the raw/canonical form.
  function cmpKey(canon) {
    return String(canon || '').replace(/\./g, '-');
  }

  function isConcreteModel(canon) {
    return !!canon && !GENERIC_REQUEST.has(canon);
  }

  function leafKey(path) {
    const clean = String(path || '').replace(/\[\d+\]$/g, '');
    const m = clean.match(/(?:^|\.)([^.]+)$/);
    return m ? m[1] : clean;
  }

  function isModelKey(key) {
    return semantic(key).includes('model');
  }

  function isIdentityKey(key) {
    const k = semantic(key);
    return !NON_IDENTITY_RE.test(k) && IDENTITY_KEY_RE.test(k);
  }

  function identityField(path, key, modelContext = false, adjacent = false) {
    const semPath = semantic(path);
    const semKey = semantic(key || leafKey(path));
    if (NON_IDENTITY_RE.test(semKey) || /model_(experience|tier|class|mode|switcher|policy|capability|context|limit|max|latency)/.test(semPath)) return false;
    if (IDENTITY_KEY_RE.test(semKey)) return true;
    if (modelContext && !adjacent && /^(slug|name|id|key|value)$/.test(semKey)) return true;
    return false;
  }

  function isHistoricalRequestPath(path) {
    return /^messages\[\d+\]/.test(path) || /^conversation\.messages\[\d+\]/.test(path);
  }

  function classifyEvidence(path, key, ctx, identity) {
    const semPath = semantic(path);
    const semKey = semantic(key || leafKey(path));
    const semEvent = semantic(ctx.event || '');

    if (AUX_RE.test(semPath) || AUX_RE.test(semKey)) return 'auxiliary';
    if (TOOL_RE.test(semPath)) return 'auxiliary';
    // resolved_* semantics are unconfirmed: shown, feeds MATCH?, but never decides.
    if (/(^|_)resolved(_|$)/.test(semKey)) return 'unknown';
    if (REQUEST_RE.test(semPath) || REQUEST_RE.test(semKey)) return 'requested';

    // Known ChatGPT response echo: useful evidence, but not authoritative execution evidence.
    if (!ctx.ste && /(^|_)message_metadata_model(_slug)?($|_)/.test(semPath)) return 'requested';

    if (ctx.ste && identity) return 'effective';
    if (EFFECTIVE_RE.test(semPath) || EFFECTIVE_RE.test(semKey)) return 'effective';

    // response.model / response.created.model / response.completed.model and equivalent final-response semantics.
    if (identity && ctx.source !== 'request') {
      const leafIsModel = semKey === 'model' || /model_(slug|name|id)$/.test(semKey) || /^(slug|name|id)$/.test(semKey);
      if (leafIsModel && (FINAL_CONTAINER_RE.test(semPath) || FINAL_CONTAINER_RE.test(semEvent))) return 'effective';
      if (leafIsModel && (path === 'model' || /^response\.model$/.test(path))) return 'effective';
    }

    if (ctx.source === 'request' && (path === 'model' || path === 'request.model')) return 'requested';
    return 'unknown';
  }

  function evidenceRank(category, path, ctx) {
    const sem = semantic(path + '_' + (ctx.event || ''));
    if (category === 'effective') {
      if (ctx.ste) return 100;
      if (/(^|_)(completed|complete|final)(_|$)/.test(sem)) return 96;
      if (/(^|_)(created|response)(_|$)/.test(sem)) return 92;
      if (EFFECTIVE_RE.test(sem)) return 90;
      return 84;
    }
    if (category === 'requested') {
      if (ctx.source === 'request' && (path === 'model' || path === 'request.model')) return 100;
      if (/(^|_)(requested|selected|chosen|intended|target)(_|$)/.test(sem)) return 82;
      if (/message_metadata_model/.test(sem)) return 55;
      return 65;
    }
    return 20;
  }

  function rawValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }

  function addEvidence(t, value, path, key, ctx, modelContext = false) {
    if (!t || value === undefined || (typeof value === 'object' && value !== null)) return;
    const identity = identityField(path, key, modelContext, !!ctx.adjacent);
    // Non-identity fields are still shown in Raw Evidence but can never feed the verdict.
    // Messages produced by a system sub-dispatch (image generation etc.) are shown but never judged.
    const category = !identity ? 'adjacent' : ctx.subDispatch ? 'subdispatch' : classifyEvidence(path, key, ctx, identity);
    const canonical = identity ? canonicalModel(typeof value === 'string' ? value : '') : '';
    const relevant = !(ctx.source === 'request' && isHistoricalRequestPath(path));
    const ev = {
      path,
      raw: rawValue(value),
      source: ctx.source || 'response',
      category,
      canonical,
      identity,
      relevant,
      rank: evidenceRank(category, path, ctx),
      event: text(ctx.event || ''),
      transport: text(ctx.transport || ''),
      api: text(ctx.api || ''),
      approx: !!ctx.approx
    };
    const sig = [ev.source, ev.path, JSON.stringify(ev.raw), ev.category, ev.event].join('|');
    if (t.evidenceSigs.has(sig)) return;
    t.evidenceSigs.add(sig);
    t.evidence.push(ev);
    if (t.evidence.length > MAX_EVIDENCE) {
      // Evict the least useful evidence first; never drop decisive evidence while noise remains.
      let at = t.evidence.findIndex((e) => e.category === 'adjacent');
      if (at < 0) at = t.evidence.findIndex((e) => e.category === 'unknown' || e.category === 'auxiliary' || e.approx);
      if (at < 0) at = t.evidence.findIndex((e) => e.category === 'requested' && e.source !== 'request');
      if (at < 0) at = 0;
      const [removed] = t.evidence.splice(at, 1);
      if (removed) t.evidenceSigs.delete([removed.source, removed.path, JSON.stringify(removed.raw), removed.category, removed.event].join('|'));
      note('模型证据过多，仅保留最近一部分');
    }

    // Legacy buckets kept for backward compatibility and existing diagnostics.
    if (identity && canonical) {
      const raw = typeof value === 'string' ? value : String(value);
      if (category === 'effective' && ctx.ste && !t.exec.includes(raw)) t.exec.push(raw);
      if (category === 'requested' && /message\.metadata\.model_slug$/.test(path) && !t.echo.includes(raw)) t.echo.push(raw);
    }

    if (!t.paths.includes(path)) {
      t.paths.push(path);
      while (t.paths.length > 40) t.paths.shift();
    }
    if (ctx.transport) mark(t, ctx.transport);
    if (ctx.approx) t.approx = true;
    if (category === 'effective' && identity && canonical && !ctx.approx) t.state = '已确认执行模型';
    else if (t.state === '已发送') t.state = '流中，收集模型证据';
    flush();
  }

  function representative(list) {
    if (!list.length) return '';
    const sorted = [...list].sort((a, b) => b.rank - a.rank);
    return typeof sorted[0].raw === 'string' ? sorted[0].raw : String(sorted[0].raw ?? '');
  }

  function summarizeTurn(t) {
    const key = (e) => cmpKey(e.canonical);
    const identities = t.evidence.filter((e) => e.identity && e.canonical && e.relevant);
    const requestedEvs = identities.filter((e) => e.category === 'requested');
    const effAll = identities.filter((e) => e.category === 'effective');
    // Evidence attached only by "latest send" fallback is shown, but never decides the verdict.
    const effectiveEvs = effAll.filter((e) => !e.approx);
    const approxEffective = effAll.filter((e) => e.approx);
    const uncertainEvs = identities.filter((e) => e.category === 'auxiliary' || e.category === 'unknown');

    let requested = t.requested || representative(requestedEvs);
    let requestedCanonical = canonicalModel(requested);
    if (!requestedCanonical && requestedEvs.length) {
      const best = [...requestedEvs].sort((a, b) => b.rank - a.rank)[0];
      requested = typeof best.raw === 'string' ? best.raw : String(best.raw ?? '');
      requestedCanonical = best.canonical;
    }
    const requestedKey = cmpKey(requestedCanonical);

    // The highest-ranked tier decides which model is displayed.
    const maxEffectiveRank = effectiveEvs.length ? Math.max(...effectiveEvs.map((e) => e.rank)) : -1;
    const decisiveEffective = effectiveEvs.filter((e) => e.rank === maxEffectiveRank);
    const effectiveGroups = new Map();
    for (const ev of decisiveEffective) {
      const k = key(ev);
      if (!effectiveGroups.has(k)) effectiveGroups.set(k, []);
      effectiveGroups.get(k).push(ev);
    }
    const effectiveKeys = [...effectiveGroups.keys()];
    let effective = '';
    let effectiveCanonical = '';
    let effectiveKey = '';
    if (effectiveKeys.length === 1) {
      effectiveKey = effectiveKeys[0];
      const group = effectiveGroups.get(effectiveKey);
      effectiveCanonical = group[0].canonical;
      effective = representative(group);
    } else if (effectiveKeys.length > 1) {
      effective = effectiveKeys.map((k) => representative(effectiveGroups.get(k))).join(' / ');
    }

    // ...but any lower authoritative tier that disagrees must not be silently dropped.
    // Exception: response.created is an earlier lifecycle stage of the same response; when a completed/final
    // stage decides, a differing created value is shown and marks MATCH?, but is not a conflict.
    const stageOf = (e) => semantic(e.path + '_' + (e.event || ''));
    const decidedByFinal = decisiveEffective.some((e) => /(^|_)(completed|complete|final)(_|$)/.test(stageOf(e)));
    const superseded = (e) => decidedByFinal && /(^|_)created(_|$)/.test(stageOf(e)) && !/(^|_)(completed|complete|final)(_|$)/.test(stageOf(e));
    const tierConflict = !!effectiveKey && effectiveEvs.some((e) => key(e) !== effectiveKey && !superseded(e));

    // Other concrete models seen in this window's non-deciding evidence (drives MATCH?).
    // Unanchored (≈) evidence may come from another window on the shared user-level socket, so it is
    // listed in the panel but excluded here. Echoes that name a different model count; the request body
    // itself and default_* (account/conversation default) do not.
    const refKeys = new Set([requestedKey, effectiveKey].filter(Boolean));
    const others = new Map();
    const differingEcho = requestedEvs.filter((e) => !e.approx && e.source !== 'request' && !/(^|_)default(_|$)/.test(semantic(e.path)));
    for (const e of [...uncertainEvs.filter((x) => !x.approx), ...differingEcho, ...effectiveEvs.filter(superseded)]) {
      const k = key(e);
      if (isConcreteModel(e.canonical) && !refKeys.has(k) && !others.has(k)) {
        others.set(k, typeof e.raw === 'string' ? e.raw : String(e.raw ?? ''));
      }
    }

    let decision = 'UNKNOWN';
    let reason = 'No authoritative model evidence';
    if (effectiveKeys.length > 1) {
      decision = 'SUSPICIOUS';
      reason = 'Conflicting highest-authority model evidence';
    } else if (tierConflict) {
      decision = 'SUSPICIOUS';
      reason = 'Authoritative evidence at different tiers names different models';
    } else if (effectiveKey && isConcreteModel(requestedCanonical)) {
      if (effectiveKey === requestedKey) {
        decision = 'MATCH';
        reason = 'Authoritative effective model matches requested model after canonicalization';
      } else {
        decision = 'ROUTED';
        reason = 'Authoritative effective model differs from requested model';
      }
    } else if (effectiveKey && requestedCanonical) {
      decision = 'UNKNOWN';
      reason = 'Requested selector is not a concrete model identity';
    } else if (isConcreteModel(requestedCanonical)) {
      const otherRequested = requestedEvs.some((e) => !e.approx && key(e) !== requestedKey && !/(^|_)default(_|$)/.test(semantic(e.path)));
      if (otherRequested || others.size) {
        decision = 'SUSPICIOUS';
        reason = 'A different model appears only in non-authoritative evidence';
      }
    }

    return {
      requested, requestedCanonical, effective, effectiveCanonical, decision, reason,
      others: [...others.values()],
      matchUncertain: decision === 'MATCH' && others.size > 0
    };
  }

  function publicTurn(t) {
    const summary = summarizeTurn(t);
    return {
      n: t.n,
      t: t.time,
      api: t.api,
      ui: t.ui,
      requested: summary.requested,
      requestedCanonical: summary.requestedCanonical,
      effective: summary.effective,
      effectiveCanonical: summary.effectiveCanonical,
      decision: summary.decision,
      decisionReason: summary.reason,
      matchUncertain: summary.matchUncertain,
      others: summary.others,
      effort: t.effort,
      exec: [...t.exec],
      echo: [...t.echo],
      flags: { ...t.flags },
      paths: [...t.paths],
      events: [...t.events],
      transports: [...t.transports],
      evidence: t.evidence.map(({ path, raw, source, category, canonical, identity, relevant, event, transport, api, approx }) => ({
        path, raw, source, category, canonical, identity, relevant, event, transport, api, approx
      })),
      state: t.state,
      // Status note only when nothing this window can anchor has decided the verdict.
      approx: t.approx && !summary.effective,
      closed: t.closed
    };
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      window.postMessage({
        source: OUT,
        type: 'YY_MUM_DATA',
        snapshot: {
          v: 3,
          paused,
          notes: [...notes],
          turns: turns.slice(-MAX_TURNS).reverse().map(publicTurn)
        }
      }, '*');
    }, 90);
  }

  /* ---------------- UI-selected model (best effort only) ---------------- */

  const MODEL_TEXT = /gpt|o\d|auto|thinking|instant|terra|luna|sol|astra|pro\b|mini/i;

  function uiLabel() {
    let node = document.getElementById('prompt-textarea');
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const pills = node.querySelectorAll(
        '[class*="composer-pill"],[class*="SliderTriggerModelLabel"],[data-testid*="model-switcher"]'
      );
      for (const pill of pills) {
        const s = text((pill.textContent || '').trim());
        if (s && s.length <= 40 && MODEL_TEXT.test(s)) return s;
      }
    }
    const seen = [];
    document.querySelectorAll('[data-testid*="model-switcher"]').forEach((el) => {
      const s = text((el.textContent || '').trim());
      if (s && MODEL_TEXT.test(s) && !seen.includes(s)) seen.push(s);
    });
    return seen.length === 1 ? seen[0] : '';
  }

  /* ---------------- Endpoint recognition ---------------- */

  function endpoint(raw) {
    try {
      const u = new URL(raw, location.href);
      if (u.origin !== location.origin) return null;
      if (/^\/backend-api\/f\/conversation\/?$/.test(u.pathname)) return { kind: 'send', api: 'f/conversation' };
      if (/^\/backend-api\/conversation\/?$/.test(u.pathname)) return { kind: 'send', api: 'conversation' };
      const status = u.pathname.match(/^\/backend-api\/(?:f\/)?conversation\/([\w-]+)\/(stream_status|stream)\/?$/);
      if (status) return { kind: 'resume', api: status[2], conversation: status[1] };
      if (/^\/(ces|cdn|assets|_next|static)\//.test(u.pathname)) return null;
      if (/\/(sentinel|settings|pets|conversations|gizmos|models)(\/|$)/.test(u.pathname)) return null;
      return { kind: 'sniff', api: u.pathname.replace(/\/[0-9a-f-]{16,}/gi, '/{id}').replace('/backend-api/', '').slice(0, 48) };
    } catch { return null; }
  }

  /* ---------------- Turn association ---------------- */

  function newTurn(api, body) {
    const b = typeof body === 'string' ? parse(body) : body;
    if (!b || typeof b !== 'object') { note('请求体不可读，本次未建立记录'); return null; }
    const t = {
      n: ++serial,
      time: Date.now(),
      api,
      conversation: id(b.conversation_id),
      exchange: '',
      turnId: '',
      topics: [],
      userIds: (Array.isArray(b.messages) ? b.messages : [])
        .filter((m) => m?.author?.role === 'user').map((m) => id(m.id)).filter(Boolean),
      ui: uiLabel(),
      requested: id(b.model),
      effort: id(b.thinking_effort) || id(b.reasoning_effort),
      exec: [],
      echo: [],
      evidence: [],
      evidenceSigs: new Set(),
      flags: {},
      paths: [], events: [], transports: [],
      state: '已发送',
      approx: false,
      closed: false
    };
    turns.push(t);
    while (turns.length > KEEP_TURNS) turns.shift();

    // Collect request-side evidence recursively, including nested model-related fields.
    walk(b, { turn: t, conversation: t.conversation, turnId: '', transport: 'request body', api, source: 'request', event: '', role: '', ste: false, approx: false, modelContext: false }, 0, '');
    flush();
    return t;
  }

  function mark(t, transport) {
    if (t && transport && !t.transports.includes(transport)) t.transports.push(transport);
  }

  function seenEvent(t, name) {
    if (!t || !name) return;
    const s = text(name).slice(0, 80);
    if (s && !t.events.includes(s)) { t.events.push(s); while (t.events.length > 30) t.events.shift(); }
  }

  /* ---------------- This-window scope ---------------- */

  // The WebSocket is user-level and carries every window's traffic. A frame that explicitly names a
  // conversation this window does not own is dropped before any evidence is taken from it.
  function tabConversation() {
    try {
      const m = String(location.pathname || '').match(/\/c\/([\w-]{8,})/);
      return m ? m[1] : '';
    } catch { return ''; }
  }

  function isForeignConversation(conv) {
    if (!conv) return false;
    if (turns.some((t) => t.conversation === conv)) return false;
    const tab = tabConversation();
    if (tab) return conv !== tab;
    // New chat (no id in the URL yet): foreign only if this window's turns already know their own id.
    return turns.some((t) => t.conversation);
  }

  function modelOf(v) { return cmpKey(canonicalModel(typeof v === 'string' ? v : '')); }

  // Image generation (and similar system sub-calls) write their own message whose metadata names an
  // auto selector and the model it resolved to, e.g. requested gpt-5-4-auto-thinking -> gpt-5-4-thinking.
  // That is the sub-call's own routing, not a downgrade of the user's request.
  function isSubDispatchMessage(node, turn) {
    const author = node.author || {};
    const md = node.metadata || {};
    if (/(t2uay3k|image_?gen|dall[-_.]?e|text2im)/i.test(String(author.name || ''))) return true;
    if (Object.keys(md).some((k) => /^(image_gen|dalle|image_generation)/i.test(k))) return true;
    if (/image/i.test(String(md.async_task_type || ''))) return true;

    const own = modelOf(md.requested_model_slug);
    if (!own || !/(^|-)auto(-|$)/.test(own)) return false;
    const userReq = modelOf(turn?.requested);
    if (!userReq || userReq === own || /(^|-)auto(-|$)/.test(userReq)) return false;
    const served = [md.model_slug, md.resolved_model_slug].map(modelOf).filter(Boolean);
    const base = own.replace(/-auto(?=-|$)/, '');
    return served.length > 0 && served.every((m) => m === own || m === base);
  }

  const topicOwner = new Map();

  function rememberTopic(topic, turn) {
    if (!topic || !turn) return;
    topicOwner.set(topic, turn);
    if (topicOwner.size > 60) topicOwner.delete(topicOwner.keys().next().value);
  }

  function turnForTopic(topic) {
    if (!topic) return null;
    const known = topicOwner.get(topic);
    if (known && turns.includes(known)) return known;
    return turns.find((t) => t.exchange && topic.includes(t.exchange))
      || turns.find((t) => t.topics.some((x) => topic.includes(x)))
      || null;
  }

  function ownerFor(meta, ctx) {
    meta = meta && typeof meta === 'object' ? meta : {};
    const exchange = id(meta.turn_exchange_id);
    const turnId = id(meta.working_turn_id) || ctx.turnId;
    const parent = id(meta.parent_id);
    const live = turns.filter((t) => !ctx.conversation || !t.conversation || t.conversation === ctx.conversation);

    let hit = exchange ? live.find((t) => t.exchange && t.exchange === exchange) : null;
    if (!hit && turnId) hit = live.find((t) => t.turnId && t.turnId === turnId);
    if (!hit && parent) hit = live.find((t) => t.userIds.includes(parent)) || msgOwner.get(parent);
    if (!hit && ctx.topic) hit = turnForTopic(ctx.topic);
    if (hit) return { turn: hit, approx: false };
    if (ctx.turn) return { turn: ctx.turn, approx: !!ctx.approx };

    // Frame explicitly names a conversation and exactly one turn in it is still open: treat as anchored.
    if (ctx.conversation) {
      const open = turns.filter((t) => !t.closed && t.conversation === ctx.conversation);
      if (open.length === 1) return { turn: open[0], approx: false };
    }
    const last = live[live.length - 1];
    return last ? { turn: last, approx: true } : { turn: null, approx: false };
  }

  function ensureTurn(ctx, meta) {
    if (ctx.turn) return ctx;
    const found = ownerFor(meta || {}, ctx);
    if (found.turn && !found.approx && ctx.topic) rememberTopic(ctx.topic, found.turn);
    if (found.turn && !found.approx && ctx.anchor) ctx.anchor.turn = found.turn;
    return found.turn ? { ...ctx, turn: found.turn, approx: found.approx } : ctx;
  }

  // Stream-local anchor: once any frame in a stream is tied to a turn by id, later frames inherit it.
  function anchored(ctx) {
    return !ctx.turn && ctx.anchor?.turn ? { ...ctx, turn: ctx.anchor.turn, approx: false } : ctx;
  }

  function frameTopic(v) {
    if (!v || typeof v !== 'object') return '';
    for (const box of [v, v.data, v.payload, v.message]) {
      if (!box || typeof box !== 'object') continue;
      for (const k of ['topic_id', 'topic', 'topicId', 'channel']) {
        const s = id(box[k]);
        if (s) return s;
      }
    }
    return '';
  }

  /* ---------------- Header evidence ---------------- */

  function collectHeaderEntries(t, headers, direction, approx = false, api = '') {
    if (!t || !headers) return;
    try {
      new Headers(headers).forEach((value, key) => {
        if (!isModelKey(key)) return;
        const ctx = { turn: t, source: 'header', transport: `${direction} header`, api, event: '', ste: false, approx, role: '', modelContext: false };
        addEvidence(t, value, `${direction}.header.${key}`, key, ctx, false);
      });
    } catch {}
  }

  function mergeRequestHeaders(input, init) {
    const h = new Headers();
    try { if (input instanceof Request) input.headers.forEach((v, k) => h.set(k, v)); } catch {}
    try { if (init?.headers) new Headers(init.headers).forEach((v, k) => h.set(k, v)); } catch {}
    return h;
  }

  function collectResponseHeaders(ctx, headers) {
    const resolved = ensureTurn(ctx);
    if (!resolved.turn || !headers) return;
    collectHeaderEntries(resolved.turn, headers, 'response', resolved.approx, ctx.api || '');
    flush();
  }

  /* ---------------- SSE ---------------- */

  function frames(chunk, onValue) {
    for (const frame of chunk.split(/\r?\n\r?\n/)) {
      let name = '';
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      const body = data.join('\n');
      if (!body || body === '[DONE]') continue;
      const v = parse(body);
      if (v !== null) onValue(v, name);
    }
  }

  function makeStream(onValue) {
    let buffer = '';
    return {
      feed(chunk, last) {
        buffer += chunk;
        let cut;
        while ((cut = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, cut.index);
          buffer = buffer.slice(cut.index + cut[0].length);
          frames(frame + '\n\n', onValue);
        }
        if (buffer.length > MAX_TEXT) { buffer = ''; note('单个事件过大，已跳过'); }
        if (last) { if (buffer) frames(buffer + '\n\n', onValue); buffer = ''; }
      }
    };
  }

  function decodeItem(s) {
    if (typeof s !== 'string' || !s) return '';
    if (/(^|\n)\s*(data:|event:)/.test(s)) return s;
    if (s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
      try {
        const bin = atob(s);
        return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      } catch { return s; }
    }
    return s;
  }

  /* ---------------- Recursive model-evidence scan ---------------- */

  function isSteNode(node, path, ctx) {
    if (STE_NAME.test(path)) return true;
    if (STE_NAME.test(String(ctx.event || ''))) return true;
    if (STE_NAME.test(String(node.type || ''))) return true;
    const hints = STE_HINTS.reduce((n, h) => n + (h in node ? 1 : 0), 0);
    return hints >= 2;
  }

  function walk(node, ctx, depth, path) {
    if (paused || depth > MAX_DEPTH || node == null) return;

    if (Array.isArray(node)) {
      const limit = Math.min(node.length, MAX_ARRAY);
      for (let i = 0; i < limit; i++) {
        const item = node[i];
        const here = `${path}[${i}]`;
        if ((typeof item !== 'object' || item === null) && ctx.modelContext) {
          addEvidence(ctx.turn, item, here, ctx.modelKey || leafKey(path), ctx, true);
        } else {
          walk(item, ctx, depth + 1, here);
        }
      }
      return;
    }

    if (typeof node !== 'object') {
      if (ctx.modelContext) addEvidence(ctx.turn, node, path, ctx.modelKey || leafKey(path), ctx, true);
      return;
    }

    // Drop subtrees that explicitly belong to another window's conversation. Exception: this window's own
    // HTTP stream for a brand-new chat, where the id is the one the server has just assigned.
    const ownNewChat = ctx.turn && !ctx.approx && !ctx.turn.conversation && ctx.transport !== 'WebSocket';
    if (!ownNewChat && isForeignConversation(id(node.conversation_id))) return;

    let next = ctx;
    if (id(node.conversation_id) || id(node.turn_id)) {
      next = {
        ...ctx,
        conversation: id(node.conversation_id) || ctx.conversation,
        turnId: id(node.turn_id) || ctx.turnId
      };
    }

    if (depth === 0) {
      const resolved = ensureTurn(anchored(next), node);
      next = resolved;
      if (next.turn && !next.approx && !next.turn.conversation && id(node.conversation_id)) {
        next.turn.conversation = id(node.conversation_id);
      }
      seenEvent(next.turn, next.event || String(node.type || ''));
    }

    if (node.type === 'stream_handoff' && next.turn && !next.approx) {
      next.turn.exchange = id(node.turn_exchange_id) || next.turn.exchange;
      next.turn.conversation = next.turn.conversation || id(node.conversation_id);
      if (Array.isArray(node.options)) {
        for (const opt of node.options) {
          const topic = id(opt?.topic_id);
          if (topic && !next.turn.topics.includes(topic)) { next.turn.topics.push(topic); rememberTopic(topic, next.turn); }
        }
      }
      if (next.turn.state === '已发送') next.turn.state = '已移交后台，收集模型证据';
      mark(next.turn, next.transport);
      flush();
    }

    if (node.author && node.metadata && typeof node.metadata === 'object') {
      const mid = id(node.id);
      const found = ownerFor(node.metadata, next);
      if (found.turn) {
        if (mid) {
          msgOwner.set(mid, found.turn);
          if (msgOwner.size > 600) msgOwner.delete(msgOwner.keys().next().value);
        }
        if (!found.approx) {
          found.turn.exchange = found.turn.exchange || id(node.metadata.turn_exchange_id);
          found.turn.turnId = found.turn.turnId || id(node.metadata.working_turn_id) || next.turnId;
          if (next.anchor) next.anchor.turn = found.turn;
          if (next.topic) rememberTopic(next.topic, found.turn);
        }
        if (node.end_turn === true) found.turn.closed = true;
        next = { ...next, turn: found.turn, approx: found.approx, role: node.author?.role,
          subDispatch: next.subDispatch || isSubDispatchMessage(node, found.turn) };
      }
    }

    const ste = next.ste || isSteNode(node, path, next);
    if (ste) {
      next = ensureTurn({ ...next, ste: true });
      if (next.turn) {
        for (const key of STE_FLAGS) {
          if (key in node && (typeof node[key] !== 'object' || node[key] === null)) {
            next.turn.flags[key] = typeof node[key] === 'string' ? text(node[key]) : node[key];
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;

      if (key === 'encoded_item' && typeof value === 'string') {
        const anchor = { turn: next.approx ? null : next.turn };
        makeStream((v, name) => {
          const base = anchor.turn ? { ...next, turn: anchor.turn, approx: false } : next;
          walk(v, {
            ...base,
            anchor,
            source: 'SSE',
            event: name || next.event,
            modelContext: false,
            adjacent: false,
            modelKey: ''
          }, depth + 1, name ? `event:${name}` : 'encoded_item');
        }).feed(decodeItem(value), true);
        continue;
      }

      // JSON patch/delta shape: {p:"/a/b/model", o:"replace", v:...}. The value is always re-rooted under
      // patch:<p>, so an object v or a parent-path patch keeps its semantic destination.
      if (key === 'p' && typeof value === 'string' && 'v' in node) {
        const patchPath = `patch:${value}`;
        const segs = value.split('/').filter((x) => x && !/^\d+$/.test(x));
        const patchKey = segs[segs.length - 1] || '';
        const inModel = segs.some(isModelKey);
        const inIdentity = segs.some(isIdentityKey);
        const pv = node.v;
        if (pv !== null && typeof pv === 'object') {
          walk(pv, {
            ...next,
            modelContext: inModel || next.modelContext,
            adjacent: inModel && !inIdentity ? true : !!next.adjacent,
            modelKey: inModel ? (segs.filter(isModelKey).pop() || next.modelKey) : next.modelKey
          }, depth + 1, patchPath);
        } else if (inModel || next.modelContext) {
          const ctxModel = segs.slice(0, -1).some(isIdentityKey) || next.modelContext;
          addEvidence(next.turn, pv, patchPath, patchKey, { ...next, adjacent: inModel && !inIdentity }, ctxModel);
        }
        continue;
      }
      if (key === 'v' && typeof node.p === 'string') continue;

      const keyIsModel = isModelKey(key);
      const keyIsIdentity = keyIsModel && isIdentityKey(key);
      const childModelContext = keyIsModel || next.modelContext;
      const childAdjacent = keyIsModel ? !keyIsIdentity : !!next.adjacent;
      const childCtx = { ...next, modelContext: childModelContext, adjacent: childAdjacent, modelKey: keyIsModel ? key : next.modelKey };

      if (typeof value !== 'object' || value === null) {
        if (keyIsModel || next.modelContext) addEvidence(next.turn, value, here, key, next, next.modelContext);
        continue;
      }

      // Heavy branches still get a key-only recursive scan; string content is never parsed as JSON.
      if (HEAVY.has(key) && !keyIsModel && !next.modelContext) {
        walk(value, { ...next, modelContext: false, adjacent: false, modelKey: '' }, depth + 1, here);
      } else {
        walk(value, childCtx, depth + 1, here);
      }
    }

    if (node.type === 'done' || node.type === 'conversation_turn_done' || node.type === 'message_stream_complete') {
      if (next.turn) { next.turn.closed = true; finalizeState(next.turn); flush(); }
    }
  }

  const consume = (value, ctx) => walk(value, ctx, 0, '');

  function finalizeState(turn) {
    if (!turn || turn.state === '请求失败') return;
    const summary = summarizeTurn(turn);
    if (summary.effective) turn.state = '已确认执行模型';
    else turn.state = '流已结束，证据不足';
  }

  function closeStream(turn) {
    if (!turn) return;
    turn.closed = true;
    finalizeState(turn);
    flush();
  }

  /* ---------------- fetch ---------------- */

  const nativeFetch = window.fetch;
  window.fetch = new Proxy(nativeFetch, {
    apply(target, self, args) {
      const [input, init] = args;
      let ep = null;
      let requestHeaders = null;
      let url = '';
      try {
        url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
        ep = endpoint(url);
        requestHeaders = mergeRequestHeaders(input, init);
      } catch {}
      if (paused || !ep) return Reflect.apply(target, self, args);

      let turn = null;
      let bodyRead = Promise.resolve();
      if (ep.kind === 'send') {
        if (typeof init?.body === 'string') {
          turn = newTurn(ep.api, init.body);
          collectHeaderEntries(turn, requestHeaders, 'request', false, ep.api);
        } else if (input instanceof Request && !init?.body) {
          try {
            bodyRead = input.clone().text().then((body) => {
              turn = newTurn(ep.api, body);
              collectHeaderEntries(turn, requestHeaders, 'request', false, ep.api);
            }).catch(() => {});
          } catch { note('请求体已被消费，本次未记录发送模型'); }
        }
      }

      const promise = Reflect.apply(target, self, args);
      promise.then((response) => {
        const stream = /text\/event-stream/i.test(response.headers.get('content-type') || '');
        if (ep.kind === 'sniff' && !stream) return;
        let clone;
        try { clone = response.clone(); } catch { note('响应不可复制'); return; }
        void (async () => {
          await bodyRead;
          // Resume streams whose URL carries a topic announced by stream_handoff are anchored directly.
          const topicTurn = !turn ? turns.find((t) => t.topics.some((x) => url.includes(x))) || null : null;
          const baseCtx = {
            turn: turn || topicTurn,
            conversation: turn?.conversation || ep.conversation || '',
            turnId: '',
            transport: ep.kind === 'resume' ? ep.api : (stream ? 'HTTP SSE' : 'HTTP JSON'),
            api: ep.api,
            anchor: { turn: turn || topicTurn },
            source: stream ? 'SSE' : 'response',
            event: '', role: '', ste: false, approx: false, modelContext: false, adjacent: false, modelKey: ''
          };
          collectResponseHeaders(baseCtx, response.headers);
          if (!clone.body) return;

          const reader = clone.body.getReader();
          const decoder = new TextDecoder();
          const parser = stream
            ? makeStream((v, name) => consume(v, anchored({ ...baseCtx, source: 'SSE', event: name })))
            : null;
          let total = 0, buffer = '', handedOff = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (paused || total > MAX_STREAM) { void reader.cancel(); break; }
              const s = decoder.decode(value, { stream: true });
              if (parser) parser.feed(s, false);
              else {
                buffer += s;
                if (buffer.length > MAX_TEXT) { void reader.cancel(); return; }
              }
            }
            if (parser) parser.feed(decoder.decode(), true);
            else {
              const v = parse(buffer + decoder.decode());
              if (v) consume(v, baseCtx);
            }
            handedOff = !!turn?.exchange;
            if (ep.kind === 'send' && !handedOff) closeStream(turn);
          } finally { try { reader.releaseLock(); } catch {} }
        })().catch(() => note('响应采集失败，页面请求不受影响'));
      }, () => { if (turn) { turn.state = '请求失败'; turn.closed = true; flush(); } });
      return promise;
    }
  });
  try {
    Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
    window.fetch.toString = nativeFetch.toString.bind(nativeFetch);
  } catch {}

  /* ---------------- WebSocket handoff ---------------- */

  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      let eligible = false;
      try {
        const host = new URL(args[0], location.href).hostname;
        eligible = /(^|\.)chatgpt\.com$/.test(host) || /(^|\.)openai\.com$/.test(host);
      } catch {}
      if (eligible) {
        let chain = Promise.resolve();
        ws.addEventListener('message', (e) => {
          if (paused) return;
          chain = chain.then(async () => {
            const raw = typeof e.data === 'string' ? e.data
              : e.data instanceof Blob ? await e.data.text()
              : e.data instanceof ArrayBuffer ? new TextDecoder().decode(e.data) : '';
            if (paused || !raw) return;
            const v = parse(raw);
            if (v) consume(v, {
              turn: null, conversation: '', turnId: '', transport: 'WebSocket', api: 'WebSocket', topic: frameTopic(v),
              source: 'response', event: '', role: '', ste: false, approx: false, modelContext: false, adjacent: false, modelKey: ''
            });
          }).catch(() => {});
        });
      }
      return ws;
    }
  });

  /* ---------------- XHR fallback ---------------- */

  const xp = XMLHttpRequest.prototype;
  const nativeOpen = xp.open;
  const nativeSend = xp.send;
  const nativeSetRequestHeader = xp.setRequestHeader;
  const xhrMeta = new WeakMap();

  xp.open = function (method, url, ...rest) {
    xhrMeta.set(this, { ep: endpoint(url), headers: new Headers() });
    return nativeOpen.call(this, method, url, ...rest);
  };

  if (typeof nativeSetRequestHeader === 'function') {
    xp.setRequestHeader = function (name, value) {
      const meta = xhrMeta.get(this);
      try { meta?.headers?.set(name, value); } catch {}
      return nativeSetRequestHeader.call(this, name, value);
    };
  }

  xp.send = function (body) {
    const meta = xhrMeta.get(this);
    if (!paused && meta?.ep) {
      const turn = meta.ep.kind === 'send' ? newTurn(meta.ep.api, body) : null;
      if (turn) collectHeaderEntries(turn, meta.headers, 'request', false, meta.ep.api);

      this.addEventListener('loadend', () => {
        if (paused) return;
        try {
          const stream = /text\/event-stream/i.test(this.getResponseHeader?.('content-type') || '');
          // Like fetch(), the generic sniff channel only reads actual event streams.
          if (meta.ep.kind === 'sniff' && !stream) return;

          let ctx = {
            turn,
            conversation: turn?.conversation || meta.ep.conversation || '',
            turnId: '', transport: meta.ep.kind === 'resume' ? meta.ep.api : 'XHR', api: meta.ep.api,
            anchor: { turn: turn || null },
            source: stream ? 'SSE' : 'response', event: '', role: '', ste: false, approx: false,
            modelContext: false, adjacent: false, modelKey: ''
          };
          ctx = ensureTurn(ctx);

          try {
            const rawHeaders = this.getAllResponseHeaders?.() || '';
            const h = new Headers();
            rawHeaders.trim().split(/\r?\n/).forEach((line) => {
              const i = line.indexOf(':');
              if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
            });
            collectResponseHeaders(ctx, h);
          } catch {}

          if (stream) {
            const xctx = ctx.approx ? { ...ctx, turn: null, approx: false } : ctx;
            makeStream((v, name) => consume(v, anchored({ ...xctx, source: 'SSE', event: name }))).feed(this.responseText, true);
          } else {
            const v = this.responseType === 'json' ? this.response : parse(this.responseText);
            if (v) consume(v, ctx);
          }
          if (meta.ep.kind === 'send' && !turn?.exchange) closeStream(turn);
        } catch { note('XHR 响应不可读'); }
      }, { once: true });
    }
    return nativeSend.apply(this, arguments);
  };

  /* ---------------- Controls ---------------- */

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.source !== IN) return;
    if (data.type === 'YY_MUM_REQUEST') flush();
    if (data.type === 'YY_MUM_CLEAR') {
      turns.length = 0; notes.length = 0; msgOwner.clear(); topicOwner.clear(); serial = 0; flush();
    }
    if (data.type === 'YY_MUM_PAUSE') { paused = !!data.paused; flush(); }
  });

  flush();
})();
