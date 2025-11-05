import {Contract} from 'trac-peer'

class AiChatContract extends Contract {
    /**
     * Deterministic contract for AI chat orchestration.
     * - Processes public chat messages in order via messageHandler
     * - Enforces per-user rate limits (10 per 60s, 1500 per day)
     * - Queues allowed prompts to be handled by the AI oracle Feature
     * - Uses timer feature for currentTime
     */
    constructor(protocol, options = {}) {
        super(protocol, options);

        // Loose schema for feature entries (timer + ai oracle)
        this.addSchema('feature_entry', {
            key : { type : "string", min : 1, max: 256 },
            value : { type : "any" }
        });

        const _this = this;

        // Timer feature: maintains trusted currentTime
        this.addFeature('timer_feature', async function(){
            if(false === _this.validateSchema('feature_entry', _this.op)) return;
            if(_this.op.key === 'currentTime') {
                if(null === await _this.get('currentTime')) console.log('timer started at', _this.op.value);
                await _this.put('currentTime', _this.op.value);
            }
        });

        // AI oracle feature: commits AI results + summary updates, advances process_seq
        this.addFeature('ai_feature', async function(){
            if(false === _this.validateSchema('feature_entry', _this.op)) return;
            if(_this.op.key === 'ai_result'){
                const payload = _this.op.value;
                if(typeof payload !== 'object' || payload === null) return;
                const queue = payload.queue === 'random' ? 'random' : 'tagged';
                const seq = parseInt(payload.seq);
                if(isNaN(seq) || seq < 1) return;
                const pendingKey = queue === 'random' ? ('chat/pending_random/'+seq) : ('chat/pending/'+seq);
                const doneKey = queue === 'random' ? ('chat/done_random/'+seq) : ('chat/done/'+seq);
                const processKey = queue === 'random' ? 'random_process_seq' : 'process_seq';
                const pending = await _this.get(pendingKey);
                if(pending !== null) {
                    const done = {
                        from: pending.from,
                        prompt: pending.prompt,
                        reply: payload.reply !== undefined ? payload.reply : '',
                        timestamp: pending.timestamp
                    };
                    await _this.put(doneKey, done);
                    await _this.del(pendingKey);
                }
                if(typeof payload.summary === 'string'){
                    await _this.put('ai/summary', payload.summary);
                }
                await _this.put(processKey, seq);
            } else if(_this.op.key === 'ai_ctrl'){
                // control ops, e.g. fast-forward process pointers
                const payload = _this.op.value;
                if(typeof payload !== 'object' || payload === null) return;
                if(payload.op === 'fast_forward'){
                    const queue = payload.queue === 'random' ? 'random' : 'tagged';
                    let seq = parseInt(payload.seq);
                    if(isNaN(seq) || seq < 0) return;
                    const processKey = queue === 'random' ? 'random_process_seq' : 'process_seq';
                    const messageKey = queue === 'random' ? 'random_message_seq' : 'message_seq';
                    let current = await _this.get(processKey);
                    current = current !== null ? parseInt(current) : 0;
                    if(isNaN(current)) current = 0;
                    let maxSeq = await _this.get(messageKey);
                    maxSeq = maxSeq !== null ? parseInt(maxSeq) : 0;
                    if(isNaN(maxSeq)) maxSeq = 0;
                    if(seq > maxSeq) seq = maxSeq;
                    if(seq > current){
                        await _this.put(processKey, seq);
                    }
                }
            }
        });

        // Chat message handler: react ONLY when tagged with @ai by a non-admin user.
        // Also may enqueue occasional (random) participation into a separate queue (non-admin only, strict guards).
        this.messageHandler(async function(){
            const msg = _this.op.msg;
            if(typeof msg !== 'string') return;

            // Trusted timestamp from timer feature (if available)
            const now = await _this.get('currentTime');
            if(now !== null){
                // Store timestamp for this message index (pre-increment)
                let idx = await _this.get('msgl');
                idx = idx !== null ? parseInt(idx) : 0;
                if(isNaN(idx)) idx = 0;
                await _this.put('msgts/'+idx, now);
            }

            // Skip messages that carry an AI-reply attachment marker (AI self messages)
            if(Array.isArray(_this.op.attachments) && _this.op.attachments.indexOf('ai-reply') !== -1) return;

            const lower = msg.toLowerCase();
            const containsAi = lower.indexOf('@ai') !== -1;

            if(now === null) return; // no trusted time yet

            const addr = _this.address;
            const adminAddr = await _this.get('admin');
            const isAdmin = (adminAddr !== null && addr === adminAddr);
            // Do NOT react to messages sent by admin (prevents self loops)
            if(isAdmin) return;
            const dayKey = Math.floor(now / 86400000);

            // Apply rate limits ONLY to non-admin users
            let last3Path = null;
            let dailyPath = null;
            let last3 = [];
            let dailyCount = 0;
            if(false === isAdmin){
                // Daily limit
                dailyPath = 'rl/day/'+addr+'/'+dayKey;
                dailyCount = await _this.get(dailyPath);
                dailyCount = dailyCount !== null ? parseInt(dailyCount) : 0;
                if(isNaN(dailyCount)) dailyCount = 0;
                if(dailyCount >= 1500) return; // daily cap reached

                // 60s sliding window: last ten timestamps
                last3Path = 'rl/last3/'+addr;
                last3 = await _this.get(last3Path);
                if(false === Array.isArray(last3)) last3 = [];
                const cutoff = now - 60000;
                last3 = last3.filter(ts => typeof ts === 'number' && ts >= cutoff);
                if(last3.length >= 10) return; // rate-limited in 60s window
            }

            if(containsAi){
                // Tagged queue sequence handling
                let messageSeq = await _this.get('message_seq');
                messageSeq = messageSeq !== null ? parseInt(messageSeq) : 0;
                if(isNaN(messageSeq)) messageSeq = 0;
                const nextSeq = messageSeq + 1;

                // Extract prompt after first @ai occurrence
                const at = lower.indexOf('@ai');
                let prompt = msg.slice(at + 3).trim();
                if(prompt.startsWith(':')) prompt = prompt.slice(1).trim();
                if(prompt === '') return;

                await _this.put('chat/pending/'+nextSeq, {
                    from: addr,
                    prompt: prompt,
                    type: 'tagged',
                    timestamp: now
                });

                // Persist counters after successful enqueue (only for non-admin)
                if(false === isAdmin){
                    last3.push(now);
                    if(last3.length > 10) last3 = last3.slice(-10);
                    await _this.put(last3Path, last3);
                    await _this.put(dailyPath, dailyCount + 1);
                }
                await _this.put('message_seq', nextSeq);
            } else {
                // Random participation: only non-admin users, and only messages without mentions
                if(msg.indexOf('@') !== -1) return;

                // Deterministic selection ~1-in-20 per minute
                const minuteKey = Math.floor(now / 60000);
                let acc = 0;
                for(let i = 0; i < msg.length; i++){
                    acc = (acc + msg.charCodeAt(i)) % 0x7fffffff;
                }
                const selectionDivisor = 20;
                const selected = ((acc + minuteKey) % selectionDivisor) === 0;
                if(false === selected) return;

                // Sequence handling (global)
                let messageSeq = await _this.get('message_seq');
                messageSeq = messageSeq !== null ? parseInt(messageSeq) : 0;
                if(isNaN(messageSeq)) messageSeq = 0;
                const nextSeq = messageSeq + 1;

                await _this.put('chat/pending/'+nextSeq, {
                    from: addr,
                    prompt: msg.trim(),
                    type: 'random',
                    timestamp: now
                });

                // Persist counters after successful enqueue (only for non-admin)
                if(false === isAdmin){
                    last3.push(now);
                    if(last3.length > 10) last3 = last3.slice(-10);
                    await _this.put(last3Path, last3);
                    await _this.put(dailyPath, dailyCount + 1);
                }
                await _this.put('message_seq', nextSeq);
            }
        });
    }
}

export default AiChatContract;
