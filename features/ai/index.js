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
    this.inflight = new Set();
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
          const systemPreamble = 'You are a true crypto chad who knows all ins and outs. trading, tech, everything. you are good with degens and speak their "language". respond briefly and longer if required but not overly excessive. avoid dashes in responses. avoid emojis. avoid hallucinating requests that you cannot fact check via web browsing in your responses.';
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
            const res = await fetch(this.endpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                model: this.model,
                messages,
                stream: false,
                max_tokens: this.maxReply,
                temperature: 0.7
              })
            });
            if(res.ok){
              const data = await res.json();
              aiText = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
            } else {
              aiText = 'Sorry, the AI endpoint failed.';
            }
          } catch(e) {
            // On fetch/HTTP error, drop inflight to avoid indefinite skipping and continue loop
            this.inflight.delete(inflightKey);
            throw e;
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
          } catch(e) {
            // If append fails, drop inflight so the item can be retried or fast-forwarded
            this.inflight.delete(inflightKey);
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
                if (!isNaN(seq) && seq <= proc) this.inflight.delete(key);
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
