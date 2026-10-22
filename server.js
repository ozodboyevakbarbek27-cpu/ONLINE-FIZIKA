const express = require('express'), http = require('http'), crypto = require('crypto');
const path = require('path'), fs = require('fs');
const { WebSocketServer } = require('ws');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const DEV = process.env.DEV === '1';
const TEACHERS = (process.env.TEACHER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'topics.json'), 'utf8'));

function user(init) {
  if (!init) return null;
  if (DEV && init.startsWith('dev:')) {
    const [, id, name] = init.split(':');
    return { id: Number(id), first_name: name || 'Dev' };
  }
  try {
    const p = new URLSearchParams(init);
    const hash = p.get('hash'); p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const h = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (h !== hash) return null;
    return JSON.parse(p.get('user'));
  } catch { return null; }
}
const isT = u => TEACHERS.includes(String(u.id));

const app = express();
app.get('/api/me', (req, res) => {
  const u = user(req.get('x-init'));
  if (!u) return res.status(401).json({});
  res.json({ name: u.first_name, teacher: isT(u) });
});
app.get('/api/topics', (req, res) =>
  res.json(DATA.topics.map(t => ({ id: t.id, name: t.name, n: t.qs.length }))));
app.get('/api/topic/:id', (req, res) => {
  const t = DATA.topics.find(t => t.id === req.params.id);
  t ? res.json(t) : res.status(404).json({});
});
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map();
const send = (ws, o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const newCode = () => { let c; do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(c)); return c; };
const ranking = r => [...r.players.values()].sort((a, b) => b.score - a.score);

function lobby(r) {
  const names = [...r.players.values()].map(p => p.name);
  send(r.teacher, { t: 'lobby', players: names });
  r.players.forEach(p => send(p.ws, { t: 'lobby', players: names }));
}
function board(r) {
  return {
    i: r.i, total: r.qs.length, counts: r.counts,
    players: ranking(r).map(p => ({ name: p.name, score: p.score, answered: p.ans[r.i] !== undefined }))
  };
}
const qMsg = r => ({ t: 'q', i: r.i, total: r.qs.length, text: r.qs[r.i].q, o: r.qs[r.i].o, sec: r.sec });

function nextQ(r) {
  r.i++;
  if (r.i >= r.qs.length) {
    r.state = 'end';
    const rk = ranking(r).map(p => ({ name: p.name, score: p.score }));
    send(r.teacher, { t: 'end', ranking: rk });
    r.players.forEach(p => send(p.ws, { t: 'end', ranking: rk }));
    return;
  }
  r.state = 'q'; r.qStart = Date.now(); r.counts = [0, 0, 0, 0];
  send(r.teacher, qMsg(r)); r.players.forEach(p => send(p.ws, qMsg(r)));
  send(r.teacher, { t: 'board', ...board(r) });
  r.timer = setTimeout(() => endQ(r), r.sec * 1000 + 500);
}
function endQ(r) {
  if (r.state !== 'q') return;
  clearTimeout(r.timer); r.state = 'between';
  const q = r.qs[r.i];
  const rk = ranking(r);
  r.players.forEach(p => send(p.ws, {
    t: 'r', correct: q.a, e: q.e || '', gained: p.last || 0,
    score: p.score, rank: rk.indexOf(p) + 1
  }));
  send(r.teacher, { t: 'r', correct: q.a, e: q.e || '', ...board(r) });
  r.players.forEach(p => { p.last = 0; });
  r.timer = setTimeout(() => nextQ(r), 4500);
}
function answer(r, p, i, c) {
  if (!r || !p || r.state !== 'q' || i !== r.i || p.ans[i] !== undefined || !(c >= 0 && c < 4)) return;
  const q = r.qs[i], ok = c === q.a;
  const frac = Math.max(0, 1 - (Date.now() - r.qStart) / (r.sec * 1000));
  const pts = ok ? Math.round(500 + 500 * frac) : 0;
  p.ans[i] = c; p.score += pts; p.last = pts; r.counts[c]++;
  send(r.teacher, { t: 'board', ...board(r) });
  if ([...r.players.values()].every(x => x.ans[i] !== undefined)) endQ(r);
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const err = msg => send(ws, { t: 'err', msg });

    if (m.t === 'create') {
      const u = user(m.init);
      if (!u || !isT(u)) return err("Sizda ustoz huquqi yo'q");
      let qs, name;
      if (m.topic === 'all') { qs = DATA.topics.flatMap(t => t.qs); name = 'Aralash'; }
      else {
        const t = DATA.topics.find(t => t.id === m.topic);
        if (!t) return err('Mavzu topilmadi');
        qs = [...t.qs]; name = t.name;
      }
      shuffle(qs); qs = qs.slice(0, Math.min(Number(m.count) || qs.length, qs.length));
      const r = {
        code: newCode(), teacher: ws, topic: name, qs, state: 'lobby', i: -1, counts: [0, 0, 0, 0],
        sec: Math.min(60, Math.max(5, Number(m.sec) || 20)), players: new Map(), born: Date.now()
      };
      rooms.set(r.code, r); ws.room = r; ws.role = 't';
      send(ws, { t: 'created', code: r.code, total: qs.length, topic: name });
    }
    else if (m.t === 'join') {
      const u = user(m.init); if (!u) return err('Avtorizatsiya xatosi');
      const r = rooms.get(String(m.code)); if (!r) return err('Xona topilmadi');
      let p = r.players.get(u.id);
      if (!p) {
        if (r.state !== 'lobby') return err("O'yin allaqachon boshlangan");
        p = { id: u.id, name: String(u.first_name || '?').slice(0, 20), score: 0, ans: {}, last: 0 };
        r.players.set(u.id, p);
      }
      p.ws = ws; ws.room = r; ws.role = 'p'; ws.pid = u.id;
      send(ws, { t: 'joined', topic: r.topic });
      lobby(r);
      if (r.state === 'q') send(ws, qMsg(r));
    }
    else if (m.t === 'start' && ws.role === 't' && ws.room.state === 'lobby') {
      if (ws.room.players.size) nextQ(ws.room);
    }
    else if (m.t === 'a' && ws.role === 'p') {
      answer(ws.room, ws.room.players.get(ws.pid), m.i, m.c);
    }
  });
});
setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.born > 3 * 3600e3) { clearTimeout(r.timer); rooms.delete(c); } }, 600e3);

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
async function poll() {
  let off = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset: off, timeout: 30 });
      for (const u of r.result || []) {
        off = u.update_id + 1;
        if (u.message) await tg('sendMessage', {
          chat_id: u.message.chat.id,
          text: '⚡ Online fizika\n\nDarslar, testlar va ustoz bilan online o\'yin.',
          reply_markup: { inline_keyboard: [[{ text: '📚 Ochish', web_app: { url: WEBAPP_URL } }]] }
        });
      }
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
}
if (BOT_TOKEN && WEBAPP_URL) {
  tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Online fizika', web_app: { url: WEBAPP_URL } } });
  if (process.env.BOT_POLL !== '0') poll();
}

server.listen(process.env.PORT || 3000, () => console.log('Server ishga tushdi'));
