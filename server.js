/* RNX CODE online server — Node.js 18+, no dependencies.
 * Serves the app and runs every online game on the server, so hidden numbers never reach other players.
 * Real-time updates: Server-Sent Events (GET /api/stream). Actions: POST /api/*. */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const RNX = require("./engine.js");

const PORT = +process.env.PORT || 3000;
const PUB = __dirname;
const FILES = new Set(["index.html", "app.js", "engine.js", "logo-v.jpg", "logo-h.jpg"]); // only these are served
const MAX_ROOMS = 500;
const GRACE_MS = +process.env.GRACE_MS || 25000;          // time a player may be disconnected before the computer takes over
const ROOM_IDLE_MS = 10 * 60000; // empty rooms are removed after this
const rooms = new Map();

const token = () => crypto.randomBytes(16).toString("hex");
const cleanName = s => String(s || "").replace(/[\u0000-\u001f\u007f<>"'`]/g, "").trim().slice(0, 12) || "손님";
const LV = ["쉬움", "보통", "어려움"];

function newCode() {
  for (let i = 0; i < 100; i++) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!rooms.has(c)) return c; }
  return null;
}
function makeSeat(name, type, level) {
  return { token: type === "com" ? null : token(), name, origName: name, type, level: level ?? 1, conns: new Set(), host: false, auto: false, graceT: null };
}
const seatIndex = (room, tok) => (tok ? room.seats.findIndex(s => s.token === tok) : -1);
const isOnline = s => s.type === "com" || s.conns.size > 0;

function ensureHost(room) {
  const cur = room.seats.find(s => s.host && s.token && !s.auto && s.conns.size > 0);
  if (cur) return;
  room.seats.forEach(s => (s.host = false));
  const next = room.seats.find(s => s.token && s.conns.size > 0 && !s.auto) || room.seats.find(s => s.token && !s.auto);
  if (next) next.host = true;
}

/* ---------- messages ---------- */
function msgFor(room, idx) {
  const you = idx, seat = room.seats[idx];
  const base = { code: room.code, you, host: !!(seat && seat.host), hostSeat: room.seats.findIndex(s => s.host), online: room.seats.map(isOnline) };
  if (!room.G) {
    return Object.assign(base, {
      kind: "lobby", set: room.set,
      seats: room.seats.map(s => ({ name: s.name, type: s.type, level: s.level, online: isOnline(s), host: s.host }))
    });
  }
  return Object.assign(base, { kind: "game", view: RNX.view(room.G, idx) });
}
function send(res, obj) { if (res.writableEnded || res.destroyed) return; try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) { /* closed */ } }
function closeAll(set, lastMsg) { const cs = [...set]; set.clear(); cs.forEach(r => { if (lastMsg) send(r, lastMsg); try { r.end(); } catch (e) {} }); }
function broadcast(room) {
  room.touched = Date.now();
  room.seats.forEach((s, i) => { if (s.conns.size) { const m = msgFor(room, i); s.conns.forEach(r => send(r, m)); } });
  if (room.spect.size) { const m = msgFor(room, -1); room.spect.forEach(sp => sp.conns.forEach(r => send(r, m))); }
}
function scheduleCom(room) {
  clearTimeout(room.comT);
  const G = room.G;
  if (!G || G.phase === "over" || G.players[G.turn].type !== "com") return;
  room.comT = setTimeout(() => {
    if (room.G !== G || G.phase === "over" || G.players[G.turn].type !== "com") return;
    const a = RNX.comChoose(G, G.turn);
    if (a && RNX.act(G, G.turn, a)) changed(room);
  }, G.phase === "guess" ? 1300 : 900);
}
function changed(room) { broadcast(room); scheduleCom(room); }

