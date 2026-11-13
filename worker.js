// Blobby.io rooms: one Worker + one Durable Object holding all 5 rooms.
// Each player opens ONE WebSocket; the room's first player is the host and everything is relayed through here.

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const DIFFS = ['Easy', 'Normal', 'Hard', 'Intense', 'Extreme', 'Crowded'];
const ADMIN_PASSWORD_B64 = 'cGFzc3dvcmRibG9i'; // base64 of the admin password
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blobby rooms online</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#120d24;color:#ece6ff;font-family:system-ui,sans-serif}
input,button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #3a2a61;background:#1c1536;color:#ece6ff}button{cursor:pointer;background:#ef4444;border-color:#ef4444;font-weight:700}
#msg{min-height:1.2em;color:#9d93c4;font-size:14px}</style></head><body>
<h1>Blobby rooms online</h1>
<form id="login"><input id="pw" type="password" placeholder="Password" autocomplete="off" autofocus></form>
<div id="admin" style="display:none;text-align:center"><p>Admin</p><button id="reset">Reset all rooms</button></div>
<div id="msg"></div>
<script>
const $=id=>document.getElementById(id);let pw='';
async function call(path){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({pw})});return r.ok?r.json():null}
$('login').onsubmit=async e=>{e.preventDefault();pw=$('pw').value;const r=await call('/admin');if(r&&r.ok){$('login').style.display='none';$('admin').style.display='block';$('msg').textContent=r.players+' player(s) in rooms right now'}else{$('msg').textContent='Wrong password';$('pw').value=''}};
$('reset').onclick=async()=>{if(!confirm('Kick everyone out of all rooms?'))return;const r=await call('/reset');$('msg').textContent=r&&r.ok?'Done. '+r.kicked+' player(s) sent back to the menu, all rooms are empty.':'Failed'};
</script></body></html>`;
const json = o => new Response(JSON.stringify(o), { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export class Hub {
  constructor(state) {
    this.state = state;
    this.lb = { off: [], on: [] };
    state.blockConcurrencyWhile(async () => { const d = await state.storage.get('lb'); if (d && d.off && d.on) this.lb = d; });
    this.rooms = Array.from({ length: 5 }, () => ({ settings: null, members: [], host: null }));
    this.conns = new Set();
    this.n = 0;
  }

  // Leaderboard: top 10 free-for-all scores, one list for offline and one for online.
  async addScore(m) {
    const b = m.b === 'on' ? 'on' : m.b === 'off' ? 'off' : null, score = Math.round(+m.score);
    if (!b || !(score >= 50 && score <= 1e8)) return false;
    const name = String(m.name || 'Player').replace(/[<>]/g, '').trim().slice(0, 15) || 'Player', c = m.cfg || {}, pow = {};
    for (const k of ['speed', 'shield', 'ghost', 'magnet', 'steal']) pow[k] = !c.pow || c.pow[k] !== false;
    const cfg = { map: Math.max(1, Math.min(10, Math.round(+c.map) || 3)), diff: DIFFS.includes(c.diff) ? c.diff : 'Normal', pow, vir: c.vir !== false };
    const list = this.lb[b];
    if (list.some(e => e.name === name && e.score === score)) return true;
    if (list.length >= 10 && score <= list[list.length - 1].score) return false;
    list.push({ name, score, cfg, t: Date.now() });
    list.sort((x, y) => y.score - x.score);
    this.lb[b] = list.slice(0, 10);
    await this.state.storage.put('lb', this.lb);
    return true;
  }

  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.headers.get('Upgrade') !== 'websocket') {
      const path = new URL(req.url).pathname;
      if (path === '/lb') return json(this.lb);
      if ((path === '/admin' || path === '/reset') && req.method === 'POST') {
        let pw = ''; try { pw = String(JSON.parse(await req.text()).pw || '') } catch (e) {}
        if (btoa(pw) !== ADMIN_PASSWORD_B64) return new Response('{"ok":false}', { status: 401, headers: { 'Content-Type': 'application/json' } });
        if (path === '/admin') return new Response(JSON.stringify({ ok: true, players: this.rooms.reduce((n, r) => n + r.members.length, 0) }), { headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true, kicked: this.resetRooms() }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/') return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (path === '/score' && req.method === 'POST') {
        let ok = false;
        try { const t = await req.text(); if (t.length < 2000) ok = await this.addScore(JSON.parse(t)) } catch (e) {}
        return json({ ok, lb: this.lb });
      }
      return new Response('Blobby rooms online', { status: 200, headers: CORS });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const c = { ws: server, id: 'u' + (++this.n) + Math.random().toString(36).slice(2, 6), room: -1, name: '', col: '', skin: '' };
    this.conns.add(c);
    this.send(c, this.roomsMsg());
    server.addEventListener('message', e => { try { this.onMsg(c, e.data) } catch (err) {} });
    server.addEventListener('close', () => this.drop(c));
    server.addEventListener('error', () => this.drop(c));
    return new Response(null, { status: 101, webSocket: client });
  }

  resetRooms() {
    let n = 0;
    for (const r of this.rooms) {
      const ms = r.members; r.members = []; r.settings = null; r.host = null;
      for (const c of ms) { c.room = -1; n++; this.send(c, { t: 'reset' }); try { c.ws.close(1000, 'Rooms reset') } catch (e) {} this.conns.delete(c) }
    }
    this.broadcastRooms();
    return n;
  }

  send(c, o) { try { c.ws.send(typeof o === 'string' ? o : JSON.stringify(o)) } catch (e) {} }
  roomsMsg() { return { t: 'rooms', rooms: this.rooms.map(r => ({ n: r.members.length, s: r.settings })) } }
  broadcastRooms() { for (const c of this.conns) if (c.room < 0) this.send(c, this.roomsMsg()) }
  info(c) { return { id: c.id, name: c.name, col: c.col, skin: c.skin } }

  clean(s) {
    s = s && typeof s === 'object' ? s : {};
    const pow = {};
    for (const k of ['speed', 'shield', 'ghost', 'magnet', 'steal']) pow[k] = !s.pow || s.pow[k] !== false;
    return { mode: String(s.mode || 'ffa').slice(0, 12), diff: String(s.diff || 'Normal').slice(0, 12), map: Math.max(1, Math.min(10, +s.map || 3)), pow, vir: s.vir !== false };
  }

  onMsg(c, raw) {
    if (typeof raw !== 'string' || raw.length > 1500000) return;
    // fast path: host snapshots and guest inputs are relayed without much work
    if (c.room >= 0) {
      const r = this.rooms[c.room];
      if (r.host === c && raw.startsWith('{"t":"s"')) {
        const to = raw.includes('"to":') ? JSON.parse(raw).to : null;
        for (const m of r.members) if (m !== c && (!to || m.id === to)) this.send(m, raw);
        return;
      }
      if (r.host !== c && (raw.startsWith('{"t":"in"') || raw.startsWith('{"t":"act"'))) {
        const m = JSON.parse(raw); m.from = c.id; this.send(r.host, m); return;
      }
    }
    const m = JSON.parse(raw);
    if (m.t === 'join') {
      if (c.room >= 0) return;
      const i = m.room | 0, r = this.rooms[i];
      if (!r) return;
      if (r.members.length >= 8) return this.send(c, { t: 'err', msg: 'That room is full' });
      c.name = String(m.name || 'Player').slice(0, 15);
      c.col = /^#[0-9a-f]{6}$/i.test(m.col || '') ? m.col : '#3b82f6';
      c.skin = String(m.skin || '').slice(0, 20);
      if (!r.members.length) { r.settings = this.clean(m.settings); r.host = c }
      r.members.push(c); c.room = i;
      this.send(c, { t: 'joined', room: i, id: c.id, host: r.host === c, settings: r.settings, peers: r.members.filter(x => x !== c).map(x => this.info(x)) });
      if (r.host !== c) this.send(r.host, { t: 'peer', ev: 'join', ...this.info(c) });
      this.broadcastRooms();
    }
    // 'ping' and anything else is ignored
  }

  drop(c) {
    if (!this.conns.delete(c)) return;
    if (c.room < 0) return;
    const r = this.rooms[c.room]; c.room = -1;
    r.members = r.members.filter(x => x !== c);
    if (!r.members.length) { r.settings = null; r.host = null }
    else if (r.host === c) {
      r.host = r.members[0];
      this.send(r.host, { t: 'host', peers: r.members.filter(x => x !== r.host).map(x => this.info(x)) });
      for (const x of r.members) if (x !== r.host) this.send(x, { t: 'hostchange' });
    } else this.send(r.host, { t: 'peer', ev: 'leave', id: c.id });
    this.broadcastRooms();
  }
}

export default {
  fetch(req, env) {
    if (!env.HUB) return new Response('HUB Durable Object binding missing. Deploy with wrangler.toml.', { status: 500 });
    return env.HUB.get(env.HUB.idFromName('main')).fetch(req);
  }
};
