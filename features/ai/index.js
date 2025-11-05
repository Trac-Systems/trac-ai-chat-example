import {Feature} from 'trac-peer';
import fetch from 'fetch';

// Lightweight token counting with optional @dqbd/tiktoken
async function createTokenizer() {
  try {
    const { encoding_for_model } = await import('@dqbd/tiktoken');
    const enc = encoding_for_model('gpt-4o'); // fallback encoding close to cl100k_base
    return {
      count(text) { return enc.encode(text).length },
      free() { try { enc.free(); } catch(_){} }
    };
  } catch(_) {
    return {
      count(text) { return Math.ceil((text || '').length / 4); }, // rough fallback
      free() {}
    }
  }
}

// fetch is provided via package alias to bare-node-fetch by trac-peer (see dependency mapping)

export class AiOracle extends Feature {

  constructor(peer, options = {}) {
    super(peer, options);
    this.model = options.model || 'gpt-oss-120b-fp16';
    this.endpoint = options.endpoint || 'http://127.0.0.1:8000/v1/chat/completions';
    this.maxContext = options.max_context_tokens || 32768;
    this.maxReply = options.max_reply_tokens || 1024;
    this.pollInterval = options.poll_interval_ms || 1000;
    this.historyWindow = (!isNaN(parseInt(options.history_window))) ? parseInt(options.history_window) : 64;
    this.maxBacklogTagged = options.max_backlog_tagged || 20;
    // Optional API key auth (OpenAI-style or custom header). Configure via ai_opts in index.js
    this.apiKey = options.api_key || null;
    this.apiKeyHeader = options.api_key_header || 'Authorization';
    this.apiKeyScheme = options.api_key_scheme || 'Bearer';
    // Inflight tracking: set of seq keys + timestamps and retry counters
    this.inflight = new Set();
    this.inflightSince = new Map(); // key -> Date.now()
    this.inflightRetries = new Map(); // key -> count
    this.inflightTtlMs = (!isNaN(parseInt(options.inflight_ttl_ms))) ? parseInt(options.inflight_ttl_ms) : 30_000;
    this.inflightMaxRetries = (!isNaN(parseInt(options.inflight_max_retries))) ? parseInt(options.inflight_max_retries) : 1;
    this.requestTimeoutMs = (!isNaN(parseInt(options.request_timeout_ms))) ? parseInt(options.request_timeout_ms) : 60_000; // more lenient default
    // Grace period to retry a fresh seq without emitting a busy message
    this.warmupGraceMs = (!isNaN(parseInt(options.warmup_grace_ms))) ? parseInt(options.warmup_grace_ms) : 15_000;
    // Last AI call diagnostics (TEMP)
    this.lastCall = null;
    this.lastCallEndedAt = 0;
  }

