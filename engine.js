/* RNX CODE game engine — shared by the browser (window.RNX) and the Node server (require). */
(function (RNX) {
  "use strict";
  const CN = { b: "검정", w: "흰" };
  const numOf = id => +id.slice(1);
  const keyOf = id => numOf(id) * 2 + (id[0] === "w" ? 1 : 0); // same number: black left of white
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random() * a.length)];

  /* ---------- game state ---------- */
  function newGame(players, set) {
    const pile = [];
    for (const c of "bw") for (let n = 0; n < 12; n++) pile.push(c + n);
    shuffle(pile);
    const per = set.start === "auto" || !set.start ? (players.length <= 3 ? 4 : 3) : Math.max(3, Math.min(5, +set.start));
    const ps = players.map(p => ({ name: p.name, type: p.type === "com" ? "com" : "human", level: p.level ?? 1, tiles: [], out: false }));
    for (const p of ps) { for (let i = 0; i < per; i++) p.tiles.push({ id: pile.pop(), up: false, x: [] }); sortHand(p); }
    const G = { seq: 0, players: ps, pile, turn: Math.floor(Math.random() * ps.length), phase: "guess", drawn: null, ev: null, log: [], winner: -1, set: { reveal: set.reveal !== false } };
    log(G, `게임 시작 · ${ps.length}명 · 각자 ${per}장`);
    startTurn(G);
    return G;
  }
  function sortHand(p) { p.tiles.sort((a, b) => keyOf(a.id) - keyOf(b.id)); }
  function insertTile(p, t) { p.tiles.push(t); sortHand(p); }
  function log(G, s) { G.log.push(s); if (G.log.length > 60) G.log.shift(); }
  const hiddenCount = p => p.tiles.filter(t => !t.up).length;
  function startTurn(G) {
    G.drawn = G.pile.length ? { id: G.pile.pop(), up: false, x: [] } : null;
    G.phase = "guess";
    log(G, `${G.players[G.turn].name} 차례${G.drawn ? "" : " (더미 없음)"}`);
  }
  function checkWin(G) {
    const alive = G.players.map((p, i) => (p.out ? -1 : i)).filter(i => i >= 0);
    if (alive.length > 1) return false;
    if (G.drawn) { insertTile(G.players[G.turn], G.drawn); G.drawn = null; }
    G.phase = "over"; G.winner = alive.length ? alive[0] : -1;
    if (G.winner >= 0) log(G, `${G.players[G.winner].name} 승리`);
    return true;
  }
  function endTurn(G) {
    if (checkWin(G)) return;
    let t = G.turn;
    do { t = (t + 1) % G.players.length; } while (G.players[t].out);
    G.turn = t; startTurn(G);
  }

  /* action: {k:"guess",t,i,n} | {k:"go"} | {k:"stop"} | {k:"reveal",i}  (t = player index, i = tile position) */
  function act(G, seat, a) {
    if (!G || !a || G.phase === "over" || seat !== G.turn) return false;
    const me = G.players[seat];
    if (a.k === "guess" && G.phase === "guess") {
      const t = a.t | 0, i = a.i | 0, n = a.n | 0;
      const tp = G.players[t];
      if (!tp || t === seat || tp.out || !(n >= 0 && n <= 11)) return false;
      const tile = tp.tiles[i];
      if (!tile || tile.up) return false;
      const ok = numOf(tile.id) === n;
      G.ev = { seq: ++G.seq, by: seat, t, id: tile.id, n, ok };
      const where = `${tp.name} ${i + 1}번째 ${CN[tile.id[0]]} 타일 ${n}`;
      if (ok) {
        tile.up = true; log(G, `${me.name} → ${where} · 정답`);
        if (hiddenCount(tp) === 0) { tp.out = true; log(G, `${tp.name} 탈락`); }
        if (checkWin(G)) return true;
        G.phase = "decide";
      } else {
        if (!tile.x.includes(n)) tile.x.push(n);
        log(G, `${me.name} → ${where} · 오답`);
        if (G.drawn) { G.drawn.up = G.set.reveal; insertTile(me, G.drawn); G.ev.add = G.drawn.id; G.drawn = null; endTurn(G); }
        else G.phase = "penalty";
      }
      return true;
    }
    if (a.k === "go" && G.phase === "decide") { G.phase = "guess"; return true; }
    if (a.k === "stop" && G.phase === "decide") {
      G.ev = { seq: ++G.seq, by: seat, stop: true };
      if (G.drawn) { insertTile(me, G.drawn); G.ev.add = G.drawn.id; G.drawn = null; }
      log(G, `${me.name} 멈춤`); endTurn(G); return true;
    }
    if (a.k === "reveal" && G.phase === "penalty") {
      const tile = me.tiles[a.i | 0];
      if (!tile || tile.up) return false;
      tile.up = true; G.ev = { seq: ++G.seq, by: seat, self: tile.id };
      log(G, `${me.name} 자기 타일 ${numOf(tile.id)} 공개`);
      if (hiddenCount(me) === 0) { me.out = true; log(G, `${me.name} 탈락`); }
      endTurn(G); return true;
    }
    return false;
  }

  /* ---------- per-viewer view: hidden numbers never leave the server ---------- */
  // me: seat index of the viewer, -1 = nobody (spectator / covered screen)
  function view(G, me) {
    const reveal = G.phase === "over";
    const posOf = (pi, id) => (G.players[pi] ? G.players[pi].tiles.findIndex(t => t.id === id) : -1);
    const players = G.players.map((p, pi) => ({
      name: p.name, type: p.type, level: p.level, out: p.out,
      tiles: p.tiles.map(t => ({ c: t.id[0], n: t.up || reveal || pi === me ? numOf(t.id) : null, up: t.up, x: t.x.slice() }))
    }));
    let drawn = null;
    if (G.drawn) drawn = { c: G.drawn.id[0], n: me === G.turn || reveal ? numOf(G.drawn.id) : null };
    let ev = null;
    if (G.ev) {
      const e = G.ev;
      ev = { seq: e.seq, by: e.by };
      if (e.id) { ev.t = e.t; ev.pos = posOf(e.t, e.id); ev.c = e.id[0]; ev.n = e.n; ev.ok = e.ok; }
      if (e.stop) ev.stop = true;
      if (e.self) ev.self = { pos: posOf(e.by, e.self), n: numOf(e.self) };
      if (e.add) ev.add = { pos: posOf(e.by, e.add) };
    }
    return { me, seq: G.seq, turn: G.turn, phase: G.phase, winner: G.winner, pileN: G.pile.length, set: { reveal: G.set.reveal }, players, drawn, ev, log: G.log.slice(-40) };
  }

  /* ---------- deduction from a view ---------- */
  // returns C[playerIndex][tileIndex] = possible numbers, for tiles whose number the viewer does not know
  function deduce(V, level) {
    const known = new Set();
    V.players.forEach(p => p.tiles.forEach(t => { if (t.n != null) known.add(t.c + t.n); }));
    if (V.drawn && V.drawn.n != null) known.add(V.drawn.c + V.drawn.n);
    const hands = [];
    V.players.forEach((p, pi) => {
      const items = p.tiles.map((t, ti) => {
        if (t.n != null) return { pi, ti, fixed: true, S: [t.n * 2 + (t.c === "w" ? 1 : 0)] };
        const S = [];
        for (let n = 0; n < 12; n++) {
          if (known.has(t.c + n)) continue;
          if (level > 0 && t.x.includes(n)) continue;
          S.push(n * 2 + (t.c === "w" ? 1 : 0));
        }
        return { pi, ti, fixed: false, S };
      });
      hands.push(items);
    });
    const prop = items => {
      for (let r = 0; r < 3; r++) {
        let lo = -1;
        for (const it of items) { const f = it.S.filter(k => k > lo); if (f.length) it.S = f; lo = Math.min(...it.S); }
        let hi = 99;
        for (let i = items.length - 1; i >= 0; i--) { const it = items[i]; const f = it.S.filter(k => k < hi); if (f.length) it.S = f; hi = Math.max(...it.S); }
      }
    };
    hands.forEach(prop);
    if (level >= 2) {
      for (let r = 0; r < 8; r++) {
        let changed = false;
        const open = hands.flat().filter(it => !it.fixed);
        for (const s of open.filter(it => it.S.length === 1))
          for (const it of open) if (it !== s && it.S.length > 1 && it.S.includes(s.S[0])) { it.S = it.S.filter(k => k !== s.S[0]); changed = true; }
        hands.forEach(prop);
        if (!changed) break;
      }
    }
    const out = V.players.map(() => ({}));
    for (const h of hands) for (const it of h) if (!it.fixed) out[it.pi][it.ti] = [...new Set(it.S.map(k => k >> 1))].sort((a, b) => a - b);
    return out;
  }

  /* ---------- computer player: decides only from its own view ---------- */
  function comChoose(G, seat) {
    const p = G.players[seat], lv = p.level;
    const V = view(G, seat);
    const options = () => {
      const C = deduce(V, lv), o = [];
      V.players.forEach((q, qi) => { if (qi === seat || q.out) return; q.tiles.forEach((t, ti) => { if (!t.up && C[qi][ti]) o.push({ t: qi, i: ti, cs: C[qi][ti] }); }); });
      return o;
    };
    if (G.phase === "guess") {
      const opts = options(); if (!opts.length) return null;
      let o;
      if (lv === 0) o = pick(opts);
      else { const m = Math.min(...opts.map(o => o.cs.length)); o = pick(opts.filter(o => o.cs.length === m)); }
      let n = pick(o.cs);
      if (lv === 0 && Math.random() < 0.25) n = Math.floor(Math.random() * 12);
      return { k: "guess", t: o.t, i: o.i, n };
    }
    if (G.phase === "decide") {
      const opts = options(); const m = opts.length ? Math.min(...opts.map(o => o.cs.length)) : 99;
      const pr = 1 / m; let go;
      if (pr >= 1) go = true;
      else if (lv === 0) go = pr >= 0.5 && Math.random() < 0.5;
      else if (lv === 1) go = pr >= 0.5;
      else go = pr >= 0.5 || (!G.drawn && pr >= 0.34) || (pr >= 0.34 && hiddenCount(p) >= 4);
      return { k: go ? "go" : "stop" };
    }
    if (G.phase === "penalty") {
      let nxt = (seat + 1) % G.players.length;
      while (G.players[nxt].out && nxt !== seat) nxt = (nxt + 1) % G.players.length;
      const C = deduce(view(G, nxt), 2)[seat] || {};
      const idx = p.tiles.map((t, i) => (t.up ? -1 : i)).filter(i => i >= 0);
      idx.sort((a, b) => (C[a] ? C[a].length : 12) - (C[b] ? C[b].length : 12));
      return { k: "reveal", i: idx[0] };
    }
    return null;
  }

  Object.assign(RNX, { CN, newGame, act, view, deduce, comChoose, log, hiddenCount });
})(typeof module !== "undefined" && module.exports ? module.exports : (window.RNX = {}));
