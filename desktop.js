import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { html } from 'htm/react';
import { createRoot } from 'react-dom/client';
import { app, setChatStatus, setAutoAddWriters, setNick } from "./index.js";

await app.ready();
const peer = app.getPeer();
const api = peer.protocol_instance.api;

function shortAddr(addr){
  if(!addr || typeof addr !== 'string' || addr.length < 10) return addr || '';
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function escapeHtml(str){
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(url){
  try {
    const u = new URL(url, 'http://example.local');
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.replace('http://example.local', '');
  } catch(_){}
  return null;
}

function mdToHtml(input){
  // Minimal, safe-ish markdown-like renderer: code blocks, inline code, links, bold/italic, newlines
  const placeholders = [];
  let text = String(input);
  // Extract code fences first
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    const idx = placeholders.length;
    placeholders.push('<pre><code>' + escapeHtml(code).trimEnd() + '</code></pre>');
    return `[[[CODE_BLOCK_${idx}]]]`;
  });
  // Escape remaining
  text = escapeHtml(text);
  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
  // Bold (**text**)
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic (*text*) — simple pattern to avoid ** conflict
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, url) => {
    const safe = sanitizeUrl(url);
    if (!safe) return t;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  // Newlines → <br/>
  text = text.replace(/\n/g, '<br/>');
  // Restore code blocks
  text = text.replace(/\[\[\[CODE_BLOCK_(\d+)\]\]\]/g, (_, i) => placeholders[parseInt(i)] || '');
  return text;
}