  async start(options = {}) {
    const tokenizer = await createTokenizer();
    try {
      // silent start
      // One-shot fast-forward on startup to avoid flooding chat with old backlog
      try {
        const psObj = await this.peer.base.view.get('process_seq');
        const msObj = await this.peer.base.view.get('message_seq');
        const ps = psObj !== null ? parseInt(psObj.value) : 0;
        const ms = msObj !== null ? parseInt(msObj.value) : 0;
        if(!isNaN(ms) && !isNaN(ps) && ms > ps) {
          await this.append('ai_ctrl', { op: 'fast_forward', queue: 'tagged', seq: ms });
        }
      } catch(_) {}
      while(true){
        try {
          // Gentle cooldown between calls to avoid immediate post-large-response spikes
          const sinceLast = Date.now() - (this.lastCallEndedAt || 0);
          const minCooldown = 1200; // ~1.2s default grace
          if (sinceLast > 0 && sinceLast < minCooldown) {
            await this.sleep(minCooldown - sinceLast);
          }
          // Gentle cooldown between calls to avoid immediate post-large-response spikes
          try {
            const sinceLastPrev = Date.now() - (this.lastCallEndedAt || 0);
            const heavy = (this.lastCall && ((this.lastCall.elapsed_ms || 0) >= 5000 || (this.lastCall.payload_bytes || 0) >= 25000));
            const baseCd = 1200;
            const extraCd = heavy ? (1800 + Math.floor(Math.random()*400)) : 0;
            const need = Math.max(0, baseCd - Math.max(0, sinceLastPrev), extraCd - Math.max(0, sinceLastPrev));
            if (need > 0) await this.sleep(need);
          } catch(_) {}

          // Read pointers for global queue (tagged + random types)
          const processSeqObj = await this.peer.base.view.get('process_seq');
          const messageSeqObj = await this.peer.base.view.get('message_seq');
          // Random/occasional replies share the same global queue
          let processSeq = processSeqObj !== null ? parseInt(processSeqObj.value) : 0;
          let messageSeq = messageSeqObj !== null ? parseInt(messageSeqObj.value) : 0;
          if(isNaN(processSeq)) processSeq = 0;
          if(isNaN(messageSeq)) messageSeq = 0;

          // Enforce backlog window via fast-forward control
          if(messageSeq - processSeq > this.maxBacklogTagged){
            await this.append('ai_ctrl', { op: 'fast_forward', queue: 'tagged', seq: messageSeq - this.maxBacklogTagged });
            processSeq = messageSeq - this.maxBacklogTagged;
          }
          // Single global queue only

          // Choose next seq to drain from the global queue
          let queue = null;
          let next = 0;
          if(messageSeq > processSeq){
            queue = 'tagged';
            next = processSeq + 1;
          } else {
            await this.sleep(this.pollInterval);
            continue;
          }

          const pendingKey = 'chat/pending/'+next;
          const pendingObj = await this.peer.base.view.get(pendingKey);
          if(pendingObj === null){
            await this.sleep(this.pollInterval);
            continue;
          }
          const inflightKey = 'seq:'+next;
          if (this.inflight.has(inflightKey)) {
            // TTL guard: if this inflight has been stuck too long, drop and optionally fast-forward after one retry
            try {
              let t0 = this.inflightSince.get(inflightKey);
              const now = Date.now();
              // If we inherited an inflight from a previous version without since-tracking,
              // initialize it now so TTL logic can start applying.
              if (!t0) {
                this.inflightSince.set(inflightKey, now);
                t0 = now;
              }
              // Additionally, consider the age of the pending item using contract time to avoid clock skew
              let ageMs = null;
              try {
                const ct = await this.peer.base.view.get('currentTime');
                const currentTime = ct ? ct.value : null;
                if (typeof currentTime === 'number' && typeof pendingObj.value?.timestamp === 'number') {
                  ageMs = currentTime - pendingObj.value.timestamp;
                }
              } catch(_) {}
              const ttlExceeded = (now - t0) > this.inflightTtlMs;
              const pendingTooOld = (ageMs !== null) && (ageMs > (this.inflightTtlMs * 2));
              if (ttlExceeded || pendingTooOld) {
                const retries = this.inflightRetries.get(inflightKey) || 0;
                if (retries < this.inflightMaxRetries) {
                  // Drop and retry once
                  this.inflight.delete(inflightKey);
                  this.inflightSince.delete(inflightKey);
                  this.inflightRetries.set(inflightKey, retries + 1);
                } else {
                  // Give up on this seq and fast-forward pointer to unblock
                  await this.append('ai_ctrl', { op: 'fast_forward', queue: 'tagged', seq: next });
                  this.inflight.delete(inflightKey);
                  this.inflightSince.delete(inflightKey);
                  this.inflightRetries.delete(inflightKey);
                }
              }
            } catch(_) {}
            await this.sleep(this.pollInterval);
            continue;
          }
          const item = pendingObj.value || {};
          const from = item.from;
          const prompt = item.prompt || '';
          // Only process items explicitly marked 'tagged' or 'random'
          if (item.type !== 'tagged' && item.type !== 'random') {
            await this.append('ai_ctrl', { op: 'fast_forward', queue: 'tagged', seq: next });
            await this.sleep(this.pollInterval);
            continue;
          }
          // Never react to admin (self) pending items: fast-forward pointer and skip
          // Skip self/admin pending items regardless of wallet; compare against stored admin address
          let adminAddr = null;
          try {
            adminAddr = await this.peer.protocol_instance.getSigned('admin');
          } catch(_) {}
          if (from && adminAddr && from === adminAddr) {
            await this.append('ai_ctrl', { op: 'fast_forward', queue: 'tagged', seq: next });
            await this.sleep(this.pollInterval);
            continue;
          }

          // Mark as inflight to avoid duplicate posts until contract advances process_seq
          this.inflight.add(inflightKey);
          try { this.inflightSince.set(inflightKey, Date.now()); } catch(_){}
          const inflightStart = this.inflightSince.get(inflightKey) || Date.now();
          
          // Build context
          const summaryObj = await this.peer.base.view.get('ai/summary');
          let summary = summaryObj !== null ? (summaryObj.value || '') : '';

          // Gather recent Q/A history (done items) up to historyWindow before current seq
          const historyPairs = [];
          const start = Math.max(1, next - this.historyWindow);
          for (let i = start; i < next; i++) {
            let doneObj = await this.peer.base.view.get('chat/done/' + i);
            if (!doneObj) {
              // Fallback: legacy random done storage, if any
              doneObj = await this.peer.base.view.get('chat/done_random/' + i);
            }
            if (doneObj && doneObj.value) {
              const d = doneObj.value;
              if (typeof d.prompt === 'string' && d.prompt.length > 0) {
                historyPairs.push({ role: 'user', content: d.prompt });
              }
              if (typeof d.reply === 'string' && d.reply.length > 0) {
                historyPairs.push({ role: 'assistant', content: d.reply });
              }
            }
          }

          // Compose messages with a compact system preamble, short summary, history and current prompt
          const systemPreamble = 'You are a true crypto chad who knows all ins and outs. trading, tech, everything. you are good with degens and speak their "language". respond briefly, no long explanations, keep it short. avoid dashes in responses. avoid emojis. avoid hallucinating requests that you cannot fact check via web browsing in your responses.';
          if(tokenizer.count(summary) > 512) {
            summary = summary.slice(0, 2048);
          }
          let messages = [
            { role: 'system', content: systemPreamble },
            { role: 'system', content: 'Conversation summary (compact):\n' + summary }
          ];
          messages = messages.concat(historyPairs);
          messages.push({ role: 'user', content: prompt });

          // Token budget: keep within maxContext - maxReply - headroom
          const headroom = 512;
          const countTokens = (arr) => arr.reduce((acc, m) => acc + tokenizer.count(m.content), 0);
          let total = countTokens(messages);
          const budget = this.maxContext - this.maxReply - headroom;
          if(total > budget){
            // Drop oldest history pairs until within budget
            while (total > budget && historyPairs.length > 0) {
              historyPairs.shift();
              if (historyPairs.length > 0) historyPairs.shift();
              messages = [ messages[0], messages[1] ].concat(historyPairs).concat([{ role: 'user', content: prompt }]);
              total = countTokens(messages);
            }
            // Trim summary if still too large
            if(total > budget){
              let sys = messages[1].content;
              while(total > budget && sys.length > 128){
                sys = sys.slice(0, Math.floor(sys.length * 0.8));
                messages[1].content = 'Conversation summary (compact):\n' + sys;
                total = countTokens(messages);
              }
            }
            // Finally trim the current prompt if needed
            if(total > budget){
              let up = messages[messages.length - 1].content;
              while(total > budget && up.length > 64){
                up = up.slice(0, Math.floor(up.length * 0.9));
                messages[messages.length - 1].content = up;
                total = countTokens(messages);
              }
            }
          }

          // Call local model
          // silent processing
          const headers = { 'Content-Type': 'application/json' };
          if (this.apiKey) {
            headers[this.apiKeyHeader] = (this.apiKeyHeader.toLowerCase() === 'authorization' && this.apiKeyScheme)
              ? `${this.apiKeyScheme} ${this.apiKey}`
              : this.apiKey;
          }
          let aiText = '';
          try {
            // Additional byte-size budget guard to complement token budget
            const jsonSizeOf = (obj) => { try { return JSON.stringify(obj).length } catch(_) { return Number.MAX_SAFE_INTEGER } };
            const maxJsonBytes = 256 * 1024; // ~256 KB
            // Rebuild messages with bytes budget enforcement
            const rebuild = () => [{ role: 'system', content: systemPreamble }, { role: 'system', content: messages[1].content }].concat(historyPairs).concat([{ role: 'user', content: messages[messages.length - 1].content }]);
            let msgBytesPayload = { model: this.model, messages, stream: false, max_tokens: this.maxReply, temperature: 0.7 };
            let size = jsonSizeOf(msgBytesPayload);
            if (size > maxJsonBytes) {
              // Drop history pairs first
              while (historyPairs.length > 0 && size > maxJsonBytes) {
                historyPairs.shift();
                if (historyPairs.length > 0) historyPairs.shift();
                messages = rebuild();
                msgBytesPayload = { model: this.model, messages, stream: false, max_tokens: this.maxReply, temperature: 0.7 };
                size = jsonSizeOf(msgBytesPayload);
              }
              // Trim summary aggressively if still too large
              if (size > maxJsonBytes) {
                let sys = messages[1].content;
                while (sys.length > 64 && size > maxJsonBytes) {
                  sys = sys.slice(0, Math.floor(sys.length * 0.8));
                  messages[1].content = sys;
                  msgBytesPayload = { model: this.model, messages, stream: false, max_tokens: this.maxReply, temperature: 0.7 };
                  size = jsonSizeOf(msgBytesPayload);
                }
              }
              // Trim current prompt if still too large
              if (size > maxJsonBytes) {
                let up = messages[messages.length - 1].content;
                while (up.length > 64 && size > maxJsonBytes) {
                  up = up.slice(0, Math.floor(up.length * 0.9));
                  messages[messages.length - 1].content = up;
                  msgBytesPayload = { model: this.model, messages, stream: false, max_tokens: this.maxReply, temperature: 0.7 };
                  size = jsonSizeOf(msgBytesPayload);
                }
              }
            }

            // Avoid keep-alive via header; do not pass Node agents into fetch in renderer contexts
            // Do not pass Node-specific agents into fetch to maximize compatibility across runtimes
            let agent = undefined;

            const startedAt = Date.now();
            // Helper: fetch with timeout; use AbortController when available (Node or modern runtimes), else race fallback
            const fetchWithTimeout = async (url, opts, ms) => {
              if (typeof AbortController !== 'undefined') {
                const ctrl = new AbortController();
                const id = setTimeout(() => { try { ctrl.abort(); } catch(_){} }, ms);
                try {
                  return await fetch(url, { ...opts, signal: ctrl.signal });
                } finally { clearTimeout(id); }
              } else {
                return await new Promise((resolve, reject) => {
                  const id = setTimeout(() => reject(new Error('timeout')), ms);
                  fetch(url, opts).then(r => { clearTimeout(id); resolve(r) }).catch(e => { clearTimeout(id); reject(e) });
                });
              }
            };
            let res = await fetchWithTimeout(this.endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(msgBytesPayload)
            }, this.requestTimeoutMs);
            if(res.ok){
              const data = await res.json();
              aiText = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
              this.lastCall = {
                when: startedAt,
                elapsed_ms: Date.now() - startedAt,
                status: res.status,
                ok: true,
                payload_bytes: size,
                messages_count: Array.isArray(messages) ? messages.length : null,
                history_pairs_count: Array.isArray(historyPairs) ? historyPairs.length : null
              };
              this.lastCallEndedAt = Date.now();
            } else {
              // TEMP LOG: surface reason for debugging (status + small body excerpt)
              try {
                const txt = await res.text();
                console.log('AiOracle HTTP non-OK:', res.status, (txt || '').slice(0, 200));
              } catch(_) {}
              // Retry 1–3 times with minimal context before giving up with a friendly busy message
              let success = false;
              const minimal = [
                { role: 'system', content: 'Be brief and helpful.' },
                { role: 'user', content: prompt.slice(0, 2000) }
              ];
              const withinGrace = (Date.now() - (this.lastCallEndedAt || 0)) < 5000;
              const silentStart = Date.now();
              const silentCap = 12000;
              for (let attempt = 0; attempt < 3 && !success; attempt++) {
                const startedRetry = Date.now();
                try {
                  const resMin = await fetchWithTimeout(this.endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                      model: this.model,
                      messages: minimal,
                      stream: false,
                      max_tokens: Math.min(256, this.maxReply),
                      temperature: 0.7
                    })
                  }, this.requestTimeoutMs);
                  if (resMin.ok) {
                    const data2 = await resMin.json();
                    aiText = (data2 && data2.choices && data2.choices[0] && data2.choices[0].message && data2.choices[0].message.content) || '';
                    this.lastCall = {
                      when: startedRetry,
                      elapsed_ms: Date.now() - startedRetry,
                      status: resMin.status,
                      ok: true,
                      payload_bytes: jsonSizeOf({ model: this.model, messages: minimal, stream: false, max_tokens: Math.min(256, this.maxReply), temperature: 0.7 }),
                      messages_count: minimal.length,
                      history_pairs_count: Array.isArray(historyPairs) ? historyPairs.length : null,
                      note: `retry-minimal-after-non-ok-${attempt+1}`
                    };
                    this.lastCallEndedAt = Date.now();
                    success = true;
                    break;
                  } else {
                    try { const txt2 = await resMin.text(); console.log('AiOracle HTTP retry non-OK:', resMin.status, (txt2 || '').slice(0, 200)); } catch(_) {}
                  }
                } catch(eMin) { /* ignore and continue */ }
                // Backoff more generously (e.g., 1s, 2s, 4s)
                await this.sleep(1000 * Math.pow(2, attempt));
                if (withinGrace && (Date.now() - silentStart) >= silentCap) break;
              }
              if (!success) {
                const withinWarmup = (Date.now() - inflightStart) < this.warmupGraceMs;
                if ((withinGrace && (Date.now() - silentStart) < silentCap) || withinWarmup) {
                  // Drop inflight so we immediately retry this seq on the next loop
                  this.inflight.delete(inflightKey);
                  this.inflightSince.delete(inflightKey);
                  await this.sleep(500);
                  continue; // retry same seq on next iteration
                } else {
                  aiText = 'sorry, am busy please try again';
                  this.lastCall = {
                    when: Date.now(),
                    elapsed_ms: null,
                    ok: false,
                    note: 'gave-up-after-retries-non-ok'
                  };
                  this.lastCallEndedAt = Date.now();
                }
              }
            }
          } catch(e) {
            // Transport error (endpoint down/unreachable). Retry 1–3 times with minimal context and backoff, else friendly busy message
            const headers2 = { ...headers };
            const minimal = [
              { role: 'system', content: 'Be brief and helpful.' },
              { role: 'user', content: (prompt || '').slice(0, 2000) }
            ];
            let success2 = false;
            const withinGrace2 = (Date.now() - (this.lastCallEndedAt || 0)) < 5000;
            const silentStart2 = Date.now();
            const silentCap2 = 12000;
            for (let attempt = 0; attempt < 3 && !success2; attempt++) {
              const startedRetry2 = Date.now();
              try {
                const res2 = await fetchWithTimeout(this.endpoint, {
                  method: 'POST',
                  headers: headers2,
                  body: JSON.stringify({
                    model: this.model,
                    messages: minimal,
                    stream: false,
                    max_tokens: Math.min(256, this.maxReply),
                    temperature: 0.7
                  })
                }, this.requestTimeoutMs);
                if (res2.ok) {
                  const data3 = await res2.json();
                  aiText = (data3 && data3.choices && data3.choices[0] && data3.choices[0].message && data3.choices[0].message.content) || '';
                  this.lastCall = {
                    when: startedRetry2,
                    elapsed_ms: Date.now() - startedRetry2,
                    status: res2.status,
                    ok: true,
                    payload_bytes: JSON.stringify({ model: this.model, messages: minimal, stream: false, max_tokens: Math.min(256, this.maxReply), temperature: 0.7 }).length,
                    messages_count: minimal.length,
                    history_pairs_count: Array.isArray(historyPairs) ? historyPairs.length : null,
                    note: `transport-retry-minimal-ok-${attempt+1}`
                  };
                  this.lastCallEndedAt = Date.now();
                  success2 = true;
                  break;
                }
              } catch(_) { /* ignored */ }
              await this.sleep(1000 * Math.pow(2, attempt));
              if (withinGrace2 && (Date.now() - silentStart2) >= silentCap2) break;
            }
            if (!success2) {
              const withinWarmup2 = (Date.now() - inflightStart) < this.warmupGraceMs;
              if ((withinGrace2 && (Date.now() - silentStart2) < silentCap2) || withinWarmup2) {
                // Drop inflight so we immediately retry this seq on the next loop
                this.inflight.delete(inflightKey);
                this.inflightSince.delete(inflightKey);
                await this.sleep(500);
                continue; // retry same seq on next loop
              } else {
                aiText = 'sorry, am busy please try again';
                this.lastCall = {
                  when: Date.now(),
                  elapsed_ms: null,
                  ok: false,
                  note: 'transport-exception-gave-up-after-retries'
                };
                this.lastCallEndedAt = Date.now();
              }
            }
          }

