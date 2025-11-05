import {Protocol} from "trac-peer";
import fetch from 'fetch';

class AiChatProtocol extends Protocol {

    /**
     * Minimal protocol for AI chat. All behavior is driven by chat messages
     * and feature events. No custom TX mapping is required.
     */
    constructor(peer, base, options = {}) {
        super(peer, base, options);
    }

    featMaxBytes(){
        return 1_024 * 64;
    }

    msgMaxBytes(){
        return 1_024 * 64;
    }

    async extendApi() { }

    mapTxCommand(command) {
        return null;
    }

    async printOptions() {
        // TEMP DIAG commands — remove when stabilized
        console.log('- /diag_state | TEMP: print admin, time, seqs, pending, features');
        console.log('- /diag_rl [--user <address>] | TEMP: show rate-limit info for you or a user');
        console.log('- /diag_ping | TEMP: ping AI endpoint configured in the ai feature');
        console.log('- /diag_inflight | TEMP: show inflight seqs and likely blocking item');
        console.log('- /fix_fast_forward [--seq <n>] | TEMP: advance process pointer to n (admin)');
        console.log('- /diag_ai_last | TEMP: show last AI call diagnostics (oracle only)');
    }

    async customCommand(input) {
        try {
            if (typeof input !== 'string') return;
            const trimmed = input.trim();
            if (trimmed.startsWith('/diag_state')) {
                await this.#diagState();
                return;
            }
            if (trimmed.startsWith('/diag_rl')) {
                const args = this.parseArgs(trimmed);
                await this.#diagRl(args.user || this.peer.wallet.publicKey);
                return;
            }
            if (trimmed.startsWith('/diag_ping')) {
                await this.#diagPing();
                return;
            }
            if (trimmed.startsWith('/diag_inflight')) {
                await this.#diagInflight();
                return;
            }
            if (trimmed.startsWith('/diag_ai_last')) {
                await this.#diagAiLast();
                return;
            }
            if (trimmed.startsWith('/fix_fast_forward')) {
                const args = this.parseArgs(trimmed);
                await this.#fixFastForward(args);
                return;
            }
        } catch (e) {
            console.log('TEMP DIAG error:', e?.message || e);
        }
    }