function useInterval(callback, delay) {
  const savedRef = useRef();
  useEffect(() => { savedRef.current = callback }, [callback]);
  useEffect(() => {
    if (delay == null) return;
    const id = setInterval(() => savedRef.current && savedRef.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

function usePeerState(peer){
  const [state, setState] = useState({
    loading: true,
    me: peer.wallet.publicKey,
    myNick: '',
    admin: null,
    isAdmin: false,
    writable: !!peer.base.writable,
    features: [],
    chatEnabled: false,
    autoAddWriters: false,
    messageCount: 0,
    messages: [],
    lastFetched: 0,
    diag: { process_seq: 0, message_seq: 0, backlog: 0, next_pending: null, ai: null },
    historyWindow: 64,
    extraLoaded: 0
  });

  // One-shot load
  useEffect(() => { (async () => {
    try {
      const adminVal = await api.getAdmin(true);
      const admin = typeof adminVal === 'string' ? adminVal : (adminVal?.value || null);
      const isAdmin = !!admin && admin === peer.wallet.publicKey;
      let myNick = '';
      try {
        const nickVal = await api.getNick(peer.wallet.publicKey, true);
        myNick = typeof nickVal === 'string' ? nickVal : (nickVal?.value || '');
      } catch(_){}
      const chatEnabled = await api.getChatStatus(true);
      const autoAddWriters = await api.getAutoAddWritersStatus(true);
      const features = Object.keys(peer.protocol_instance.features || {});
      setState(s => ({...s, admin, isAdmin, myNick, chatEnabled, autoAddWriters, features}));
    } catch(_){}
  })() }, []);

  // Prime data immediately on mount for faster first paint
  useEffect(() => { (async () => { try { await fetchMessages(); await refreshDiag(); } catch(_){} })() }, []);

  // Incremental message fetcher
  const fetchMessages = useCallback(async function() {
      try {
        // Prefer unsigned view for real-time updates; signed may lag slightly
        let total = await api.getMessageLength(false);
        if (total === null || typeof total === 'undefined') total = 0;
        let messageCount = parseInt(total) || 0;
        if (isNaN(messageCount)) messageCount = 0;
        // Indices are 0-based in contract storage: msg/0..msg/(msgl-1)
        const windowSize = Math.max(1, Math.min(1024, (state.historyWindow || 64) + (state.extraLoaded || 0)));
        const targetStart = Math.max(0, messageCount - windowSize);
        const current = state.messages || [];
        const have = current.length;
        const currentStart = have > 0 ? current[0].id : null;
        const currentEnd = have > 0 ? current[have - 1].id : null;

        // No change in total and start index — skip heavy work
        if (messageCount === state.lastFetched && currentStart === targetStart) {
          return;
        }

        let items = current.slice();
        // 1) Append new items if the log grew
        if (messageCount > state.lastFetched) {
          for (let i = state.lastFetched; i < messageCount; i++) {
            let m = null;
            try { m = await api.getMessage(i, false); } catch(_) { m = null }
            if (m && m.dispatch && m.dispatch.msg !== undefined) m = m.dispatch;
          if (m && m.msg !== undefined) {
            items.push({ id: i, msg: m.msg, address: m.address, attachments: m.attachments || [], ts: null });
          }
          }
        }
        // 2) Prepend older items if window expanded to the left
        if (currentStart === null || targetStart < currentStart) {
          const from = targetStart;
          const to = (currentStart === null) ? (messageCount - 1) : (currentStart - 1);
          const older = [];
          for (let i = from; i <= to; i++) {
            let m = null;
            try { m = await api.getMessage(i, false); } catch(_) { m = null }
            if (m && m.dispatch && m.dispatch.msg !== undefined) m = m.dispatch;
            if (m && m.msg !== undefined) {
              older.push({ id: i, msg: m.msg, address: m.address, attachments: m.attachments || [], ts: null });
            }
          }
          items = older.concat(items);
        }
        // 3) Trim to target window from the right if needed
        if (items.length > windowSize) {
          items = items.slice(-windowSize);
        }
        setState(s => ({...s, messageCount, messages: items, lastFetched: messageCount }));
      } catch(e){
        // ignore fetch errors to keep UI alive
      }
  }, [state.historyWindow, state.extraLoaded, state.messages, state.lastFetched]);

  // Diag snapshot (contract-specific pointers)
  const refreshDiag = useMemo(() => {
    return async function() {
      try {
        const msObj = await peer.base.view.get('message_seq');
        const psObj = await peer.base.view.get('process_seq');
        const message_seq = msObj ? parseInt(msObj.value) : 0;
        const process_seq = psObj ? parseInt(psObj.value) : 0;
        const backlog = (!isNaN(message_seq) && !isNaN(process_seq)) ? (message_seq - process_seq) : 0;
        const nextKey = 'chat/pending/' + (isNaN(process_seq) ? 0 : (process_seq + 1));
        const pendingObj = await peer.base.view.get(nextKey);
        const aiFeat = peer.protocol_instance.features?.ai;
        const ai = aiFeat ? { endpoint: aiFeat.endpoint, model: aiFeat.model } : null;
        setState(s => ({...s, diag: { process_seq, message_seq, backlog, next_pending: pendingObj?.value || null, ai } }));
      } catch(_){}
    }
  }, []);

  const refreshMyNick = useCallback(async () => {
    try {
      const nickVal = await api.getNick(peer.wallet.publicKey, true);
      const myNick = typeof nickVal === 'string' ? nickVal : (nickVal?.value || '');
      setState(s => ({ ...s, myNick }));
    } catch(_){}
  }, []);

  // Poll: messages more frequently, diagnostics less frequently
  useInterval(() => { fetchMessages(); }, 1200);
  useInterval(() => { refreshDiag(); }, 2500);

  const incWindow = (delta = 64) => setState(s => ({ ...s, extraLoaded: Math.max(0, (s.extraLoaded||0) + delta) }));
  return [state, setState, { fetchMessages, refreshDiag, incWindow, refreshMyNick }];
}

function StatusBar({ state }){
  const oraclePeer = !!(state.isAdmin && state.writable);
  const oraclesLabel = oraclePeer
    ? (state.features && state.features.length ? state.features.join(', ') + ' (local)' : 'none (local)')
    : 'none (local)';

  return html`
    <div id="header">
      <div id="details">
        <div>
          <b>Me:</b> ${shortAddr(state.me)}${state.myNick ? ` (${state.myNick})` : ''} | <b>Admin:</b> ${state.isAdmin ? 'yes' : 'no'} | <b>Writable:</b> ${state.writable ? 'yes' : 'no'}
        </div>
        <div>
          <b>Chat:</b> ${state.chatEnabled ? 'on' : 'off'} | <b>Auto-Add:</b> ${state.autoAddWriters ? 'on' : 'off'} | <b>Oracles:</b> ${oraclesLabel}
        </div>
      </div>
    </div>
  `;
}

function NickEditor({ state, actions }){
  const [nick, setNickVal] = useState(state.myNick || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { setNickVal(state.myNick || ''); }, [state.myNick]);
  const save = async () => {
    const val = (nick || '').trim();
    if (!val) { setMsg('Nick cannot be empty'); return; }
    if (val.length > 32) { setMsg('Max 32 characters'); return; }
    if (!state.chatEnabled) { setMsg('Chat is off; enable to change nick'); return; }
    try {
      setBusy(true); setMsg('');
      const escaped = val.replace(/["\\]/g, '\\$&');
      await setNick(`/set_nick --nick "${escaped}"`, actions.peer);
      await actions.refreshMyNick();
      setMsg('Saved');
    } catch(e){
      setMsg(e?.message || 'Failed');
    } finally { setBusy(false); }
  };
  return html`
    <div style=${{ margin: '.25rem 0 .75rem 0', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
      <label><b>Nickname:</b></label>
      <input value=${nick} onInput=${e => setNickVal(e.target.value)} placeholder=${'Set your display name'} maxLength=${32} style=${{ padding: '.25rem .5rem' }} />
      <button disabled=${busy || !state.chatEnabled} onClick=${save}>Save</button>
      ${msg ? html`<span style=${{ color: msg === 'Saved' ? '#6c6' : 'tomato' }}>${msg}</span>` : null}
    </div>
  `;
}

function fmtTime(ts){
  try {
    if (!ts) return '';
    const d = new Date(ts);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  } catch(_) { return '' }
}

function MessageList({ messages, nicks, renderMarkdown }){
  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const htmlCacheRef = useRef(new Map()); // id -> rendered HTML (bounded to visible messages)
  const [autoFollow, setAutoFollow] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const atBottom = (el) => (el.scrollHeight - el.scrollTop - el.clientHeight) <= 100;
  // After new messages render, if following, scroll to bottom (double RAF for layout stability)
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const doScroll = () => {
      if (autoFollow || atBottom(el)) {
        try { bottomRef.current && bottomRef.current.scrollIntoView({ block: 'end' }); } catch(_){}
        try { el.scrollTo({ top: el.scrollHeight, behavior: 'auto' }); } catch(_) { el.scrollTop = el.scrollHeight; }
        setShowNew(false);
      } else {
        setShowNew(true);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
  }, [messages.length, autoFollow]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const at = atBottom(el);
      setAutoFollow(at);
      if (at) setShowNew(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Removed IntersectionObserver to prevent renderer heap growth in long sessions.
  // Scroll listener + resize handler cover auto-follow behavior sufficiently.

  // On window resize, if following (or already at bottom), re-scroll to sentinel
  useEffect(() => {
    const handler = () => {
      const el = listRef.current;
      if (!el) return;
      if (autoFollow || atBottom(el)) {
        requestAnimationFrame(() => {
          try { bottomRef.current && bottomRef.current.scrollIntoView({ block: 'end' }); } catch(_){}
          try { el.scrollTo({ top: el.scrollHeight, behavior: 'auto' }); } catch(_) { el.scrollTop = el.scrollHeight; }
        })
      }
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [autoFollow]);
  // Prune HTML cache to current message ids
  useEffect(() => {
    try {
      const ids = new Set(messages.map(m => m.id));
      for (const key of Array.from(htmlCacheRef.current.keys())) {
        if (!ids.has(key)) htmlCacheRef.current.delete(key);
      }
      if (htmlCacheRef.current.size > 320) {
        const toDrop = htmlCacheRef.current.size - 256;
        let dropped = 0;
        for (const key of htmlCacheRef.current.keys()) { htmlCacheRef.current.delete(key); if (++dropped >= toDrop) break; }
      }
    } catch(_){}
  }, [messages]);
  const jump = () => {
    const el = listRef.current;
    if (!el) return;
    try { bottomRef.current && bottomRef.current.scrollIntoView(false); } catch(_){}
    el.scrollTop = el.scrollHeight;
    setAutoFollow(true);
    setShowNew(false);
  };
  return html`
    <div style=${{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div id="messages" ref=${listRef} style=${{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        ${messages.map(item => html`
          <div key=${item.id} style=${{ marginBottom: '.5rem' }}>
            <div style=${{ color: '#8ad94f' }}>
              ${nicks[item.address] || shortAddr(item.address)}
              ${item.ts ? html`<span style=${{ color: '#7aa93f', marginLeft: '.5rem' }}>[${fmtTime(item.ts)}]</span>` : null}
            </div>
            ${renderMarkdown
              ? html`<div dangerouslySetInnerHTML=${{ __html: (function(){ const c = htmlCacheRef.current; if (c.has(item.id)) return c.get(item.id); const v = mdToHtml(item.msg); c.set(item.id, v); return v; })() }} />`
              : html`<div style=${{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>${item.msg}</div>`}
          </div>
        `)}
        <div ref=${bottomRef} style=${{ height: '1px' }}></div>
      </div>
      ${showNew ? html`
        <button onClick=${jump} style=${{
          position: 'absolute', right: '.5rem', bottom: '.5rem',
          background: '#0a0', color: '#fff', borderColor: '#0a0'
        }}>New messages ↓</button>` : null}
    </div>
  `;
}

function Composer({ onSend, disabled }){
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const taRef = useRef(null);
  const send = async () => {
    if (!text.trim()) return;
    try {
      setError('');
      await onSend(text);
      setText('');
      taRef.current && taRef.current.focus();
    } catch(e){
      setError(e?.message || 'Send failed');
    }
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  return html`
    <div id="message-form">
      <textarea id="message" rows="2" value=${text} ref=${taRef}
        onInput=${e => setText(e.target.value)} onKeyDown=${onKeyDown}
        placeholder=${'Type a message. Use @ai to ask the bot.'} style=${{ padding: '.5rem', fontFamily: 'monospace' }} />
      <button onClick=${send} disabled=${disabled} style=${{ marginLeft: '.5rem' }}>Send</button>
      ${error ? html`<div style=${{ color: 'tomato', marginLeft: '.5rem' }}>${error}</div>` : null}
    </div>
  `;
}

function AdminPanel({ state, actions }){
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!state.isAdmin || !state.writable) return null;
  const toggleChat = async (enabled) => {
    try { setBusy(true); setErr(''); await setChatStatus(`/set_chat_status --enabled ${enabled ? 1 : 0}`, actions.peer); actions.refresh(); }
    catch(e){ setErr(e?.message || 'toggle failed') } finally { setBusy(false) }
  };
  const toggleAutoAdd = async (enabled) => {
    try { setBusy(true); setErr(''); await setAutoAddWriters(`/set_auto_add_writers --enabled ${enabled ? 1 : 0}`, actions.peer); actions.refresh(); }
    catch(e){ setErr(e?.message || 'toggle failed') } finally { setBusy(false) }
  };
  return html`
    <div style=${{ marginBottom: '.5rem', display: 'flex', gap: '.5rem', alignItems: 'center' }}>
      <b>Admin</b>
      <button disabled=${busy} onClick=${() => toggleChat(!state.chatEnabled)}>
        ${state.chatEnabled ? 'Disable Chat' : 'Enable Chat'}
      </button>
      <button disabled=${busy} onClick=${() => toggleAutoAdd(!state.autoAddWriters)}>
        ${state.autoAddWriters ? 'Disable Auto-Add' : 'Enable Auto-Add'}
      </button>
      ${err ? html`<span style=${{ color: 'tomato' }}>${err}</span>` : null}
    </div>
  `;
}

function DiagPane({ state, onRefresh }){
  return html`
    <div style=${{ marginTop: '.5rem', paddingTop: '.5rem', borderTop: '1px dashed #2a2', paddingBottom: '.75rem' }}>
      <div><b>Backlog:</b> ${state.diag.backlog} (msg_seq=${state.diag.message_seq}, proc_seq=${state.diag.process_seq})</div>
      <div><b>Next pending:</b> ${state.diag.next_pending ? JSON.stringify({ from: state.diag.next_pending.from, type: state.diag.next_pending.type }) : 'none'}</div>
      <div><b>AI:</b> ${state.diag.ai ? `${state.diag.ai.model} @ ${state.diag.ai.endpoint}` : 'feature not running on this peer'}</div>
      <button title="Refresh diagnostics and chat counters" style=${{ marginTop: '.25rem' }} onClick=${onRefresh}>Refresh</button>
    </div>
  `;
}

function ChatApp(){
  const [state, setState, fns] = usePeerState(peer);
  const [nicks, setNicks] = useState({});
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const nickCacheRef = useRef(new Map()); // address -> nick (bounded cache)

  // Resolve nicks for visible messages, with caching to avoid repeated gets
  useEffect(() => { (async () => {
    try {
      const cache = nickCacheRef.current;
      const addrs = [];
      for (const m of state.messages) {
        if (typeof m.address === 'string') addrs.push(m.address);
      }
      // Unique current addresses
      const uniq = Array.from(new Set(addrs));
      // Fetch only for addresses not in cache
      const missing = uniq.filter(a => !cache.has(a));
      if (missing.length > 0) {
        for (const a of missing) {
          try {
            const res = await api.getNick(a, true);
            const nick = typeof res === 'string' ? res : (res && res.value ? res.value : '');
            if (nick) cache.set(a, nick);
            else cache.set(a, '');
            // Bound cache size to avoid unbounded growth (simple FIFO discard)
            if (cache.size > 512) {
              const firstKey = cache.keys().next().value;
              cache.delete(firstKey);
            }
          } catch(_) { cache.set(a, ''); }
        }
      }
      // Build map only for visible messages from cache
      const visible = {};
      for (const a of uniq) { if (cache.has(a) && cache.get(a)) visible[a] = cache.get(a); }
      setNicks(visible);
    } catch(_){}
  })() }, [state.messages.length]);

  async function sendMessage(text){
    if (!api || !api.msgExposed || !api.msgExposed()) throw new Error('Messaging API not exposed.');
    const prepared = api.prepareMessage(text, peer.wallet.publicKey, null, []);
    const nonce = api.generateNonce();
    const signature = peer.wallet.sign(JSON.stringify(prepared) + nonce);
    try {
      await api.post(prepared, signature, nonce);
    } catch(e) {
      console.log('Desktop post failed:', e?.message || e);
      throw e;
    }
  }


  const refreshAll = async () => {
    await Promise.all([fns.fetchMessages(), fns.refreshDiag()]);
  };

  return html`
    <div id="chat">
      ${html`<${StatusBar} state=${state} />`}
      ${html`<${NickEditor} state=${state} actions=${{ peer, refreshMyNick: fns.refreshMyNick }} />`}
      ${html`<${AdminPanel} state=${state} actions=${{ peer, refresh: refreshAll }} />`}
      <div style=${{ marginBottom: '.5rem' }}>
        <button onClick=${async () => { fns.incWindow(64); await fns.fetchMessages(); }} title="Load older messages">Load older</button>
      </div>
      ${html`<${MessageList} messages=${state.messages} nicks=${nicks} renderMarkdown=${renderMarkdown} />`}
      ${html`<${Composer} onSend=${sendMessage} disabled=${false} />`}
      ${html`<${DiagPane} state=${state} onRefresh=${async () => { await Promise.all([fns.refreshDiag(), fns.fetchMessages()]); }} />`}
      <div style=${{ marginTop: '.25rem', marginBottom: '1rem', fontSize: '.9rem' }}>
        <label><input type="checkbox" checked=${renderMarkdown} onChange=${e => setRenderMarkdown(e.target.checked)} /> Render Markdown</label>
      </div>
    </div>
  `;
}

// Mount React app
const root = createRoot(document.querySelector('#root'))
root.render(html`<${ChatApp} />`)