/* a human seat is handed to the computer (or removed while still in the lobby) */
function goOffline(room, tok, left) {
  const idx = seatIndex(room, tok); if (idx < 0) return;
  const s = room.seats[idx];
  if (!left && s.conns.size) return;
  if (!room.G) { room.seats.splice(idx, 1); ensureHost(room); broadcast(room); return; }
  const p = room.G.players[idx];
  if (p.type !== "com" && room.G.phase !== "over") {
    s.auto = true; s.type = "com"; p.type = "com"; p.level = 1;
    p.name = s.name = s.origName + " (컴퓨터)";
    RNX.log(room.G, `${s.origName} 연결 끊김 · 컴퓨터가 대신합니다`);
  }
  if (left) s.token = null;
  ensureHost(room); changed(room);
}
function comeBack(room, idx) {
  const s = room.seats[idx];
  if (!s.auto || !room.G) return;
  s.auto = false; s.type = "human"; s.name = s.origName;
  const p = room.G.players[idx]; p.type = "human"; p.name = s.origName;
  RNX.log(room.G, `${s.origName} 다시 연결됨`);
}

/* ---------- http helpers ---------- */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 8192) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
function serveStatic(req, res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!FILES.has(name)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
  const file = path.join(PUB, name);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": ext === ".html" || ext === ".js" ? "no-cache" : "public, max-age=86400" });
    res.end(buf);
  });
}

/* ---------- API ---------- */
async function api(req, res, pathname, query) {
  if (pathname === "/api/stream" && req.method === "GET") return stream(req, res, query);
  if (req.method !== "POST") return json(res, 405, { ok: false });
  if (pathname === "/api/ping") return json(res, 200, { ok: true }); // keeps free hosting awake during games
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: "요청 형식이 올바르지 않습니다." }); }

  if (pathname === "/api/create") {
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { ok: false, error: "지금은 방이 가득 찼습니다. 잠시 후 다시 시도해 주세요." });
    const code = newCode(); if (!code) return json(res, 503, { ok: false, error: "방 코드를 만들 수 없습니다." });
    const s = makeSeat(cleanName(body.name), "human"); s.host = true;
    const room = { code, seats: [s], spect: new Map(), set: { start: "auto", reveal: true }, G: null, comT: null, touched: Date.now() };
    rooms.set(code, room);
    return json(res, 200, { ok: true, code, token: s.token });
  }

  const room = rooms.get(String(body.code || ""));
  if (!room) return json(res, 404, { ok: false, error: "방을 찾을 수 없습니다. 코드를 확인해 주세요." });

  if (pathname === "/api/join") {
    const name = cleanName(body.name);
    if (!room.G && room.seats.length < 4) {
      const s = makeSeat(name, "human"); room.seats.push(s); ensureHost(room); broadcast(room);
      return json(res, 200, { ok: true, code: room.code, token: s.token });
    }
    if (room.spect.size >= 20) return json(res, 409, { ok: false, error: "관전 인원이 가득 찼습니다." });
    const t = token(); room.spect.set(t, { name, conns: new Set() });
    return json(res, 200, { ok: true, code: room.code, token: t, spectator: true, note: room.G ? "게임이 이미 시작되어 관전으로 들어갑니다." : "자리가 가득 차 관전으로 들어갑니다." });
  }

  if (pathname === "/api/act") {
    const tok = String(body.token || ""), a = body.a || {};
    const idx = seatIndex(room, tok);
    if (idx < 0) {
      if (room.spect.has(tok) && a.k === "leave") { closeAll(room.spect.get(tok).conns); room.spect.delete(tok); return json(res, 200, { ok: true }); }
      return json(res, 403, { ok: false, error: "이 방의 참가자가 아닙니다." });
    }
    const s = room.seats[idx], G = room.G, k = String(a.k || "");
    const hostOnly = ["addCom", "remove", "settings", "start", "restart"];
    if (hostOnly.includes(k) && !s.host) return json(res, 403, { ok: false, error: "방장만 할 수 있습니다." });

    switch (k) {
      case "leave":
        closeAll(s.conns); goOffline(room, tok, true); return json(res, 200, { ok: true });
      case "addCom": {
        if (G || room.seats.length >= 4) return json(res, 409, { ok: false, error: "더 추가할 수 없습니다." });
        const lv = Math.max(0, Math.min(2, a.level | 0));
        const n = room.seats.filter(x => x.type === "com").length + 1;
        room.seats.push(makeSeat(`컴퓨터 ${n}`, "com", lv)); broadcast(room); return json(res, 200, { ok: true });
      }
      case "remove": {
        const j = a.seat | 0;
        if (G || j <= 0 || j >= room.seats.length || j === idx) return json(res, 409, { ok: false, error: "뺄 수 없는 자리입니다." });
        const r = room.seats.splice(j, 1)[0]; closeAll(r.conns, { kind: "gone", reason: "방장이 자리를 정리했습니다." });
        broadcast(room); return json(res, 200, { ok: true });
      }
      case "settings":
        if (G) return json(res, 409, { ok: false });
        if (["auto", "3", "4", "5"].includes(String(a.start))) room.set.start = String(a.start);
        if (typeof a.reveal === "boolean") room.set.reveal = a.reveal;
        broadcast(room); return json(res, 200, { ok: true });
      case "start":
      case "restart":
        if ((k === "start" && G) || (k === "restart" && (!G || G.phase !== "over"))) return json(res, 409, { ok: false, error: "지금은 시작할 수 없습니다." });
        if (room.seats.length < 2) return json(res, 409, { ok: false, error: "2명 이상이 있어야 시작할 수 있습니다." });
        room.G = RNX.newGame(room.seats.map(x => ({ name: x.name, type: x.type, level: x.level })), room.set);
        changed(room); return json(res, 200, { ok: true });
      case "guess": case "go": case "stop": case "reveal": {
        if (!G) return json(res, 409, { ok: false, error: "게임이 시작되지 않았습니다." });
        const clean = { k, t: a.t | 0, i: a.i | 0, n: a.n | 0 };
        if (!RNX.act(G, idx, clean)) return json(res, 409, { ok: false, error: "지금은 할 수 없는 동작입니다." });
        changed(room); return json(res, 200, { ok: true });
      }
    }
    return json(res, 400, { ok: false, error: "알 수 없는 동작입니다." });
  }
  return json(res, 404, { ok: false });
}

