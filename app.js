/* RNX CODE client — solo / pass-and-play run locally with engine.js, online talks to server.js */
(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CN = RNX.CN, LV = ["쉬움", "보통", "어려움"];
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  let G = null;   // full game state (local modes only)
  let V = null;   // what this screen may see
  const ui = { mode: null, viewer: 0, sel: null, num: null, hint: true, lastSeq: 0, pass: false, passSeq: 0, viewOnly: false, pending: false, setup: null, host: false };
  let comTimer = null, passTimer = null;

  /* ================= local controller ================= */
  function refresh() { if (ui.mode !== "online" && G) V = RNX.view(G, ui.viewer); }
  function doAct(a) {
    ui.sel = null; ui.num = null;
    if (ui.mode === "online") { net.act(a); return; }
    if (RNX.act(G, ui.viewer, a)) tick();
  }
  function tick() {
    clearTimeout(comTimer);
    if (ui.mode === "local" && G.phase !== "over" && ui.viewer !== G.turn && !ui.pass) {
      ui.pass = true;
      const delay = G.ev && G.ev.seq > ui.passSeq ? 1500 : 0;
      ui.passSeq = G.ev ? G.ev.seq : 0;
      clearTimeout(passTimer);
      passTimer = setTimeout(() => { ui.viewer = -1; ui.sel = null; refresh(); render(); showPass(); }, delay);
    }
    refresh(); render();
    if (G.phase === "over") { setTimeout(showEnd, G.ev && G.ev.ok ? 900 : 300); return; }
    if (G.players[G.turn].type === "com") {
      comTimer = setTimeout(() => { const a = RNX.comChoose(G, G.turn); if (a && RNX.act(G, G.turn, a)) tick(); }, G.phase === "guess" ? 1300 : 900);
    }
  }
  function showPass() {
    $("#passName").textContent = G.players[G.turn].name;
    $("#passPrev").textContent = V.ev && V.ev.c ? evText(V.ev) : "누구나 자기 타일은 혼자 확인하세요.";
    $("#passOv").classList.remove("hidden"); $("#passBtn").focus();
  }
  $("#passBtn").onclick = () => { ui.viewer = G.turn; ui.pass = false; $("#passOv").classList.add("hidden"); refresh(); render(); };

  /* ================= render (works from a view only) ================= */
  const hid = p => p.tiles.filter(t => !t.up).length;
  function evText(e) {
    const P = V.players, by = P[e.by] ? P[e.by].name : "";
    if (e.self) return `${by}님이 더미가 비어 자기 타일 ${e.self.n}을(를) 공개했습니다.`;
    if (e.stop) return `${by}님이 멈추고 뽑은 타일을 숨겨 넣었습니다.`;
    const tp = P[e.t] ? P[e.t].name : "";
    return `${by}님이 ${tp}님의 ${CN[e.c]} 타일을 ${e.n}(으)로 선언 · ${e.ok ? "정답" : "오답"}`;
  }
  const myTurn = () => V && V.me >= 0 && V.me === V.turn && V.phase !== "over" && !ui.pending && V.players[V.me].type !== "com";
  function tileHTML(t, pi, i, o) {
    const face = t.n != null;
    const cls = ["tile", t.c, face ? "" : "back", t.up ? "up" : "", !t.up && face && pi === V.me ? "mine-hidden" : "", o.pick ? "pick" : "", o.sel ? "sel" : "", o.anim || "", o.fresh ? "fresh" : ""].filter(Boolean).join(" ");
    const label = `${esc(V.players[pi].name)}의 ${i + 1}번째 타일, ${CN[t.c]}색, ${face ? t.n : "숫자 모름"}${t.up ? ", 공개됨" : ", 숨김"}`;
    const inner = `<span class="face">${face ? t.n : ""}</span>`;
    const el = o.pick ? `<button class="${cls}" data-p="${pi}" data-i="${i}" aria-label="${label}">${inner}</button>` : `<div class="${cls}" role="img" aria-label="${label}">${inner}</div>`;
    const memo = !face && t.x.length ? `<span class="memo">${t.x.slice().sort((a, b) => a - b).map(v => `<s>${v}</s>`).join(" ")}</span>` : `<span class="memo"></span>`;
    return `<div class="tcol">${el}${memo}</div>`;
  }
  function rackHTML(pi) {
    const p = V.players[pi], mine = myTurn();
    const ev = V.ev && V.ev.seq > ui.lastSeq ? V.ev : null;
    return p.tiles.map((t, i) => {
      let pick = false;
      if (mine && V.phase === "guess" && pi !== V.me && !p.out && !t.up) pick = true;
      if (mine && V.phase === "penalty" && pi === V.me && !t.up) pick = true;
      const sel = !!(ui.sel && ui.sel.t === pi && ui.sel.i === i);
      let anim = "", fresh = false;
      if (ev) {
        if (ev.c && ev.t === pi && ev.pos === i) anim = ev.ok ? "anim-flip" : "anim-shake";
        if (ev.self && ev.by === pi && ev.self.pos === i) anim = "anim-flip";
        if (ev.add && ev.by === pi && ev.add.pos === i) anim = "anim-flip";
      }
      if (V.ev && V.ev.add && V.ev.by === pi && V.ev.add.pos === i && V.ev.seq === V.seq) fresh = true;
      return tileHTML(t, pi, i, { pick, sel, anim, fresh });
    }).join("");
  }
  function render() {
    if (!V) return;
    const over = V.phase === "over", P = V.players, me = V.me, cp = P[V.turn];
    const onl = ui.online || [];
    $("#turnInfo").innerHTML = over ? `<b>게임 종료</b>${esc(P[V.winner] ? P[V.winner].name : "")} 승리`
      : `<b>${me === V.turn && ui.mode !== "local" && cp.type !== "com" ? "내 차례" : esc(cp.name) + " 차례"}</b>남은 타일 ${V.pileN}장`;
    const n = P.length, order = [], base = me >= 0 ? me : V.turn - 1;
    for (let k = 1; k <= n; k++) { const i = ((base + k) % n + n) % n; if (i !== me) order.push(i); }
    $("#opps").innerHTML = order.map(i => {
      const p = P[i];
      const tag = p.type === "com" ? `컴퓨터 · ${LV[p.level]}` : ui.mode === "online" ? (onl[i] === false ? "연결 끊김" : i === ui.hostSeat ? "방장" : "온라인") : "";
      const st = p.out ? '<span class="st out">탈락</span>' : over && V.winner === i ? '<span class="st">승리</span>' : i === V.turn && !over ? '<span class="st">차례</span>' : "";
      return `<div class="opp ${i === V.turn && !over ? "cur" : ""} ${p.out ? "out" : ""}"><div class="opp-h"><span class="nm">${esc(p.name)}</span><span class="meta">${tag ? esc(tag) + " · " : ""}숨김 ${hid(p)} / ${p.tiles.length}</span>${st}</div><div class="rack">${rackHTML(i)}</div></div>`;
    }).join("");
    const box = $("#me");
    if (me >= 0) {
      const p = P[me];
      box.classList.remove("hidden"); box.classList.toggle("cur", me === V.turn && !over);
      const suffix = ui.mode !== "local" && p.name !== "나" ? " (나)" : "";
      box.innerHTML = `<div class="me-h"><span class="nm">${esc(p.name)}${suffix}</span><span class="meta">숨김 ${hid(p)} / ${p.tiles.length}${p.out ? " · 탈락" : ""}</span></div><div class="rack">${rackHTML(me)}</div>`;
    } else { box.classList.add("hidden"); box.innerHTML = ""; }
    $("#center").innerHTML = centerHTML();
    $("#logList").innerHTML = V.log.slice().reverse().slice(0, 40).map(s => `<li>${esc(s)}</li>`).join("");
    if (V.ev) ui.lastSeq = Math.max(ui.lastSeq, V.ev.seq);
    bindBoard();
  }
  function centerHTML() {
    const over = V.phase === "over", me = V.me, mine = myTurn();
    const d = V.drawn;
    const drawn = d ? `<div class="tile ${d.c} ${d.n != null ? "" : "back"}" role="img" aria-label="뽑은 타일 ${CN[d.c]}색${d.n != null ? " " + d.n : ""}"><span class="face">${d.n != null ? d.n : ""}</span></div>` : `<div class="empty"></div>`;
    const pile = `<div class="pilebox"><div class="slot"><div class="pile-stack"><i></i><i></i><i></i><b>${V.pileN}</b></div>더미</div><div class="slot">${drawn}뽑은 타일</div></div>`;
    let msg = "", sub = "", extra = "";
    if (ui.pending && !over) { msg = "보내는 중…"; sub = "잠시만 기다려 주세요."; }
    else if (over) { msg = `${esc(V.players[V.winner] ? V.players[V.winner].name : "")} 승리`; sub = "모든 타일이 공개되었습니다."; }
    else if (mine) {
      if (V.phase === "guess") {
        if (!ui.sel) {
          msg = "상대 타일을 하나 고르세요";
          sub = d ? `뽑은 타일은 ${CN[d.c]} ${d.n}입니다. 틀리면 이 타일이 ${V.set.reveal ? "공개된 채" : "숨긴 채"} 내 줄에 들어갑니다.` : "더미가 비었습니다. 틀리면 내 타일 하나를 공개해야 합니다.";
        } else {
          const tp = V.players[ui.sel.t], t = tp.tiles[ui.sel.i];
          msg = `${esc(tp.name)}의 ${ui.sel.i + 1}번째 ${CN[t.c]} 타일`; sub = "숫자를 고르고 선언하세요."; extra = padHTML();
        }
      } else if (V.phase === "decide") {
        msg = "정답입니다. 계속할까요?";
        sub = d ? `멈추면 뽑은 ${CN[d.c]} ${d.n}을(를) 숨긴 채 내 줄에 넣습니다. 계속하다 틀리면 공개됩니다.` : "더미가 비어 있습니다. 계속하다 틀리면 내 타일 하나를 공개합니다.";
        extra = `<div class="decide"><button class="btn" data-act="go">계속 추리하기</button><button class="btn line" data-act="stop">여기서 멈추기</button></div>`;
      } else if (V.phase === "penalty") { msg = "내 타일 하나를 공개하세요"; sub = "더미가 비어 있어 오답의 대가로 내 숨은 타일 중 하나를 직접 골라 공개합니다."; }
    } else {
      const cp = V.players[V.turn];
      if (me === -1) { msg = ui.mode === "online" ? "관전 중입니다" : "화면을 넘겨받는 중"; sub = ui.mode === "online" ? "이번 판은 지켜보기만 할 수 있습니다." : ""; }
      else { msg = `${esc(cp.name)} 차례`; sub = V.phase === "decide" ? "정답을 맞히고 계속할지 고르는 중입니다." : V.phase === "penalty" ? "공개할 타일을 고르는 중입니다." : cp.type === "com" ? "추리하는 중…" : "상대가 추리하는 중입니다."; }
    }
    const e = V.ev;
    const ban = e && e.c ? `<div class="banner ${e.ok ? "ok" : "no"}">${esc(evText(e))}</div>` : e && (e.self || e.stop) ? `<div class="banner">${esc(evText(e))}</div>` : "";
    return `${pile}<div class="status"><div class="msg">${msg}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${ban}</div>${extra}`;
  }
  function padHTML() {
    const C = ui.hint ? (RNX.deduce(V, 2)[ui.sel.t] || {})[ui.sel.i] || null : null;
    let b = "";
    for (let n = 0; n < 12; n++) { const off = C && !C.includes(n); b += `<button data-num="${n}" class="${off ? "off" : ""}" aria-pressed="${ui.num === n}" aria-label="${n}${off ? ", 불가능" : ""}">${n}</button>`; }
    const info = C ? `가능한 숫자 ${C.length}개 · 맞힐 확률 약 ${Math.round(100 / Math.max(1, C.length))}%` : "추리 도우미가 꺼져 있습니다.";
    return `<div class="pad"><div class="pad-grid">${b}</div><div class="pad-foot"><span class="info">${info}</span><button class="btn quiet" data-act="cancel">다른 타일</button><button class="btn" data-act="declare" ${ui.num == null ? "disabled" : ""}>선언하기</button></div></div>`;
  }
  function bindBoard() {
    $$("#game button.tile.pick").forEach(b => b.onclick = () => {
      const t = +b.dataset.p, i = +b.dataset.i;
      if (V.phase === "penalty") { doAct({ k: "reveal", i }); return; }
      ui.sel = { t, i }; ui.num = null; render();
      const pad = $(".pad"); if (pad && window.innerWidth < 760) pad.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    $$("#center [data-num]").forEach(b => b.onclick = () => { ui.num = +b.dataset.num; render(); });
    $$("#center [data-act]").forEach(b => b.onclick = () => {
      const a = b.dataset.act;
      if (a === "cancel") { ui.sel = null; ui.num = null; render(); }
      else if (a === "declare" && ui.sel && ui.num != null) doAct({ k: "guess", t: ui.sel.t, i: ui.sel.i, n: ui.num });
      else if (a === "go" || a === "stop") doAct({ k: a });
    });
  }
  function showEnd() {
    if (!V || V.phase !== "over" || ui.viewOnly) return;
    const w = V.players[V.winner], meWin = V.me === V.winner && ui.mode !== "local";
    $("#endTitle").textContent = meWin ? "승리했습니다" : `${w ? w.name : "?"} 승리`;
    $("#endSub").textContent = meWin ? "끝까지 숫자를 지켜 냈습니다." : "마지막까지 숨긴 타일을 지킨 사람이 이겼습니다.";
    $("#endList").innerHTML = V.players.map((p, i) => `<div><b>${esc(p.name)}</b><span>${i === V.winner ? "승리 · 숨김 " + hid(p) + "장" : "탈락"}</span></div>`).join("");
    const canAgain = ui.mode !== "online" || ui.host;
    $("#againBtn").classList.toggle("hidden", !canAgain);
    $("#endOv").classList.remove("hidden");
  }
  $("#endView").onclick = () => { ui.viewOnly = true; $("#endOv").classList.add("hidden"); };
  $("#endHome").onclick = () => { $("#endOv").classList.add("hidden"); leaveGame(); };
  $("#againBtn").onclick = () => {
    $("#endOv").classList.add("hidden"); ui.viewOnly = false;
    if (ui.mode === "online") { net.post("act", { a: { k: "restart" } }); return; }
    startLocal(ui.setup);
  };

  /* ================= screens ================= */
  function show(id) { ["title", "setup", "online", "game"].forEach(s => $("#" + s).classList.toggle("hidden", s !== id)); window.scrollTo(0, 0); }
  const segVal = sel => $(sel + ' [aria-pressed="true"]').dataset.v;
  const segSet = (sel, v) => $$(sel + " button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === String(v)));
  $$(".seg").forEach(s => s.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; s.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); s.dispatchEvent(new Event("change")); }));
  let setupMode = "solo";
  $$("[data-go]").forEach(b => b.onclick = () => {
    const m = b.dataset.go;
    if (m === "online") { show("online"); net.enter(); return; }
    setupMode = m; $("#setupTitle").textContent = m === "solo" ? "혼자 하기" : "함께 하기";
    $("#soloFields").classList.toggle("hidden", m !== "solo"); $("#localFields").classList.toggle("hidden", m !== "local");
    if (m === "local") drawNames();
    show("setup");
  });
  $$("[data-home]").forEach(b => b.onclick = () => show("title"));
  function drawNames() {
    const k = +segVal("#localCount"), box = $("#localNames"), old = [...box.querySelectorAll("input")].map(i => i.value);
    box.innerHTML = "";
    for (let i = 0; i < k; i++) { const inp = document.createElement("input"); inp.className = "inp"; inp.maxLength = 12; inp.value = old[i] || `플레이어 ${i + 1}`; inp.setAttribute("aria-label", `${i + 1}번 플레이어 이름`); box.appendChild(inp); }
  }
  $("#localCount").addEventListener("change", drawNames);
  $("#startBtn").onclick = () => {
    const set = { start: segVal("#startTiles"), reveal: $("#optReveal").checked, hint: $("#optHint").checked };
    let players;
    if (setupMode === "solo") {
      const k = +segVal("#comCount"), lv = +segVal("#comLevel");
      players = [{ name: $("#soloName").value.trim() || "나", type: "human" }];
      for (let i = 0; i < k; i++) players.push({ name: `컴퓨터 ${i + 1}`, type: "com", level: lv });
    } else players = [...$("#localNames").querySelectorAll("input")].map((inp, i) => ({ name: inp.value.trim() || `플레이어 ${i + 1}`, type: "human" }));
    startLocal({ mode: setupMode, players, set });
  };
  function startLocal(s) {
    ui.setup = s; ui.mode = s.mode; ui.hint = s.set.hint; ui.sel = null; ui.num = null; ui.lastSeq = 0; ui.viewOnly = false; ui.pass = false; ui.passSeq = 0; ui.online = null;
    clearTimeout(comTimer); clearTimeout(passTimer);
    G = RNX.newGame(s.players, s.set);
    ui.viewer = s.mode === "solo" ? 0 : -1;
    show("game");
    if (s.mode === "local") { ui.pass = true; refresh(); render(); showPass(); }
    tick();
  }
  function leaveGame() {
    clearTimeout(comTimer); clearTimeout(passTimer);
    $("#passOv").classList.add("hidden"); $("#endOv").classList.add("hidden");
    if (ui.mode === "online") net.leave(true);
    G = null; V = null; ui.mode = null; show("title");
  }
  $("#quitBtn").onclick = () => {
    if (V && V.phase === "over" && ui.mode !== "online") { leaveGame(); return; }
    const txt = ui.mode === "online" ? "나가면 내 자리는 컴퓨터가 이어서 합니다." : "진행 중인 게임은 저장되지 않습니다.";
    msgBox("게임에서 나갈까요?", txt, [["나가기", () => leaveGame(), "btn"], ["계속하기", null, "btn quiet"]]);
  };
  function msgBox(t, txt, btns) {
    $("#msgTitle").textContent = t; $("#msgText").textContent = txt;
    const box = $("#msgBtns"); box.innerHTML = "";
    btns.forEach(([label, fn, cls]) => { const b = document.createElement("button"); b.className = cls; b.style.flex = "1"; b.textContent = label; b.onclick = () => { $("#msgOv").classList.add("hidden"); fn && fn(); }; box.appendChild(b); });
    $("#msgOv").classList.remove("hidden");
  }
  $$("[data-rules]").forEach(b => b.onclick = () => { $("#rulesOv").classList.remove("hidden"); $("#rulesClose").focus(); });
  $("#rulesClose").onclick = () => $("#rulesOv").classList.add("hidden");
  $("#rulesOv").onclick = e => { if (e.target.id === "rulesOv") $("#rulesOv").classList.add("hidden"); };
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("#rulesOv").classList.add("hidden"); });
  (function () {
    const d = [["b", 2, 1], ["w", 3, 0], ["b", 5, 0], ["w", 7, 1], ["b", 10, 0]];
    $("#demoRack").innerHTML = d.map(([c, n, f], i) => `<div class="tile ${c} ${f ? "up" : "back"}" style="animation-delay:${0.15 + i * 0.12}s"><span class="face">${f ? n : ""}</span></div>`).join("");
  })();

  /* ================= online (server.js) ================= */
  const net = {
    code: null, token: null, es: null, connT: null, lastMsg: null,
    available: location.protocol === "http:" || location.protocol === "https:",
    async post(ep, body) {
      try {
        const r = await fetch("/api/" + ep, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ code: this.code, token: this.token }, body)) });
        const j = await r.json().catch(() => ({ ok: false, error: "서버 응답을 읽지 못했습니다." }));
        return j;
      } catch (e) { return { ok: false, error: "서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요." }; }
    },
    enter() {
      $("#onLobby").classList.add("hidden");
      if (!this.available) { $("#onUnavail").classList.remove("hidden"); $("#onEntry").classList.add("hidden"); return; }
      $("#onUnavail").classList.add("hidden");
      if (this.es) { this.lobbyView(this.lastMsg); return; }
      $("#onEntry").classList.remove("hidden");
      const saved = store.get("rnx_name"); if (saved && !$("#onName").value) $("#onName").value = saved;
      const q = new URLSearchParams(location.search).get("room");
      if (q && /^\d{4}$/.test(q)) $("#joinCode").value = q;
      const sess = store.get("rnx_session");
      $("#resumeBox").classList.toggle("hidden", !sess);
      if (sess) $("#resumeText").textContent = `방 ${sess.code}에 참가 중이었습니다. 이어서 들어갈까요?`;
    },
    name() { const v = $("#onName").value.trim(); if (!v) { $("#onName").focus(); $("#onName").placeholder = "이름을 먼저 입력하세요"; return null; } store.set("rnx_name", v); return v; },
    async create() {
      const name = this.name(); if (!name) return;
      this.code = null; this.token = null;
      const r = await this.post("create", { name });
      if (!r.ok) return msgBox("방을 만들지 못했습니다", r.error || "", [["확인", null, "btn"]]);
      this.begin(r.code, r.token);
    },
    async join() {
      const name = this.name(); if (!name) return;
      const code = $("#joinCode").value.trim();
      if (!/^\d{4}$/.test(code)) { $("#joinCode").focus(); return; }
      this.code = code; this.token = null;
      const r = await this.post("join", { name });
      if (!r.ok) return msgBox("참가하지 못했습니다", r.error || "", [["확인", null, "btn"]]);
      if (r.note) msgBox("관전으로 들어갑니다", r.note, [["확인", null, "btn"]]);
      this.begin(r.code, r.token);
    },
    begin(code, token) {
      this.code = code; this.token = token;
      store.set("rnx_session", { code, token });
      try { history.replaceState(null, "", location.pathname + "?room=" + code); } catch (e) {}
      $("#onEntry").classList.add("hidden");
      this.connect();
    },
    connect() {
      if (this.es) this.es.close();
      const es = new EventSource(`/api/stream?code=${encodeURIComponent(this.code)}&token=${encodeURIComponent(this.token)}`);
      this.es = es;
      es.onopen = () => { clearTimeout(this.connT); $("#connBadge").classList.add("hidden"); };
      es.onerror = () => { clearTimeout(this.connT); this.connT = setTimeout(() => { if (this.es) $("#connBadge").classList.remove("hidden"); }, 2000); };
      clearInterval(this.pingT);
      this.pingT = setInterval(() => { if (this.es) fetch("/api/ping", { method: "POST" }).catch(() => {}); }, 4 * 60000);
      es.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } this.onMsg(m); };
    },
    onMsg(m) {
      if (m.kind === "gone") {
        this.leave(false);
        msgBox("방에 연결할 수 없습니다", m.reason || "방이 끝났습니다.", [["처음으로", () => { G = null; V = null; ui.mode = null; show("title"); }, "btn"]]);
        return;
      }
      this.lastMsg = m; ui.host = !!m.host; ui.hostSeat = m.hostSeat; ui.online = m.online;
      if (m.kind === "lobby") {
        if (ui.mode === "online") { ui.mode = null; V = null; $("#endOv").classList.add("hidden"); }
        if ($("#online").classList.contains("hidden")) show("online");
        this.lobbyView(m); return;
      }
      if (m.kind === "game") {
        const wasOver = V && ui.mode === "online" && V.phase === "over";
        const newGame = !V || ui.mode !== "online" || (m.view.seq < V.seq);
        V = m.view;
        if (ui.mode !== "online" || newGame) {
          ui.mode = "online"; ui.lastSeq = V.ev ? V.ev.seq : 0; ui.viewOnly = false; ui.sel = null; ui.num = null;
          $("#endOv").classList.add("hidden"); show("game");
        }
        if (V.phase !== "over") { ui.viewOnly = false; $("#endOv").classList.add("hidden"); }
        ui.viewer = V.me; ui.hint = $("#netHint").checked;
        if (ui.sel) { const p = V.players[ui.sel.t], t = p && p.tiles[ui.sel.i]; if (!t || t.up || V.turn !== V.me || V.phase !== "guess") { ui.sel = null; ui.num = null; } }
        render();
        if (V.phase === "over" && !wasOver) setTimeout(showEnd, 900);
      }
    },
    async act(a) {
      ui.pending = true; render();
      const r = await this.post("act", { a });
      ui.pending = false;
      if (!r.ok) msgBox("처리되지 않았습니다", r.error || "다시 시도해 주세요.", [["확인", null, "btn"]]);
      render();
    },
    lobbyView(m) {
      if (!m) return;
      $("#onEntry").classList.add("hidden"); $("#onLobby").classList.remove("hidden");
      $("#lobbyCode").textContent = m.code;
      const seats = m.seats || [], rows = [];
      for (let i = 0; i < 4; i++) {
        const s = seats[i];
        if (s) {
          const tag = s.type === "com" ? "컴퓨터 · " + LV[s.level] : s.host ? "방장" : "참가자";
          rows.push(`<div class="seat"><span class="no">${i + 1}</span><span class="nm">${esc(s.name)}</span><span class="tag">${tag}${i === m.you ? " · 나" : ""}</span>${s.online ? "" : '<span class="off">연결 끊김</span>'}${m.host && i !== m.you ? `<button class="x" data-rm="${i}" aria-label="${esc(s.name)} 빼기">×</button>` : ""}</div>`);
        } else rows.push(`<div class="seat empty"><span class="no">${i + 1}</span><span class="nm">빈 자리</span></div>`);
      }
      $("#seatList").innerHTML = rows.join(""); $("#seatCount").textContent = `${seats.length} / 4`;
      $$("#seatList [data-rm]").forEach(b => b.onclick = () => this.post("act", { a: { k: "remove", seat: +b.dataset.rm } }));
      const host = !!m.host;
      $("#hostCom").classList.toggle("hidden", !host); $("#hostOpts").classList.toggle("hidden", !host);
      $("#guestOpts").classList.toggle("hidden", host);
      $("#guestRule").textContent = `시작 타일 ${m.set.start === "auto" ? "자동" : m.set.start + "개"} · 오답 시 뽑은 타일 ${m.set.reveal ? "공개" : "숨김"}`;
      if (host) { segSet("#netStart", m.set.start); $("#netReveal").checked = !!m.set.reveal; }
      $("#netStartBtn").classList.toggle("hidden", !host); $("#waitHost").classList.toggle("hidden", host || m.you < 0);
      $("#netStartBtn").disabled = seats.length < 2; $("#addCom").disabled = seats.length >= 4;
    },
    leave(tell) {
      if (tell && this.code && this.token) this.post("act", { a: { k: "leave" } });
      if (this.es) this.es.close();
      this.es = null; clearTimeout(this.connT); clearInterval(this.pingT); $("#connBadge").classList.add("hidden");
      store.del("rnx_session"); this.lastMsg = null; ui.pending = false;
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    }
  };
  $("#createRoom").onclick = () => net.create();
  $("#joinRoom").onclick = () => net.join();
  $("#resumeBtn").onclick = () => { const s = store.get("rnx_session"); if (!s) return; $("#resumeBox").classList.add("hidden"); net.begin(s.code, s.token); };
  $("#resumeDrop").onclick = () => { store.del("rnx_session"); $("#resumeBox").classList.add("hidden"); };
  $("#addCom").onclick = () => net.post("act", { a: { k: "addCom", level: +segVal("#netLevel") } });
  $("#netStartBtn").onclick = async () => { const r = await net.post("act", { a: { k: "start" } }); if (!r.ok) msgBox("시작하지 못했습니다", r.error || "", [["확인", null, "btn"]]); };
  $("#netStart").addEventListener("change", () => net.post("act", { a: { k: "settings", start: segVal("#netStart") } }));
  $("#netReveal").onchange = () => net.post("act", { a: { k: "settings", reveal: $("#netReveal").checked } });
  $("#netHint").onchange = () => { ui.hint = $("#netHint").checked; if (V) render(); };
  $("#lobbyLeave").onclick = () => { net.leave(true); $("#onLobby").classList.add("hidden"); net.enter(); };
  $("#onlineBack").onclick = () => show("title");
  $("#shareLink").onclick = async () => {
    const url = `${location.origin}${location.pathname}?room=${net.code}`;
    const text = `RNX CODE 같이 해요! 방 코드 ${net.code}`;
    try { if (navigator.share) { await navigator.share({ title: "RNX CODE", text, url }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); $("#shareDone").textContent = "초대 링크를 복사했습니다."; }
    catch (e) { $("#shareDone").textContent = url; }
  };

  // invited by link: open the online screen right away
  if (net.available && /^\d{4}$/.test(new URLSearchParams(location.search).get("room") || "")) { show("online"); net.enter(); }

  window.__rnx = { get G() { return G; }, get V() { return V; }, ui, net };
})();