    async #diagAiLast(){
        try {
            const adminObj = await this.peer.base.view.get('admin');
            const admin = adminObj ? adminObj.value : null;
            const isOraclePeer = !!admin && admin === this.peer.wallet.publicKey && !!this.peer.base.writable;
            if (!isOraclePeer) {
                console.log('TEMP DIAG ai_last: not the oracle peer (admin+writable).');
                return;
            }
            const aiFeat = this.features?.ai;
            if (!aiFeat) {
                console.log('TEMP DIAG ai_last: ai feature not loaded on this peer.');
                return;
            }
            const lc = aiFeat.lastCall || null;
            const attempts = Array.isArray(aiFeat.lastAttempts) ? aiFeat.lastAttempts : [];
            console.log('===== TEMP DIAG: AI LAST =====');
            if (!lc) {
                console.log('No AI call recorded yet.');
            } else {
                try { console.log(JSON.stringify(lc)); } catch(_) { console.log(lc); }
            }
            if (attempts.length > 0) {
                try { console.log('recent_attempts:', JSON.stringify(attempts)); } catch(_) { console.log('recent_attempts:', attempts); }
            }
            console.log('================================');
        } catch(e){
            console.log('TEMP DIAG ai_last failed:', e?.message || e);
        }
    }

    async #diagState(){
        // TEMP DIAG: quick state snapshot to debug stalls
        try {
            const me = this.peer.wallet.publicKey;
            const adminObj = await this.peer.base.view.get('admin');
            const admin = adminObj ? adminObj.value : null;
            const isAdmin = (admin && me && admin === me);
            const writable = !!this.peer.base.writable;
            const oraclePeer = !!(isAdmin && writable);
            const nowLocal = (typeof Date !== 'undefined') ? Date.now() : null;
            const ctObj = await this.peer.base.view.get('currentTime');
            const currentTime = ctObj ? ctObj.value : null;
            const ctDelta = (typeof currentTime === 'number' && typeof nowLocal === 'number') ? (nowLocal - currentTime) : null;
            const msObj = await this.peer.base.view.get('message_seq');
            const psObj = await this.peer.base.view.get('process_seq');
            const messageSeq = msObj ? parseInt(msObj.value) : 0;
            const processSeq = psObj ? parseInt(psObj.value) : 0;
            const backlog = (!isNaN(messageSeq) && !isNaN(processSeq)) ? (messageSeq - processSeq) : null;
            const next = (!isNaN(processSeq)) ? (processSeq + 1) : 0;
            const pendingObj = await this.peer.base.view.get('chat/pending/' + next);
            const pending = pendingObj ? pendingObj.value : null;
            const aiFeat = this.features?.ai;
            const chatStatusObj = await this.peer.base.view.get('chat_status');
            const chatStatus = chatStatusObj ? !!chatStatusObj.value : false;
            const autoAddObj = await this.peer.base.view.get('auto_add_writers');
            const autoAdd = autoAddObj ? !!autoAddObj.value : false;

            console.log('===== TEMP DIAG: STATE =====');
            console.log('me:', me);
            console.log('admin:', admin, '| isAdmin:', isAdmin, '| writable:', writable, '| oracle_peer:', oraclePeer);
            console.log('currentTime:', currentTime, '| delta_local_ms:', ctDelta);
            console.log('message_seq:', messageSeq, '| process_seq:', processSeq, '| backlog:', backlog);
            console.log('next_pending_key:', 'chat/pending/' + next);
            console.log('next_pending_item:', pending ? JSON.stringify({ from: pending.from, type: pending.type, ts: pending.timestamp }) : null);
            console.log('chat_status:', chatStatus, '| auto_add_writers:', autoAdd);
            console.log('features_loaded:', Object.keys(this.features || {}));
            if (aiFeat) {
                console.log('ai.endpoint:', aiFeat.endpoint, '| ai.model:', aiFeat.model);
            } else {
                console.log('ai feature not found (only admin starts features).');
            }
            console.log('============================');
        } catch(e){
            console.log('TEMP DIAG state failed:', e?.message || e);
        }
    }

    async #diagRl(address){
        // TEMP DIAG: show RL counters for a user
        try {
            const addr = address || this.peer.wallet.publicKey;
            const ctObj = await this.peer.base.view.get('currentTime');
            const currentTime = ctObj ? ctObj.value : null;
            if (typeof currentTime !== 'number'){
                console.log('TEMP DIAG RL: currentTime missing. Ensure timer feature is running on admin.');
                return;
            }
            const dayKey = Math.floor(currentTime / 86400000);
            const dailyObj = await this.peer.base.view.get('rl/day/'+addr+'/'+dayKey);
            const daily = dailyObj ? parseInt(dailyObj.value) : 0;
            const last3Obj = await this.peer.base.view.get('rl/last3/'+addr);
            const arr = (last3Obj && Array.isArray(last3Obj.value)) ? last3Obj.value : [];
            const cutoff = currentTime - 60000;
            const recent = arr.filter(ts => typeof ts === 'number' && ts >= cutoff);
            const oldestAge = recent.length > 0 ? (currentTime - recent[0]) : null;
            console.log('===== TEMP DIAG: RL =====');
            console.log('user:', addr);
            console.log('dayKey:', dayKey, '| daily_count:', isNaN(daily) ? 0 : daily);
            console.log('last60s_count:', recent.length, '| window_detail:', JSON.stringify(recent));
            console.log('oldest_age_ms:', oldestAge);
            console.log('==========================');
        } catch(e){
            console.log('TEMP DIAG rl failed:', e?.message || e);
        }
    }

    async #diagPing(){
        // TEMP DIAG: quick ping to AI endpoint
        try {
            // Only the oracle peer (admin + writable) should ever call the model endpoint.
            const adminObj = await this.peer.base.view.get('admin');
            const admin = adminObj ? adminObj.value : null;
            const isOraclePeer = !!admin && admin === this.peer.wallet.publicKey && !!this.peer.base.writable;
            if (!isOraclePeer) {
                console.log('TEMP DIAG ping: not the oracle peer (admin+writable). Endpoint calls run only on the oracle.');
                return;
            }
            const aiFeat = this.features?.ai;
            if (!aiFeat) {
                console.log('TEMP DIAG ping: ai feature not loaded on this peer (only admin starts features).');
                return;
            }
            const endpoint = aiFeat.endpoint;
            const model = aiFeat.model;
            console.log('TEMP DIAG ping (oracle):', endpoint, 'model:', model);
            const headers = { 'Content-Type': 'application/json' };
            if (aiFeat.apiKey) {
                const keyHeader = (aiFeat.apiKeyHeader || 'Authorization');
                headers[keyHeader] = (String(keyHeader).toLowerCase() === 'authorization' && aiFeat.apiKeyScheme)
                    ? `${aiFeat.apiKeyScheme} ${aiFeat.apiKey}`
                    : aiFeat.apiKey;
            }
            const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
            });
            if (res.ok) console.log('TEMP DIAG ping: OK', res.status);
            else console.log('TEMP DIAG ping: FAIL status', res.status);
        } catch(e){
            console.log('TEMP DIAG ping error:', e?.message || e);
        }
    }

    async #diagInflight(){
        // TEMP DIAG: show inflight set and identify likely blocking seq
        try {
            const aiFeat = this.features?.ai;
            if (!aiFeat) {
                console.log('TEMP DIAG inflight: ai feature not found (only admin runs features).');
                return;
            }
            const entries = Array.isArray(aiFeat.inflight) ? aiFeat.inflight : (aiFeat.inflight ? Array.from(aiFeat.inflight) : []);
            const seqs = [];
            for (const k of entries) {
                const m = /^seq:(\d+)$/.exec(String(k));
                if (m) {
                    const n = parseInt(m[1]);
                    if (!isNaN(n)) seqs.push(n);
                }
            }
            const msObj = await this.peer.base.view.get('message_seq');
            const psObj = await this.peer.base.view.get('process_seq');
            const messageSeq = msObj ? parseInt(msObj.value) : 0;
            const processSeq = psObj ? parseInt(psObj.value) : 0;
            const next = (!isNaN(processSeq)) ? (processSeq + 1) : 0;
            const backlog = (!isNaN(messageSeq) && !isNaN(processSeq)) ? (messageSeq - processSeq) : null;
            let currentTime = null;
            try { const ct = await this.peer.base.view.get('currentTime'); currentTime = ct ? ct.value : null; } catch(_){}

            // Collect details (age, pending presence) for up to the first 10 inflight seqs
            const details = [];
            const subset = seqs.sort((a,b)=>a-b).slice(0, 10);
            for (const s of subset) {
                let ageMs = null, hasPending = false, type = null;
                try {
                    const p = await this.peer.base.view.get('chat/pending/' + s);
                    if (p && p.value) {
                        hasPending = true;
                        type = p.value.type || null;
                        if (typeof currentTime === 'number' && typeof p.value.timestamp === 'number') {
                            ageMs = currentTime - p.value.timestamp;
                        }
                    }
                } catch(_){}
                details.push({ seq: s, hasPending, type, age_ms: ageMs });
            }

            const likelyBlocking = (backlog > 0 && seqs.includes(next)) ? next : null;

            console.log('===== TEMP DIAG: INFLIGHT =====');
            console.log('process_seq:', processSeq, '| message_seq:', messageSeq, '| backlog:', backlog);
            console.log('inflight_count:', seqs.length, '| inflight_seqs(sample):', subset.join(','));
            console.log('likely_blocking_seq:', likelyBlocking);
            console.log('details(sample_first_10):', JSON.stringify(details));
            console.log('================================');
        } catch(e){
            console.log('TEMP DIAG inflight failed:', e?.message || e);
        }
    }

    async #fixFastForward(args){
        // TEMP DIAG: admin-only helper to advance process pointer to unblock a stuck seq
        try {
            const admin = await this.getSigned('admin');
            if (!admin || admin !== this.peer.wallet.publicKey) {
                console.log('TEMP: fix_fast_forward requires admin on a writable peer.');
                return;
            }
            if (!this.peer.base.writable) {
                console.log('TEMP: fix_fast_forward: peer not writable.');
                return;
            }
            const msObj = await this.peer.base.view.get('message_seq');
            const psObj = await this.peer.base.view.get('process_seq');
            const ms = msObj ? parseInt(msObj.value) : 0;
            const ps = psObj ? parseInt(psObj.value) : 0;
            let seq = args && args.seq !== undefined ? parseInt(args.seq) : ms;
            if (isNaN(seq)) seq = ms;
            if (seq < 0) seq = 0;
            if (!isNaN(ms) && seq > ms) seq = ms; // clamp to tail
            if (!isNaN(ps) && seq <= ps) {
                console.log('TEMP: nothing to fast-forward. process_seq already', ps);
                return;
            }
            await this.#appendFeature('ai', 'ai_ctrl', { op: 'fast_forward', queue: 'tagged', seq });
            console.log('TEMP: fast_forward requested to seq', seq);
        } catch(e){
            console.log('TEMP DIAG fast_forward failed:', e?.message || e);
        }
    }

    async #appendFeature(featureName, key, value){
        // Low-level feature append emulation (like Feature.append)
        if(!this.peer.base.writable) throw new Error('appendFeature: base not writable');
        const nonce = this.generateNonce();
        const hash = this.peer.wallet.sign(JSON.stringify(value) + nonce);
        await this.peer.base.append({
            type: 'feature',
            key: featureName + '_' + key,
            value: {
                dispatch: {
                    type: featureName + '_feature',
                    key,
                    hash,
                    value,
                    nonce,
                    address: this.peer.wallet.publicKey
                }
            }
        });
    }
}

export default AiChatProtocol;
