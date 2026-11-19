// AW Tawla - static host + /api/room-compatible relay (no dependencies)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const STATIC = {
  '/': ['11-index.html', 'text/html; charset=utf-8'],
  '/index.html': ['11-index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

// ---- rooms ---------------------------------------------------------------
// room: {code, hostToken, guestToken, createdAt, lastActivity, closed,
//        queues: {host:[{id,message}], guest:[...]}, nextId: {host,guest},
//        waiters: {host:[{res,timer,after}], guest:[...]}}
const rooms = new Map();
const CODE_CHARS = 'ABCDEF0123456789';
const POLL_HOLD_MS = 10000;
const ROOM_IDLE_MS = 30 * 60 * 1000;

function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function newRoom(hostToken) {
  const code = genCode();
  const room = {
    code, hostToken, guestToken: null,
    createdAt: Date.now(), lastActivity: Date.now(), closed: false,
    queues: { host: [], guest: [] },
    nextId: { host: 1, guest: 1 },
    waiters: { host: [], guest: [] },
  };
  rooms.set(code, room);
  return room;
}

function push(room, side, message) {
  const id = room.nextId[side]++;
  room.queues[side].push({ id, message });
  const waiters = room.waiters[side].splice(0);
  for (const w of waiters) {
    clearTimeout(w.timer);
    deliver(room, side, w.after, w.res);
  }
}

function deliver(room, side, after, res) {
  const events = room.queues[side].filter(e => e.id > after);
  if (events.length) {
    const maxId = events[events.length - 1].id;
    room.queues[side] = room.queues[side].filter(e => e.id > maxId);
  }
  sendJson(res, 200, { events });
}

function sideOf(room, token) {
  if (token && token === room.hostToken) return 'host';
  if (token && token === room.guestToken) return 'guest';
  return null;
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function handleApi(req, res, url) {
  if (req.method === 'GET') {
    const code = (url.searchParams.get('room') || '').toUpperCase();
    const token = url.searchParams.get('token') || '';
    const after = Number(url.searchParams.get('after')) || 0;
    const room = rooms.get(code);
    if (!room) return sendJson(res, 403, { error: 'الأوضة اتقفلت — اعمل أوضة جديدة' });
    const side = sideOf(room, token);
    if (!side) return sendJson(res, 403, { error: 'الأوضة اتقفلت — اعمل أوضة جديدة' });
    room.lastActivity = Date.now();
    const pending = room.queues[side].some(e => e.id > after);
    if (pending) return deliver(room, side, after, res);
    if (room.closed) return sendJson(res, 403, { error: 'الأوضة اتقفلت — اعمل أوضة جديدة' });
    const timer = setTimeout(() => {
      const idx = room.waiters[side].findIndex(w => w.res === res);
      if (idx >= 0) room.waiters[side].splice(idx, 1);
      sendJson(res, 200, { events: [] });
    }, POLL_HOLD_MS);
    room.waiters[side].push({ res, timer, after });
    req.on('close', () => {
      if (res.writableEnded) return;
      clearTimeout(timer);
      const idx = room.waiters[side].findIndex(w => w.res === res);
      if (idx >= 0) room.waiters[side].splice(idx, 1);
    });
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) { req.destroy(); }
  });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'bad json' }); }
    const token = typeof msg.token === 'string' ? msg.token : '';

    if (msg.type === 'create') {
      if (!token) return sendJson(res, 400, { error: 'missing token' });
      const room = newRoom(token);
      return sendJson(res, 200, { code: room.code, messages: [{ type: 'created', code: room.code }] });
    }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.closed) {
        return sendJson(res, 200, { messages: [{ type: 'error', message: 'الكود ده مش موجود — اتأكد من الكود أو اعمل أوضة جديدة' }] });
      }
      room.lastActivity = Date.now();
      if (token && token === room.hostToken) {
        // host rejoining
        if (room.guestToken) push(room, 'host', { type: 'ready', code: room.code });
        return sendJson(res, 200, { code: room.code, messages: [{ type: 'created', code: room.code }] });
      }
      if (room.guestToken && token === room.guestToken) {
        return sendJson(res, 200, { code: room.code, messages: [{ type: 'joined', code: room.code }, { type: 'ready', code: room.code }] });
      }
      if (room.guestToken) {
        return sendJson(res, 200, { messages: [{ type: 'error', message: 'الأوضة دي مليانة — في لاعبين جواها بالفعل' }] });
      }
      room.guestToken = token;
      push(room, 'host', { type: 'ready', code: room.code });
      return sendJson(res, 200, { code: room.code, messages: [{ type: 'joined', code: room.code }, { type: 'ready', code: room.code }] });
    }

    // all other messages need an existing room + known member
    const code = (msg.room || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendJson(res, 403, { error: 'الأوضة اتقفلت — اعمل أوضة جديدة' });
    const side = sideOf(room, token);
    if (!side) return sendJson(res, 403, { error: 'الأوضة اتقفلت — اعمل أوضة جديدة' });
    room.lastActivity = Date.now();
    if (room.closed) return sendJson(res, 403, { error: 'الأوضة اتقفلت — اعمل أوضة جديدة' });

    const peer = side === 'host' ? 'guest' : 'host';
    const { type, token: _t, room: _r, ...payload } = msg;

    if (msg.type === 'leave') {
      if (room[peer + 'Token']) push(room, peer, { type: 'peer-left' });
      room.closed = true;
      return sendJson(res, 200, {});
    }
    if (room[peer + 'Token']) push(room, peer, { type, ...payload });
    return sendJson(res, 200, {});
  });
}

// ---- housekeeping ---------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.closed && now - room.lastActivity > 5 * 60 * 1000) rooms.delete(code);
    else if (now - room.lastActivity > ROOM_IDLE_MS) room.closed = true;
  }
}, 60 * 1000).unref();

// ---- http server ----------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/room') return handleApi(req, res, url);

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const entry = STATIC[url.pathname];
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  const [file, type] = entry;
  fs.readFile(path.join(ROOT, file), (err, data) => {
    if (err) { res.writeHead(500); return res.end(); }
    const headers = { 'Content-Type': type };
    headers['Cache-Control'] = file === 'index.html' || file === 'sw.js' ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, () => console.log('AW Tawla listening on ' + PORT));