          // Post back to public chat, addressing the tagger's nick if set, else public key
          const api = this.peer.protocol_instance.api;
          let tag = from;
          try {
            const nick = await api.getNick(from, true);
            if (nick !== null && typeof nick === 'string' && nick.length > 0) tag = nick;
          } catch(_) {}
          // Avoid tagging @ai which would retrigger handlers; fallback to address if nick is 'ai'
          try {
            if (typeof tag === 'string' && tag.trim().toLowerCase() === 'ai') tag = from;
          } catch(_) {}
          // Normalize/demote mentions inside AI text to avoid double tagging
          try {
            // 1) Replace @you with 'you' (no mention)
            aiText = aiText.replace(/@you\b/gi, 'you');
            // 1b) Replace @ai with 'ai' (no mention) anywhere in generated text
            aiText = aiText.replace(/@ai\b/gi, 'ai');
            // 2) If the AI text mentions the same user again (e.g., @<tag>), drop the @ to avoid a second ping
            const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tagPattern = new RegExp('\\B@' + escapeRe(tag) + '\\b', 'gi');
            aiText = aiText.replace(tagPattern, tag);
            // 3) Demote any @<64-hex> address mentions to plain hex (avoid second pings)
            aiText = aiText.replace(/@([a-f0-9]{64})\b/gi, '$1');
          } catch(_) {}
          const mention = '@' + tag;
          // Prepare chat reply; dynamically trim if message too large per protocol cap
          let replyCandidate = typeof aiText === 'string' ? aiText : '';
          let prepared = null;
          let attempts = 0;
          const maxAttempts = 10;
          while (attempts < maxAttempts) {
            const replyText = `${mention} ${replyCandidate}`;
            try {
              prepared = api.prepareMessage(replyText, this.peer.wallet.publicKey, null, ['ai-reply']);
              break;
            } catch (e) {
              // Shrink reply by 20% (min step 200 chars) and retry
              const newLen = Math.max(0, Math.floor(replyCandidate.length * 0.8));
              const nextLen = newLen < replyCandidate.length ? newLen : Math.max(0, replyCandidate.length - 200);
              if (nextLen === replyCandidate.length || nextLen <= 0) {
                prepared = null;
                break;
              }
              replyCandidate = replyCandidate.slice(0, nextLen);
              attempts++;
            }
          }
          try {
            if (api && api.msgExposed && api.msgExposed()) {
              const nonce = api.generateNonce();
              if (prepared) {
                const signature = this.peer.wallet.sign(JSON.stringify(prepared) + nonce);
                await api.post(prepared, signature, nonce);
              } else {
                // Fallback minimal notice if we could not fit
                const tiny = api.prepareMessage(`${mention} (reply trimmed)`, this.peer.wallet.publicKey, null, ['ai-reply']);
                const signature = this.peer.wallet.sign(JSON.stringify(tiny) + nonce);
                await api.post(tiny, signature, nonce);
              }
            }
          } catch(e) {
            // If posting fails, drop inflight and skip append to avoid deadlock
            this.inflight.delete(inflightKey);
            this.inflightSince.delete(inflightKey);
            this.inflightRetries.delete(inflightKey);
            throw e;
          }