function stream(req, res, q) {
  const room = rooms.get(String(q.get("code") || ""));
  const tok = String(q.get("token") || "");
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.on("error", () => {});
  res.write("retry: 2000\n\n");
  const idx = room ? seatIndex(room, tok) : -1;
  const sp = room && idx < 0 ? room.spect.get(tok) : null;
  if (!room || (idx < 0 && !sp)) { send(res, { kind: "gone", reason: "방이 끝났거나 연결 정보가 만료되었습니다." }); return res.end(); }
  if (sp) {
    sp.conns.add(res); send(res, msgFor(room, -1));
    req.on("close", () => sp.conns.delete(res));
    return;
  }
  const s = room.seats[idx];
  clearTimeout(s.graceT);
  const wasOffline = s.conns.size === 0;
  s.conns.add(res);
  comeBack(room, idx);
  ensureHost(room);
  if (wasOffline) changed(room); else send(res, msgFor(room, idx));
  req.on("close", () => {
    s.conns.delete(res);
    if (s.conns.size === 0 && s.token) {
      broadcast(room);
      s.graceT = setTimeout(() => goOffline(room, s.token, false), GRACE_MS);
    }
  });
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
  if (u.pathname.startsWith("/api/")) return api(req, res, u.pathname, u.searchParams).catch(e => { console.error(e); try { json(res, 500, { ok: false, error: "서버 오류가 발생했습니다." }); } catch (_) {} });
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
  serveStatic(req, res, u.pathname);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0; // event streams stay open

// keep event streams alive through proxies, and clean up empty rooms
setInterval(() => {
  for (const room of rooms.values()) {
    const ping = r => { if (!r.writableEnded && !r.destroyed) try { r.write(": ping\n\n"); } catch (e) {} };
    room.seats.forEach(s => s.conns.forEach(ping));
    room.spect.forEach(sp => sp.conns.forEach(ping));
  }
}, 20000);
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.seats.some(s => s.conns.size) || [...room.spect.values()].some(sp => sp.conns.size);
    if (!anyone && now - room.touched > ROOM_IDLE_MS) { clearTimeout(room.comT); rooms.delete(code); }
  }
}, 60000);

process.on("uncaughtException", e => console.error("[uncaught]", e));
process.on("unhandledRejection", e => console.error("[unhandled]", e));

server.listen(PORT, () => console.log(`RNX CODE server on http://localhost:${PORT}`));
