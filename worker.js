// Blobby.io rooms: one Worker + one Durable Object holding all 5 rooms.
// Each player opens ONE WebSocket; the room's first player is the host and everything is relayed through here.

export class Hub {
  constructor() {
    this.rooms = Array.from({ length: 5 }, () => ({ settings: null, members: [], host: null }));
    this.conns = new Set();
    this.n = 0;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Blobby rooms online', { status: 200 });
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