          // Update rolling summary (compact concat + trim). Summarization could be a second model call; keep it bounded.
          const newSummaryCandidate = (summary + `\nQ(${from}): ${prompt}\nA: ${aiText}`).slice(-8000);

          // Commit result through contract feature hook
          try {
            // Trim payload to reduce risk of feature size issues
            const trimmedReply = typeof aiText === 'string' ? aiText.slice(0, 2000) : '';
            const trimmedSummary = typeof newSummaryCandidate === 'string' ? newSummaryCandidate.slice(0, 2000) : '';
          await this.append('ai_result', { queue: 'tagged', seq: next, reply: trimmedReply, summary: trimmedSummary });
            // Post-append confirmation: briefly wait for process_seq to advance past this seq
            // Non-blocking safety net to help clear inflight faster on slow views
            try {
              let tries = 0;
              while (tries < 6) { // ~1.5s @ 250ms steps
                const psObj2 = await this.peer.base.view.get('process_seq');
                const ps2 = psObj2 !== null ? parseInt(psObj2.value) : 0;
                if (!isNaN(ps2) && ps2 >= next) break;
                await this.sleep(250);
                tries++;
              }
            } catch(_) {}
          } catch(e) {
            // If append fails, drop inflight so the item can be retried or fast-forwarded
            this.inflight.delete(inflightKey);
            this.inflightSince.delete(inflightKey);
            this.inflightRetries.delete(inflightKey);
            throw e;
          }

        } catch(e){
          // Log and keep loop alive
          console.log('AiOracle error:', e?.message || e);
        }
        await this.sleep(this.pollInterval);
        // Clear inflight entries that have been processed
        try {
          const ps = await this.peer.base.view.get('process_seq');
          const proc = ps !== null ? parseInt(ps.value) : 0;
          if (!isNaN(proc)) {
            for (const key of Array.from(this.inflight)) {
              const m = key.match(/^seq:(\d+)$/);
              if (m) {
                const seq = parseInt(m[1]);
                if (!isNaN(seq) && seq <= proc) {
                  this.inflight.delete(key);
                  this.inflightSince.delete(key);
                  this.inflightRetries.delete(key);
                }
              }
            }
          }
        } catch(_) {}
      }
    } finally {
      try{ tokenizer.free(); } catch(_){}
    }
  }

  async stop(options = {}) { }
}

export default AiOracle;
