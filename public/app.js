(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  const money = (n) => (n == null ? "—" : usd0.format(n));
  const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`);
  const signed = (n) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${usd0.format(Math.abs(n))}`);
  const dateFmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—");
  const fmtShares = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 }));
  // Gain as a % of dollars invested. Gain = net value (after carry) + distributions - invested.
  const gainPct = (gain, invested) => (invested ? `${gain >= 0 ? "+" : "−"}${(Math.abs(gain / invested) * 100).toFixed(1)}%` : "—");
  const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");

  // While any pop-up window is open the page behind it is frozen, then put back exactly where it was. Without this, a swipe
  // that lands on the dark area or reaches the window's edge scrolls the page instead of the window, and opening a window
  // can jump the page (the browser scrolls to the first field).
  let lockedAt = null;
  const lockPage = () => {
    if (lockedAt !== null) return;
    lockedAt = window.scrollY;
    Object.assign(document.body.style, { position: "fixed", top: `-${lockedAt}px`, left: "0", right: "0", width: "100%" });
  };
  const unlockPage = () => {
    if (lockedAt === null) return;
    Object.assign(document.body.style, { position: "", top: "", left: "", right: "", width: "" });
    window.scrollTo(0, lockedAt);
    lockedAt = null;
    markTop();
  };
  const nativeShowModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () { lockPage(); return nativeShowModal.call(this); };
  document.addEventListener("close", () => { if (!document.querySelector("dialog[open]")) unlockPage(); }, true);

  // Pulling the page past its top edge (the elastic bounce on iPhone) reveals whatever colour is behind the page. Keep that the
  // title bar's blue while the page is at the top, so the stretch looks attached to the header instead of a pale gap that floats.
  // Only on a page that can actually scroll (on a short page the same colour would show at the bottom edge too).
  const markTop = () => {
    const root = document.documentElement;
    root.toggleAttribute("data-top", window.scrollY <= 0 && lockedAt === null && root.scrollHeight > window.innerHeight + 1);
  };
  window.addEventListener("scroll", markTop, { passive: true });
  window.addEventListener("resize", markTop);
  window.addEventListener("pageshow", markTop);
  markTop();

  const state = {
    scope: (() => { try { return localStorage.getItem("plc-scope") || ""; } catch { return ""; } })(),
    role: null, me: null, previewOf: null, passcodes: {}, priceErrors: {}, adminPeople: [], quotes: {}, people: [], deals: [], holdings: [], d: null,
  };

  async function api(path, opts = {}) {
    const init = {
      credentials: "same-origin",
      headers: opts.method && opts.method !== "GET" ? { "content-type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    };
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      console.warn("request failed:", path, e);
      if (e instanceof TypeError) throw new Error("Can't reach the server. Check your connection and try again."); // instead of "Failed to fetch"
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith("/auth/")) showLogin();
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  // ---------- derived numbers ----------
  // The server has already filtered everything to what this person may see and computed each holding's value,
  // so this only adds things up.
  function dealNote(d) {
    if (d.basis === "live") return d.sharesHeld && d.price ? `${d.sharesHeld.toLocaleString()} sh × ${usd2.format(d.price)} (${d.ticker})` : "Live market price";
    if (d.basis === "placeholder") return "Placeholder from original spreadsheet (90% of cost)";
    if (d.basis === "cost") return "No value entered yet - shown at cost";
    return `${d.basis === "statement" ? "From statement" : "Estimate"}${d.valueAsOf ? `, as of ${dateFmt(d.valueAsOf)}` : ""}`;
  }
  function derive() {
    const deals = {};
    state.deals.forEach((d) => (deals[d.id] = { invested: 0, value: 0, net: 0, carry: 0, fee: 0, dist: 0, basis: d.basis, price: d.price, note: dealNote(d) }));
    state.holdings.forEach((h) => {
      const dd = deals[h.dealId];
      if (!dd) return;
      dd.invested += h.invested; dd.value += h.gross; dd.net += h.value; dd.carry += h.carry; dd.fee += h.fee; dd.dist += h.distributions;
    });
    const inScope = (dealId) => state.scope === "all" || dealById(dealId)?.channel === state.scope;
    const holdings = state.holdings.filter((h) => inScope(h.dealId)).map((h) => ({ ...h, gain: h.value + h.distributions - h.invested }));
    const people = {};
    state.people.forEach((p) => (people[p.id] = { invested: 0, value: 0, gross: 0, carry: 0, fee: 0, distributions: 0, holdings: [], slot: Math.min(p.order || 9, 9) }));
    holdings.forEach((h) => {
      const t = people[h.personId];
      if (!t) return;
      t.invested += h.invested; t.value += h.value; t.gross += h.gross; t.carry += h.carry; t.fee += h.fee; t.distributions += h.distributions;
      t.holdings.push(h);
    });
    Object.values(people).forEach((t) => (t.gain = t.value + t.distributions - t.invested));
    const total = holdings.reduce((a, h) => ({ invested: a.invested + h.invested, value: a.value + h.value, gross: a.gross + h.gross, carry: a.carry + h.carry, fee: a.fee + h.fee, distributions: a.distributions + h.distributions }), { invested: 0, value: 0, gross: 0, carry: 0, fee: 0, distributions: 0 });
    total.gain = total.value + total.distributions - total.invested;
    state.d = { deals, holdings, people, total };
  }

  const scopedDealList = () => state.deals.filter((d) => state.scope === "all" || d.channel === state.scope);
  const valueTip = (h) => `Gross ${money(h.gross)} − carry ${money(h.carry)} = ${money(h.value)} net${h.fee ? ` · upfront fee paid ${money(h.fee)}` : ""}`;
  const termsText = (d) => [d.mgmtFeePct != null ? `${d.mgmtFeePct}% upfront fee` : "", d.carryPct != null ? `${d.carryPct}% carry` : ""].filter(Boolean).join(" · ");
  const channelPill = (d) => (d?.channel === "individual" ? ' <span class="pill">Individual</span>' : "");
  const personById = (id) => state.people.find((p) => p.id === id);
  const dealById = (id) => state.deals.find((d) => d.id === id);
  const color = (personId) => `var(--s${state.d.people[personId]?.slot || 9})`;
  const tipAttr = (text) => `data-tip="${esc(text)}" tabindex="0"`;

  function basisBadge(dd) {
    if (dd.basis === "live") return `<span class="badge live" ${tipAttr(dd.note)}>Live price</span>`;
    if (dd.basis === "statement") return `<span class="badge" ${tipAttr(dd.note)}>Statement</span>`;
    return `<span class="badge warn" ${tipAttr(dd.note)}>${dd.basis === "cost" ? "At cost" : "Estimate"}</span>`;
  }

  function ownerBar(dealId) {
    if (dealById(dealId)?.partial) return "";
    const hs = state.d.holdings.filter((h) => h.dealId === dealId).sort((a, b) => b.invested - a.invested);
    const total = hs.reduce((s, h) => s + h.invested, 0);
    if (!total) return "";
    return `<div class="seg" role="img" aria-label="Ownership split">${hs
      .map((h) => `<span style="flex:${h.invested};background:${color(h.personId)}" ${tipAttr(`${personById(h.personId)?.name}: ${money(h.invested)} (${pct(h.invested / total, 0)})`)}></span>`)
      .join("")}</div>`;
  }
  // Links used on the Overview: jump to the matching card on the Deals / People tab.
  const dealLink = (d) => `<a class="link" href="#deals/${esc(d.id)}">${esc(d.name)}</a>`;
  const personLink = (p) => `<a class="link" href="#people/${esc(p.id)}">${esc(p.name)}</a>`;
  const legend = () => `<div class="legend">${state.people.map((p) => `<span><i class="sw" style="background:${color(p.id)}"></i>${personLink(p)}${p.type === "non-member" ? " (non-member)" : ""}</span>`).join("")}</div>`;

  // ---------- views ----------
  function overview() {
    const { deals, total, people } = state.d;
    const f = state.scope;
    const scopedDeals = scopedDealList();
    const hs = state.d.holdings;
    const estimated = scopedDeals.filter((d) => ["placeholder", "cost", "estimate"].includes(deals[d.id].basis));
    const noTerms = scopedDeals.filter((d) => d.mgmtFeePct == null && d.carryPct == null);
    const kpi = (label, value, sub, c = "") => `<div class="card kpi"><div class="label">${label}</div><div class="value ${c}">${value}</div><div class="sub">${sub}</div></div>`;
    // When everything in view is an individual deal, show one "Investors" card instead of splitting members from others.
    const individualOnly = scopedDeals.length > 0 && scopedDeals.every((d) => d.channel === "individual");
    const listed = (p) => (f === "all" && !individualOnly ? true : people[p.id].invested > 0);
    const rank = (inGroup) => {
      const list = state.people.filter((p) => inGroup(p) && listed(p)).sort((a, b) => people[b.id].value - people[a.id].value);
      if (!list.length) return "";
      const max = Math.max(1, ...list.map((p) => people[p.id].value));
      return `<div class="bars">${list
        .map((p) => `<div class="bar-row" ${tipAttr(`${p.name}: ${money(people[p.id].value)} net value on ${money(people[p.id].invested)} invested (${gainPct(people[p.id].gain, people[p.id].invested)} after carry)`)}><div class="name">${personLink(p)}</div><div class="bar-track"><div class="bar-fill" style="width:${(people[p.id].value / max) * 100}%;background:${color(p.id)}"></div></div><div class="val">${money(people[p.id].value)}<div class="small ${cls(people[p.id].gain)}">${gainPct(people[p.id].gain, people[p.id].invested)}</div></div></div>`)
        .join("")}</div>`;
    };
    const showWho = scopedDeals.some((d) => !d.partial);
    const showShares = scopedDeals.some((d) => d.sharesHeld);
    const rows = scopedDeals
      .slice()
      .sort((a, b) => deals[b.id].net - deals[a.id].net)
      .map((d) => {
        const dd = deals[d.id];
        const gain = dd.net + dd.dist - dd.invested;
        return `<tr><td><strong>${dealLink(d)}</strong>${channelPill(d)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}</span>` : ""}${termsText(d) ? `<div class="muted small">${esc(termsText(d))}</div>` : ""}</td>
          <td class="num">${money(dd.invested)}</td>${showShares ? `<td class="num">${d.sharesHeld ? `${fmtShares(d.sharesHeld)}${d.ticker ? ` ${esc(d.ticker)}` : ""}` : "—"}</td>` : ""}<td class="num"><span ${tipAttr(`Gross ${money(dd.value)} − carry ${money(dd.carry)} = ${money(dd.net)} net`)}>${money(dd.net)}</span> ${basisBadge(dd)}</td>
          <td class="num ${cls(gain)}">${signed(gain)}<div class="small">${gainPct(gain, dd.invested)}</div></td>${showWho ? `<td>${ownerBar(d.id)}</td>` : ""}</tr>`;
      })
      .join("");
    return `<div class="stack">
      ${estimated.length ? `<div class="banner" role="status"><strong>${estimated.length} of ${scopedDeals.length} deals</strong> use placeholder or estimated values, so gain/loss for them is not real yet. ${state.role === "admin" ? "Set real values under Deals." : ""}</div>` : ""}
      ${noTerms.length ? `<div class="banner" role="status">Fee and carry terms are not entered for <strong>${noTerms.length} of ${scopedDeals.length} deals</strong>, so their values are shown before carry.</div>` : ""}
      <div class="kpis">
        ${kpi("Total invested", money(total.invested), `${hs.length} holdings across ${scopedDeals.length} deals${total.fee ? ` · ${money(total.fee)} of it is upfront fees` : ""}`)}
        ${kpi("Current value (net)", money(total.value), `Gross ${money(total.gross)} · carry −${money(total.carry)}`)}
        ${kpi("Gain / loss (net of carry)", signed(total.gain), total.invested ? `${gainPct(total.gain, total.invested)} on cost (incl. distributions)` : "", cls(total.gain))}
        ${kpi("Distributions received", money(total.distributions), "Cash returned so far")}
      </div>
      <div class="grid-2">
        ${individualOnly
          ? `<div class="card"><h2>Investors - net value</h2>${rank(() => true)}</div>`
          : `${rank((p) => p.type === "member") ? `<div class="card"><h2>Club members - net value</h2>${rank((p) => p.type === "member")}</div>` : ""}
        ${rank((p) => p.type !== "member") ? `<div class="card"><h2>${state.me && state.me.type === "non-member" ? "Your investments - net value" : "Other investors - net value"}</h2>${rank((p) => p.type !== "member")}</div>` : ""}`}
      </div>
      <div class="card"><h2>${showWho ? "All investments" : "Your investments"}</h2>${showWho ? legend() : ""}
        <div class="table-wrap"><table><thead><tr><th>Deal</th><th class="num">Invested</th>${showShares ? '<th class="num">Shares held</th>' : ""}<th class="num">Value (net of carry)</th><th class="num">Gain / loss (net of carry)</th>${showWho ? "<th>Who holds it</th>" : ""}</tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Nothing to show here yet.</td></tr>'}</tbody></table></div>
      </div></div>`;
  }

  function peopleCard(p) {
    const t = state.d.people[p.id];
    const showShares = t.holdings.some((h) => h.shares != null);
    const rows = t.holdings
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((h) => {
        const d = dealById(h.dealId);
        return `<tr><td>${esc(d?.name)}${channelPill(d)}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td><td class="num">${pct(h.share)}</td>${showShares ? `<td class="num">${h.shares != null ? `<span ${tipAttr("Shares held by the whole deal, split by dollars invested")}>${fmtShares(h.shares)}</span>` : "—"}</td>` : ""}<td class="num"><span ${tipAttr(valueTip(h))}>${money(h.value)}</span> ${basisBadge(state.d.deals[h.dealId])}</td><td class="num ${cls(h.gain)}">${signed(h.gain)}<div class="small">${gainPct(h.gain, h.invested)}</div></td>${state.role === "admin" ? `<td class="num"><button class="btn small" data-edit-holding="${esc(h.id)}">Edit</button></td>` : ""}</tr>`;
      })
      .join("");
    return `<div class="card" id="person-${esc(p.id)}"><div class="person-head"><h3><i class="sw" style="background:${color(p.id)}"></i>${esc(p.name)}${state.role === "admin" ? ` <button class="btn small ghost" data-edit-person="${esc(p.id)}">Edit</button>` : ""}</h3>
      <span class="muted">${money(t.invested)} invested · <strong>${money(t.value)}</strong> now · <span class="${cls(t.gain)}">${signed(t.gain)} (${gainPct(t.gain, t.invested)})</span></span></div>
      <div class="table-wrap"><table><thead><tr><th>Deal</th><th>Date</th><th class="num">Invested</th><th class="num">Share of deal</th>${showShares ? '<th class="num">Shares</th>' : ""}<th class="num">Value (net)</th><th class="num">Gain / loss (net of carry)</th>${state.role === "admin" ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No holdings yet.</td></tr>'}</tbody></table></div></div>`;
  }
  function people() {
    const has = (p) => state.scope === "all" || state.d.people[p.id].holdings.length > 0;
    const dl = scopedDealList();
    if (dl.length && dl.every((d) => d.channel === "individual")) {
      const everyone = state.people.filter((p) => state.d.people[p.id].holdings.length > 0);
      return `<div class="stack"><div class="section-head"><h2>Investors</h2><span class="muted">${everyone.length} ${everyone.length === 1 ? "person" : "people"}</span></div>
        ${everyone.map(peopleCard).join("") || '<p class="muted">No investors yet.</p>'}</div>`;
    }
    const members = state.people.filter((p) => p.type === "member" && has(p));
    const others = state.people.filter((p) => p.type !== "member" && has(p));
    return `<div class="stack"><div class="section-head"><h2>Club members</h2><span class="muted">${members.length} members</span></div>
      ${members.map(peopleCard).join("") || '<p class="muted">No members.</p>'}
      <div class="section-head"><h2>Other investors</h2><span class="muted">${others.length} ${others.length === 1 ? "person" : "people"}</span></div>
      ${others.map(peopleCard).join("") || '<p class="muted">No non-members.</p>'}</div>`;
  }

  function deals() {
    return `<div class="stack">${scopedDealList()
      .slice()
      .sort((a, b) => state.d.deals[b.id].net - state.d.deals[a.id].net)
      .map((d) => {
        const dd = state.d.deals[d.id];
        const hs = state.d.holdings.filter((h) => h.dealId === d.id).sort((a, b) => b.invested - a.invested);
        const gain = dd.net + dd.dist - dd.invested;
        return `<div class="card" id="deal-${esc(d.id)}"><div class="person-head"><h3>${esc(d.name)} ${channelPill(d)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}${d.price ? ` ${usd2.format(d.price)}` : ""}</span>` : ""}</h3>
          <span>${state.role === "admin" ? `<button class="btn small" data-edit-deal="${esc(d.id)}">Edit deal</button>` : ""}</span></div>
          <p class="muted" style="margin:0 0 10px">${d.sharesHeld ? `Shares held: <strong>${fmtShares(d.sharesHeld)}${d.ticker ? ` ${esc(d.ticker)}` : ""}</strong> · ` : d.ticker ? "Shares held: <strong>not entered yet</strong> · " : ""}Invested <strong>${money(dd.invested)}</strong> · Net value <strong>${money(dd.net)}</strong> ${basisBadge(dd)} · <span class="${cls(gain)}">${signed(gain)} (${gainPct(gain, dd.invested)}) net of carry</span></p>
          <p class="muted" style="margin:0 0 10px">${termsText(d) ? `Terms: ${esc(termsText(d))}. ` : "Fee and carry terms not entered. "}Gross value ${money(dd.value)} − carry ${money(dd.carry)}${dd.fee ? ` · upfront fees paid ${money(dd.fee)} (inside the amount invested)` : ""}</p>
          ${d.needsShares ? `<p class="banner">Ticker ${esc(d.ticker)} is set but the share count isn't, so this deal is not priced live yet.${d.priceError || state.priceErrors[d.ticker] ? ` (Price lookup: ${esc(d.priceError || state.priceErrors[d.ticker])})` : ""}</p>` : ""}
          ${state.role === "admin" && d.price && (d.priceError || state.priceErrors[d.ticker]) ? `<p class="muted">Price lookup is failing, so the last good price is being used: ${esc(d.priceError || state.priceErrors[d.ticker])}</p>` : ""}
          ${d.ticker && !d.needsShares && !d.price ? `<p class="muted">Live price unavailable: ${esc(d.priceError || state.priceErrors[d.ticker] || "still checking")}</p>` : ""}
          ${state.role === "admin" && !state.previewOf ? splitNotice(d) : ""}
          ${d.notes ? `<p class="muted">${esc(d.notes)}</p>` : ""}
          <div class="table-wrap"><table><thead><tr><th>Holder</th><th>Date</th><th class="num">Invested</th>${d.partial ? "" : '<th class="num">Share</th>'}${d.sharesHeld && !d.partial ? '<th class="num">Shares</th>' : ""}<th class="num">Value (net)</th><th class="num">Distributions</th>${state.role === "admin" ? "<th></th>" : ""}</tr></thead><tbody>
          ${hs.map((h) => `<tr><td><i class="sw" style="background:${color(h.personId)}"></i>${esc(personById(h.personId)?.name)}${personById(h.personId)?.type === "non-member" ? ' <span class="pill">non-member</span>' : ""}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td>${d.partial ? "" : `<td class="num">${pct(h.share)}</td>`}${d.sharesHeld && !d.partial ? `<td class="num">${fmtShares(h.shares)}</td>` : ""}<td class="num"><span ${tipAttr(valueTip(h))}>${money(h.value)}</span></td><td class="num">${money(h.distributions)}</td>${state.role === "admin" ? `<td class="num"><button class="btn small" data-edit-holding="${esc(h.id)}">Edit</button></td>` : ""}</tr>`).join("")}
          </tbody></table></div></div>`;
      })
      .join("") || '<p class="muted">No deals yet.</p>'}</div>`;
  }

  // Year-end totals: cumulative amount invested in Power Lunch Club deals at each 12/31 (cost, incl. upfront fees).
  function yearEndData() {
    const club = state.holdings.filter((h) => dealById(h.dealId)?.channel === "club");
    if (!club.length) return [];
    const thisYear = new Date().getFullYear();
    const first = Math.min(...club.map((h) => Number(h.date.slice(0, 4))));
    const last = Math.max(thisYear, ...club.map((h) => Number(h.date.slice(0, 4))));
    const sum = (list) => list.reduce((s, h) => s + h.invested, 0);
    const out = [];
    for (let y = last; y >= first; y--) {
      const end = `${y}-12-31`;
      const rows = state.people
        .filter((p) => p.type === "member" || club.some((h) => h.personId === p.id))
        .map((p) => {
          const mine = club.filter((h) => h.personId === p.id);
          return { p, during: sum(mine.filter((h) => h.date.startsWith(String(y)))), cum: sum(mine.filter((h) => h.date <= end)) };
        });
      const members = rows.filter((r) => r.p.type === "member");
      const others = rows.filter((r) => r.p.type !== "member" && (r.cum || r.during));
      const total = { during: members.reduce((s, r) => s + r.during, 0), cum: members.reduce((s, r) => s + r.cum, 0) };
      const deals = [...new Set(club.filter((h) => h.date.startsWith(String(y))).map((h) => h.dealId))].map((id) => dealById(id).name);
      out.push({ y, current: y === thisYear, members, others, total, deals });
    }
    return out;
  }
  function yearend() {
    const data = yearEndData();
    if (!data.length) return `<div class="card"><h2>Year-end totals</h2><p class="muted">No Power Lunch Club investments yet.</p></div>`;
    const cards = data
      .map((Y) => {
        const label = Y.current ? `to date (${dateFmt(today())})` : `at 12/31/${Y.y}`;
        const body = Y.members
          .map((r) => `<tr><td>${esc(r.p.name)}</td><td class="num">${r.during ? money(r.during) : "—"}</td><td class="num">${r.cum ? money(r.cum) : "—"}</td><td class="num">${Y.total.cum ? pct(r.cum / Y.total.cum, 2) : "—"}</td></tr>`)
          .join("");
        const others = Y.others.map((r) => `<tr class="muted"><td>${esc(r.p.name)} (non-member, not counted above)</td><td class="num">${r.during ? money(r.during) : "—"}</td><td class="num">${r.cum ? money(r.cum) : "—"}</td><td class="num"></td></tr>`).join("");
        return `<div class="card"><div class="person-head"><h3>${Y.y}${Y.current ? " (so far)" : ""}</h3><span class="muted">${Y.deals.length ? `Deals this year: ${esc(Y.deals.join(", "))}` : "No new deals this year"}</span></div>
          <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Invested during ${Y.y}</th><th class="num">Total invested ${esc(label)}</th><th class="num">% of club</th></tr></thead>
          <tbody>${body}${others}</tbody><tfoot><tr><td>Total, club members</td><td class="num">${money(Y.total.during)}</td><td class="num">${money(Y.total.cum)}</td><td class="num">100%</td></tr></tfoot></table></div></div>`;
      })
      .join("");
    return `<div class="stack"><div class="section-head"><h2>Year-end investment totals</h2><button class="btn" type="button" data-csv-yearend>Download CSV</button></div>
      <p class="muted" style="margin:-4px 0 0">Power Lunch Club deals only. Individual deals are excluded. Amounts are cash invested (including any upfront management fee), by investment date, not current value. Built from the holdings you've entered, so confirm with your accountant before filing.</p>${cards}</div>`;
  }
  function yearEndCsv() {
    // A name that starts with = + - @ would run as a formula when the file is opened in a spreadsheet, so mark it as text.
    const q = (v) => `"${(typeof v === "string" && /^\s*[=+\-@]|^[\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? "'" : "") + String(v).replace(/"/g, '""')}"`;
    const rows = [["Year", "Holder", "Status", "Invested during year", "Total invested at year-end (or to date)", "% of club members' total"]];
    yearEndData().forEach((Y) => {
      Y.members.forEach((r) => rows.push([Y.y, r.p.name, "member", r.during, r.cum, Y.total.cum ? ((r.cum / Y.total.cum) * 100).toFixed(2) : ""]));
      Y.others.forEach((r) => rows.push([Y.y, r.p.name, "non-member", r.during, r.cum, ""]));
      rows.push([Y.y, "TOTAL (club members)", "", Y.total.during, Y.total.cum, "100.00"]);
    });
    const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pari-passu-year-end-${today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const options = (items, sel) => items.map((i) => `<option value="${esc(i.id)}"${i.id === sel ? " selected" : ""}>${esc(i.name)}</option>`).join("");
  // The user's own calendar date (not UTC, which is already "tomorrow" in the evening).
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  // Splits recorded in the last 30 days, shown to the admin on the deal card.
  function splitNotice(d) {
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
    const recent = (d.splitLog || []).filter((x) => x.appliedAt >= cutoff);
    if (!recent.length) return "";
    return recent.map((x) => `<p class="banner">Stock split ${esc(String(x.to))}-for-${esc(String(x.from))} on ${dateFmt(x.date)} was recorded: ${fmtShares(x.before)} → ${fmtShares(x.after)} shares. Dollars invested are unchanged.</p>`).join("");
  }
  function admin() {
    const rows = state.d.holdings
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((h) => `<tr><td>${esc(dealById(h.dealId)?.name)}</td><td>${esc(personById(h.personId)?.name)}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td><td class="num">${money(h.distributions)}</td>
        <td class="num"><button class="btn small" data-edit-holding="${esc(h.id)}">Edit</button> <button class="btn small danger" data-del-holding="${esc(h.id)}">Delete</button></td></tr>`)
      .join("");
    return `<div class="stack">
      <div class="card"><h2>Backup</h2><p class="muted" style="margin-top:0">Everything here can be edited or deleted with no undo. Download a copy before big changes.</p><a class="btn" href="/api/export" download>Download backup (JSON)</a></div>
      <div class="card"><h2>Guided setup</h2><p class="muted" style="margin-top:0">Answer a few questions instead of filling in forms.</p>
        <div class="row-actions" style="margin-top:0"><button class="btn primary" type="button" data-wiz="add">Add an investment</button><button class="btn" type="button" data-wiz="complete">Fill in missing deal details</button></div></div>
      <div class="card"><h2>Add an investment (quick form)</h2>
        <form id="addHolding"><div class="form-grid">
          <div><label for="ah-deal">Deal</label><select id="ah-deal" name="dealId" required>${options(state.deals)}</select></div>
          <div><label for="ah-person">Person</label><select id="ah-person" name="personId" required>${options(state.people)}</select></div>
          <div><label for="ah-date">Investment date</label><input id="ah-date" name="date" type="date" value="${today()}" required></div>
          <div><label for="ah-amt">Amount invested ($)</label><input id="ah-amt" name="invested" type="number" min="0" step="0.01" required></div>
          <div><label for="ah-dist">Distributions ($)</label><input id="ah-dist" name="distributions" type="number" min="0" step="0.01" value="0"></div>
        </div><p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Add investment</button></div></form></div>
      <div class="grid-2">
        <div class="card"><h2>Add a new deal</h2>
          <form id="addDeal"><label for="ad-name">Deal name</label><input id="ad-name" name="name" required>
            <div class="form-grid"><div><label for="ad-ch">Held through</label><select id="ad-ch" name="channel"><option value="club">Power Lunch Club</option><option value="individual">Individual</option></select></div>
            <div><label for="ad-tk">Ticker (if public)</label><input id="ad-tk" name="ticker" placeholder="e.g. SPCX"></div>
            <div><label for="ad-val">Current value ($, whole deal, before carry)</label><input id="ad-val" name="manualValue" type="number" min="0" step="0.01"></div>
            <div><label for="ad-src">Where does the value come from?</label><select id="ad-src" name="valueSource"><option value="estimate">My estimate</option><option value="statement">A statement</option></select></div>
            <div><label for="ad-fee">Upfront mgmt fee (% of amount invested)</label><input id="ad-fee" name="mgmtFeePct" type="number" min="0" max="100" step="0.01"></div>
            <div><label for="ad-carry">Carry (% of profit)</label><input id="ad-carry" name="carryPct" type="number" min="0" max="100" step="0.01"></div></div>
            <label for="ad-notes">Notes</label><input id="ad-notes" name="notes"><p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Add deal</button></div></form></div>
        <div class="card"><h2>Add a person</h2>
          <form id="addPerson"><label for="ap-name">Name</label><input id="ap-name" name="name" required>
            <label for="ap-type">Status</label><select id="ap-type" name="type"><option value="member">Club member</option><option value="non-member">Not a club member</option></select>
            <p style="margin:14px 0 0"><strong>Also record what they invested</strong> <span class="muted">(optional)</span></p>
            <div class="form-grid"><div><label for="ap-deal">Deal</label><select id="ap-deal" name="dealId"><option value="">No investment yet</option>${options(state.deals)}</select></div>
              <div><label for="ap-amt">Amount invested ($)</label><input id="ap-amt" name="amount" type="number" min="0" step="0.01" inputmode="decimal"></div>
              <div><label for="ap-date">Date</label><input id="ap-date" name="date" type="date" value="${today()}"></div></div>
            <p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Add person</button></div></form>
          <h3 style="margin-top:18px">People</h3>
          <ul style="padding-left:18px;margin:6px 0 0">${state.people.map((p) => `<li>${esc(p.name)} - ${p.type === "member" ? "member" : "non-member"} · ${state.passcodes[p.id] ? "can sign in" : "no sign-in yet"} <button class="btn small ghost" data-edit-person="${esc(p.id)}">Edit</button></li>`).join("")}</ul></div>
      </div>
      <div class="card"><h2>All deals</h2><div class="table-wrap"><table><thead><tr><th>Deal</th><th>Held through</th><th>Terms</th><th></th></tr></thead><tbody>${state.deals.map((d) => `<tr><td>${esc(d.name)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}</span>` : ""}</td><td>${d.channel === "individual" ? "Individual" : "Power Lunch Club"}</td><td>${esc(termsText(d) || "not entered")}</td><td class="num"><button class="btn small" data-edit-deal="${esc(d.id)}">Edit</button></td></tr>`).join("")}</tbody></table></div></div>
      <div class="card"><h2>All holdings</h2><div class="table-wrap"><table><thead><tr><th>Deal</th><th>Person</th><th>Date</th><th class="num">Invested</th><th class="num">Distributions</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
  }

  // ---------- dialogs ----------
  const dlg = $("#dlg");
  function openDialog(html, onSubmit, extra) {
    dlg.innerHTML = `<form method="dialog" id="dlgForm">${html}<p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button>${extra ? `<button class="btn danger" type="button" data-extra style="margin-left:auto">${esc(extra.label)}</button>` : ""}</div></form>`;
    $("[data-close]", dlg).onclick = () => dlg.close();
    if (extra) $("[data-extra]", dlg).onclick = async () => {
      try { if (await extra.run()) { dlg.close(); await refresh(); } } catch (err) { $("[data-err]", dlg).textContent = err.message; }
    };
    $("#dlgForm", dlg).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await onSubmit(Object.fromEntries(new FormData(e.target)));
        dlg.close();
        await refresh();
      } catch (err) {
        $("[data-err]", dlg).textContent = err.message;
      }
    };
    dlg.showModal();
  }
  async function deleteDeal(id) {
    const d = dealById(id);
    const hs = state.holdings.filter((h) => h.dealId === id);
    const msg = hs.length
      ? `Delete "${d.name}" AND its ${hs.length} holding${hs.length === 1 ? "" : "s"} (${money(hs.reduce((s, h) => s + h.invested, 0))} invested)? This can't be undone.`
      : `Delete "${d.name}"? This can't be undone.`;
    if (!confirm(msg)) return false;
    await api(`/api/deals/${id}${hs.length ? "?cascade=1" : ""}`, { method: "DELETE" });
    return true;
  }
  // Easy to say and remember: 3 consonant+vowel syllables and 2 digits, 8 characters, e.g. "rakobu47".
  // Letters that are easy to confuse (l, q, w, x, y, c, j) are left out.
  function makePasscode() {
    const pick = (set) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
    let out = "";
    for (let i = 0; i < 3; i++) out += pick("bdfghkmnprstvz") + pick("aeiou");
    return out + pick("23456789") + pick("23456789");
  }
  function editPerson(id) {
    const p = personById(id);
    const n = state.holdings.filter((h) => h.personId === id).length;
    openDialog(
      `<h2>${esc(p.name)}</h2>
      <label for="p-name">Name</label><input id="p-name" name="name" value="${esc(p.name)}" required>
      <label for="p-type">Status</label><select id="p-type" name="type"><option value="member"${p.type === "member" ? " selected" : ""}>Club member</option><option value="non-member"${p.type !== "member" ? " selected" : ""}>Not a club member</option></select>
      <label for="p-code">Sign-in passcode</label>
      <div class="inv-row" style="grid-template-columns:1fr auto auto"><input id="p-code" name="passcode" autocomplete="off" spellcheck="false" placeholder="${state.passcodes[id] ? "Set. Type a new one to replace it" : "Not set. This person can't sign in yet"}"><button type="button" class="btn small" data-gen>Generate</button>${state.passcodes[id] ? '<button type="button" class="btn small danger" data-rmcode>Remove</button>' : ""}</div>
      <p class="muted">At least 8 characters. Generate makes an easy-to-say 8-character code (like rakobu47). It's stored scrambled and can't be shown again, so copy it before saving and send it to ${esc(p.name)} privately. Changing or removing it signs them out. They sign in with their name (${esc(p.name)}) and this passcode.</p>
      <p class="muted">${n ? `${n} holding${n === 1 ? "" : "s"}. To delete this person, delete or reassign their holdings first.` : "No holdings, so this person can be deleted."}</p>`,
      async (f) => {
        await api(`/api/people/${id}`, { method: "PUT", body: { name: f.name, type: f.type } });
        if (f.passcode) await api(`/api/people/${id}/passcode`, { method: "PUT", body: { passcode: f.passcode } });
      },
      { label: "Delete person", run: async () => { if (!confirm(`Delete ${p.name}? This can't be undone.`)) return false; await api(`/api/people/${id}`, { method: "DELETE" }); return true; } },
    );
    $("[data-gen]", dlg).onclick = () => { $("#p-code", dlg).value = makePasscode(); };
    $("[data-rmcode]", dlg)?.addEventListener("click", async () => {
      if (!confirm(`Remove ${p.name}'s sign-in? They won't be able to sign in until you set a new passcode.`)) return;
      try { await api(`/api/people/${id}/passcode`, { method: "DELETE" }); dlg.close(); await refresh(); } catch (err) { $("[data-err]", dlg).textContent = err.message; }
    });
  }
  function editDeal(id) {
    const d = dealById(id);
    openDialog(
      `<h2>${esc(d.name)}</h2>
      <div class="form-grid">
        <div><label for="e-name">Name</label><input id="e-name" name="name" value="${esc(d.name)}" required></div>
        <div><label for="e-ch">Held through</label><select id="e-ch" name="channel"><option value="club"${d.channel === "club" ? " selected" : ""}>Power Lunch Club</option><option value="individual"${d.channel === "individual" ? " selected" : ""}>Individual</option></select></div>
        <div><label for="e-tk">Ticker (if public)</label><input id="e-tk" name="ticker" value="${esc(d.ticker || "")}"></div>
        <div><label for="e-sh">Shares held (whole deal)</label><div style="display:flex;gap:8px;align-items:center"><input id="e-sh" name="sharesHeld" type="number" min="0" step="any" value="${d.sharesHeld ?? ""}" style="flex:1;min-width:0"><button class="btn small" type="button" id="sp-open" aria-expanded="false" aria-controls="sp-panel">Record a split…</button></div></div>
        <div id="sp-panel" hidden style="grid-column:1/-1;margin:10px 0 4px;border:1px solid var(--grid);border-radius:10px;padding:12px">
          <strong>Record a stock split</strong>
          ${!d.sharesHeld
            ? `<p class="muted" style="margin:6px 0 0">Enter and save this deal's share (or unit) count first, then come back to record a split.</p>`
            : `<p class="muted" style="margin:6px 0 10px">Use this when the company splits its shares. The share count changes; the dollars invested and the value you typed in do not. Currently <strong>${fmtShares(d.sharesHeld)}</strong> shares. Recording a split saves right away; any other changes typed in this window are not saved.</p>
          ${d.ticker ? `<p class="banner">${esc(d.ticker)} is priced live, and the market price changes on the split date. Record the split then, otherwise the value shown (shares × price) is wrong until you do.</p>` : ""}
          <div class="form-grid">
            <div><label for="sp-to">New shares you now have…</label><input id="sp-to" type="number" step="any" value="2"></div>
            <div><label for="sp-from">…for every this many old shares</label><input id="sp-from" type="number" step="any" value="1"></div>
            <div><label for="sp-date">Date of the split</label><input id="sp-date" type="date" max="${today()}" value="${today()}"></div>
          </div>
          <p id="sp-prev" class="muted"></p>
          <p id="sp-err" class="error" role="alert"></p>
          <button class="btn" type="button" id="sp-run">Save this split</button>`}
        </div>
        <div><label for="e-fee">Upfront mgmt fee (% of amount invested)</label><input id="e-fee" name="mgmtFeePct" type="number" min="0" max="100" step="0.01" value="${d.mgmtFeePct ?? ""}"></div>
        <div><label for="e-carry">Carry (% of profit)</label><input id="e-carry" name="carryPct" type="number" min="0" max="100" step="0.01" value="${d.carryPct ?? ""}"></div>
        <div><label for="e-val">Current value ($, whole deal, before carry)</label><input id="e-val" name="manualValue" type="number" min="0" step="0.01" value="${d.manualValue ?? ""}"></div>
        <div><label for="e-src">Value source</label><select id="e-src" name="valueSource">${d.valueSource === "placeholder" ? '<option value="placeholder" selected>Placeholder (from spreadsheet)</option>' : ""}<option value="statement"${d.valueSource === "statement" ? " selected" : ""}>From a statement</option><option value="estimate"${d.valueSource === "estimate" ? " selected" : ""}>Estimate</option></select></div>
        <div><label for="e-asof">Value as-of date</label><input id="e-asof" name="valueAsOf" type="date" value="${d.valueAsOf || ""}"></div>
      </div>
      <label for="e-vn">Note for the value history (optional)</label><input id="e-vn" name="valueNote">
      <label for="e-notes">Deal notes</label><input id="e-notes" name="notes" value="${esc(d.notes || "")}">
      <p class="muted">If a ticker and share count are both set and a live price is available, the live price overrides the manual value.</p>
      ${d.splitLog?.length ? `<details><summary>Split history (${d.splitLog.length})</summary><ul>${d.splitLog.slice().reverse().map((x) => `<li>${dateFmt(x.date)}: ${esc(String(x.to))}-for-${esc(String(x.from))}, ${fmtShares(x.before)} → ${fmtShares(x.after)} shares (recorded by you)</li>`).join("")}</ul></details>` : ""}
      ${d.valueHistory?.length ? `<details><summary>Value history (${d.valueHistory.length})</summary><ul>${d.valueHistory.slice().reverse().map((v) => `<li>${esc(new Date(v.at).toLocaleDateString())}: ${money(v.value)} (${esc(v.source)})${v.note ? ` - ${esc(v.note)}` : ""}</li>`).join("")}</ul></details>` : ""}`,
      (f) => api(`/api/deals/${id}`, { method: "PUT", body: f }),
      { label: "Delete deal", run: () => deleteDeal(id) },
    );
    $("#sp-open", dlg).onclick = (e) => {
      const panel = $("#sp-panel", dlg), show = panel.hidden;
      panel.hidden = !show;
      e.currentTarget.setAttribute("aria-expanded", String(show));
    };
    const run = $("#sp-run", dlg);
    if (run) {
      const prev = () => {
        const to = Number($("#sp-to", dlg).value), from = Number($("#sp-from", dlg).value);
        $("#sp-prev", dlg).textContent = to > 0 && from > 0 ? `${fmtShares(d.sharesHeld)} shares become ${fmtShares(Math.round(d.sharesHeld * (to / from) * 1e6) / 1e6)}.` : "";
      };
      $("#sp-to", dlg).oninput = $("#sp-from", dlg).oninput = prev;
      prev();
      const formState = () => JSON.stringify([...new FormData($("#dlgForm", dlg))]);
      const openState = formState();
      const record = async () => {
        if (run.disabled) return;                       // one request at a time (Enter held down repeats)
        const to = Number($("#sp-to", dlg).value), from = Number($("#sp-from", dlg).value), date = $("#sp-date", dlg).value;
        const err = $("#sp-err", dlg), save = $("#dlgForm button[type=submit]", dlg);
        if (!(to > 0) || !(from > 0)) { err.textContent = "Enter the split as two numbers above zero, e.g. 2 new shares for every 1 old share."; return; }
        if (!date || date > today()) { err.textContent = "Choose the date of the split (it can't be in the future)."; return; }
        if (formState() !== openState && !confirm("You have unsaved changes in this window. Recording the split saves right away and discards them. Record the split anyway?")) return;
        run.disabled = save.disabled = true; err.textContent = "";   // Save is held too, so it can't write the old share count over the new one
        try {
          await api(`/api/deals/${id}/split`, { method: "POST", body: { to, from, date } });
        } catch (e) { err.textContent = e.message; run.disabled = save.disabled = false; return; }
        dlg.close();
        try { await refresh(); } catch { setTimeout(() => refresh(false, true).catch(() => {}), 3000); }   // the split is saved; only the reload failed
      };
      run.onclick = record;
      // Enter in a split box records the split; it must not save the rest of the Edit deal form.
      for (const el of [$("#sp-to", dlg), $("#sp-from", dlg), $("#sp-date", dlg)]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) record(); } });
    }
  }
  function editHolding(id) {
    const h = state.holdings.find((x) => x.id === id);
    openDialog(
      `<h2>Edit holding</h2><div class="form-grid">
        <div><label for="h-deal">Deal</label><select id="h-deal" name="dealId">${options(state.deals, h.dealId)}</select></div>
        <div><label for="h-person">Person</label><select id="h-person" name="personId">${options(state.people, h.personId)}</select></div>
        <div><label for="h-date">Date</label><input id="h-date" name="date" type="date" value="${esc(h.date)}" required></div>
        <div><label for="h-amt">Invested ($)</label><input id="h-amt" name="invested" type="number" min="0" step="0.01" value="${h.invested}" required></div>
        <div><label for="h-dist">Distributions ($)</label><input id="h-dist" name="distributions" type="number" min="0" step="0.01" value="${h.distributions}"></div></div>`,
      (f) => api(`/api/holdings/${id}`, { method: "PUT", body: f }),
      { label: "Delete holding", run: async () => { if (!confirm("Delete this holding? This can't be undone.")) return false; await api(`/api/holdings/${id}`, { method: "DELETE" }); return true; } },
    );
  }

  // ---------- shell ----------
  const view = $("#view");
  const views = { overview, people, deals, yearend, admin };
  const isAdminSession = () => state.role === "admin" || !!state.previewOf;
  const canYearEnd = () => state.role === "admin" || state.me?.type === "member";
  function allowedScopes() {
    if (state.role === "admin") return { all: "All", club: "Power Lunch Club", individual: "Individual" };
    if (state.me?.type === "member") return { club: "Power Lunch Club", individual: "My individual investments" };
    return { all: "My investments" };
  }
  function render() {
    const [rawTab, focusId] = (location.hash || "#overview").slice(1).split("/");
    let tab = rawTab;
    if (!views[tab] || (tab === "admin" && state.role !== "admin") || (tab === "yearend" && !canYearEnd())) tab = "overview";
    const scopes = allowedScopes();
    if (!scopes[state.scope]) { state.scope = Object.keys(scopes)[0]; derive(); }
    document.querySelectorAll("#tabs a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $("#adminTab").hidden = state.role !== "admin";
    $("#addInvBtn").hidden = state.role !== "admin";
    document.querySelector('#tabs a[data-tab="yearend"]').hidden = !canYearEnd();
    $("#roleBadge").textContent = state.role === "admin" ? "Admin" : state.me ? `Signed in as ${state.me.name}` : "";
    const sel = $("#previewSel");
    $("#previewWrap").hidden = !isAdminSession();
    if (isAdminSession()) {
      sel.innerHTML = `<option value="">Admin view</option>${state.adminPeople.map((p) => `<option value="${esc(p.id)}"${state.previewOf === p.id ? " selected" : ""}>${esc(p.name)}</option>`).join("")}`;
    }
    const bar = $("#previewBar");
    bar.hidden = !state.previewOf;
    if (state.previewOf) bar.innerHTML = `Previewing exactly what <strong>${esc(state.me?.name || "this person")}</strong> sees. Read-only. <button class="btn small" type="button" data-exit-preview>Back to admin view</button>`;
    const keys = Object.keys(scopes);
    $("#scopeBar").innerHTML = `<span class="muted">Show</span>${keys.map((k) => `<button type="button" role="radio" aria-checked="${state.scope === k}" data-scope="${k}">${esc(scopes[k])}</button>`).join("")}`;
    $("#scopeBar").hidden = tab === "yearend" || keys.length < 2;
    view.innerHTML = views[tab]();
    // Arrived from a link on the Overview: scroll to that deal/person and flash it once (not again on later refreshes).
    if (focusId && state.focusShown !== location.hash) {
      const el = document.getElementById(`${tab === "deals" ? "deal" : "person"}-${focusId}`);
      if (el) {
        state.focusShown = location.hash;
        el.scrollIntoView({ block: "start" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 2000);
      }
    }
    markTop(); // the page may now be taller or shorter than the screen
  }

  // A background update (prices arriving, the app coming back to the foreground) rebuilds the page. Anything typed into a form
  // on it is kept: we note the values and the cursor first, and put them back afterwards.
  const defaultIndex = (s) => { const marked = [...s.options].findIndex((o) => o.defaultSelected); return marked >= 0 ? marked : 0; }; // a drop-down starts on its first option unless one is marked
  const snapshotForms = () => {
    const saved = {};
    view.querySelectorAll("form [id]").forEach((el) => {
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      const focused = el === document.activeElement;
      // Only what the person actually changed is put back. Untouched (e.g. pre-filled) fields take the fresh values from the server.
      const changed = el.tagName === "SELECT" ? el.selectedIndex !== defaultIndex(el)
        : el.type === "checkbox" || el.type === "radio" ? el.checked !== el.defaultChecked
        : el.value !== el.defaultValue;
      if (changed || focused) saved[el.id] = { changed, value: el.value, checked: el.checked, focused, caret: focused && el.selectionStart != null ? [el.selectionStart, el.selectionEnd] : null };
    });
    return saved;
  };
  const restoreForms = (saved) => {
    for (const [id, s] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (!el || !view.contains(el)) continue;
      if (s.changed) { if (el.type === "checkbox" || el.type === "radio") el.checked = s.checked; else el.value = s.value; }
      if (s.focused) { el.focus(); if (s.caret) { try { el.setSelectionRange(s.caret[0], s.caret[1]); } catch { /* not a text field */ } } }
    }
  };
  const softRender = () => {
    if (!state.role) return;                    // signed out: nothing to update
    const saved = snapshotForms();
    render();
    restoreForms(saved);
  };

  async function refresh(afterPrices = false, soft = false) {
    const data = await api(`/api/data${state.previewOf ? `?as=${encodeURIComponent(state.previewOf)}` : ""}`);
    Object.assign(state, { role: data.role, me: data.me, people: data.people, deals: data.deals, holdings: data.holdings, quotes: data.quotes || {} });
    if (data.role === "admin") Object.assign(state, { adminPeople: data.people, passcodes: data.passcodes || {} });
    if (!state.scope || !allowedScopes()[state.scope]) state.scope = Object.keys(allowedScopes())[0];
    derive();
    if (soft) softRender(); else render();
    // Live prices refresh separately so a slow quote provider never blocks the page; reload once if any price moved.
    if (!afterPrices && state.deals.some((d) => d.ticker)) {
      api(`/api/prices${state.previewOf ? `?as=${encodeURIComponent(state.previewOf)}` : ""}`).then((q) => {
        // Keep the provider's own error text so the Deals tab can say why a price is missing.
        state.priceErrors = Object.fromEntries(Object.entries(q).filter(([, v]) => v.price == null || v.stale || v.error).map(([k, v]) => [k, `${v.error || (v.stale ? "the last live price is out of date" : "no price returned")} (source: ${v.source})`]));
        if (Object.keys(q).some((k) => (q[k].price ?? null) !== (state.quotes[k]?.price ?? null))) refresh(true, true);
        else softRender();
      }).catch(() => {});
    }
  }

  function showLogin() {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#passcode").focus();
  }
  async function showApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;     // shown first: a deep link such as #deals/openai has to scroll to its card
    try { await refresh(); } catch (e) {
      $("#app").hidden = true; $("#login").hidden = false;   // loading failed: back to the sign-in screen, where the message can be seen
      Object.assign(state, { role: null, me: null });
      throw e;
    }
  }

  // ---------- events ----------
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginError").textContent = "";
    $("#retryBtn").hidden = true;
    let signedIn = false;
    try {
      await api("/auth/login", { method: "POST", body: { name: $("#loginName").value, passcode: $("#passcode").value } });
      signedIn = true;
      $("#passcode").value = "";
      state.previewOf = null;
      welcomePending = true;                    // greet the admin once the app is open, even if a retry is needed first
      await showApp();
      maybeWelcome();
    } catch (err) {
      $("#loginError").textContent = err.message;
      $("#retryBtn").hidden = !signedIn;        // signed in but the data didn't load: retry without typing the passcode again
    }
  });
  $("#logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST", body: {} }).catch(() => {}); Object.assign(state, { role: null, me: null, previewOf: null }); showLogin(); };
  $("#themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("plc-theme", document.documentElement.dataset.theme); } catch {}
  };
  try { const t = localStorage.getItem("plc-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  addEventListener("hashchange", () => state.d && render());

  async function submitForm(form, fn) {
    const err = $("[data-err]", form);
    err.textContent = "";
    err.classList.remove("ok");
    const btn = form.querySelector("[type=submit]");
    if (btn) btn.disabled = true;           // a double-click must not submit twice
    try {
      await fn(Object.fromEntries(new FormData(form)));
      try { await refresh(); } catch {        // saved: only the reload failed, so say so and try it again shortly
        err.textContent = "Saved. The list is reloading…"; err.classList.add("ok");
        setTimeout(() => refresh(false, true).catch(() => {}), 3000);
      }
    } catch (e) { err.textContent = e.message; }
    finally { if (btn && btn.isConnected) btn.disabled = false; }
  }
  view.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === "addHolding") submitForm(f, (b) => api("/api/holdings", { method: "POST", body: b }));
    if (f.id === "addDeal") submitForm(f, (b) => api("/api/deals", { method: "POST", body: b }));
    if (f.id === "addPerson") submitForm(f, async (b) => {
      if (b.dealId || b.amount) {
        if (!b.dealId) throw new Error("Choose which deal they invested in, or clear the amount.");
        if (!b.amount) throw new Error("Enter the amount they invested, or choose no investment.");
        return api("/api/investments", { method: "POST", body: { dealId: b.dealId, date: b.date, investors: [{ newPerson: { name: b.name, type: b.type }, invested: b.amount }] } });
      }
      return api("/api/people", { method: "POST", body: { name: b.name, type: b.type } });
    });
  });
  $("#scopeBar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-scope]");
    if (!b) return;
    state.scope = b.dataset.scope;
    try { localStorage.setItem("plc-scope", state.scope); } catch {}
    derive();
    render();
    $(`#scopeBar [data-scope="${state.scope}"]`)?.focus();
  });
  view.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.wiz === "add") window.PLC.wizard.addInvestment();
    if (t.dataset.wiz === "complete") window.PLC.wizard.completeDetails();
    if (t.hasAttribute("data-csv-yearend")) yearEndCsv();
    if (t.dataset.editDeal) editDeal(t.dataset.editDeal);
    if (t.dataset.editPerson) editPerson(t.dataset.editPerson);
    if (t.dataset.editHolding) editHolding(t.dataset.editHolding);
    if (t.dataset.delHolding && confirm("Delete this holding? This can't be undone.")) {
      await api(`/api/holdings/${t.dataset.delHolding}`, { method: "DELETE" }).catch((x) => alert(x.message));
      await refresh();
    }
  });

  // tooltips (hover + keyboard focus)
  const tip = $("#tip");
  const showTip = (el) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
  };
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); el ? showTip(el) : (tip.hidden = true); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); el ? showTip(el) : (tip.hidden = true); });
  document.addEventListener("focusout", () => (tip.hidden = true));

  $("#previewSel").addEventListener("change", (e) => { state.previewOf = e.target.value || null; refresh(); });
  document.addEventListener("click", (e) => { if (e.target.closest("[data-exit-preview]")) { state.previewOf = null; refresh(); } });
  $("#addInvBtn").onclick = () => window.PLC.wizard.addInvestment();
  window.PLC = { state, api, refresh, esc, money, today, dealById, personById };

  // ---------- installable app ----------
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let installEvent = null;
  const updateInstall = () => { $("#installBtn").hidden = standalone() || !(installEvent || isIOS()); };
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; updateInstall(); });
  addEventListener("appinstalled", () => { installEvent = null; updateInstall(); });
  $("#installBtn").onclick = async () => {
    if (installEvent) {
      installEvent.prompt();
      await installEvent.userChoice.catch(() => {});
      installEvent = null;
      updateInstall();
      return;
    }
    dlg.innerHTML = `<h2>Add to your Home Screen</h2>
      <ol><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button (the square with an arrow pointing up).</li><li>Scroll down and tap <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong>.</li></ol>
      <p class="muted">You'll sign in once inside the new app.</p>
      <div class="row-actions"><button class="btn primary" type="button" data-close>Got it</button></div>`;
    $("[data-close]", dlg).onclick = () => dlg.close();
    dlg.showModal();
  };
  updateInstall();
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

  // An installed app can stay open (suspended) for days. Coming back to it must not mean running old code, so on return
  // we compare the deployed files' fingerprints with the ones this page loaded, and reload if a new version is out.
  const WATCH = ["/", "/app.js", "/wizard.js", "/style.css"];
  const fingerprint = async () => {
    try {
      const parts = await Promise.all(WATCH.map(async (u) => {
        const r = await fetch(u, { method: "HEAD", cache: "no-store" });
        if (!r.ok) throw new Error("bad status");
        return r.headers.get("etag") || r.headers.get("last-modified") || r.headers.get("content-length") || "";
      }));
      return parts.join("|");
    } catch { return null; }
  };
  let loadedFingerprint = null;
  // On a first visit the browser installs the service worker and takes over the page, which can cancel this very
  // first request, so keep trying for a few seconds until we have a baseline to compare against.
  const takeBaseline = async () => {
    for (let i = 0; i < 4 && !loadedFingerprint; i++) {
      loadedFingerprint = await fingerprint();
      if (!loadedFingerprint) await new Promise((r) => setTimeout(r, 1500));
    }
  };
  takeBaseline();
  let lastCheck = 0;
  async function checkForUpdate(force = false) {
    if (!force && Date.now() - lastCheck < 10 * 1000) return;
    lastCheck = Date.now();
    if (!loadedFingerprint) { await takeBaseline(); return; }
    const f = await fingerprint();
    if (!f || f === loadedFingerprint) return;
    // Never wipe a form someone is filling in: tell them inside the open window, and update as soon as it closes.
    const open = [dlg, $("#wiz")].find((d) => d.open);
    if (open) { open.setAttribute("data-update", ""); return; }
    location.reload();
  }
  [dlg, $("#wiz")].forEach((d) => d.addEventListener("close", () => { d.removeAttribute("data-update"); checkForUpdate(true); }));
  addEventListener("pageshow", () => checkForUpdate());
  setInterval(() => { if (document.visibilityState === "visible") checkForUpdate(); }, 5 * 60 * 1000);
  window.__plcCheckForUpdate = checkForUpdate; // lets tests trigger a check

  // Also reload the numbers when the app comes back to the foreground after a while.
  let lastSeen = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { lastSeen = Date.now(); return; }
    checkForUpdate();
    if (state.role && Date.now() - lastSeen > 5 * 60 * 1000 && !dlg.open && !$("#wiz").open) refresh(false, true).catch(() => {});
  });

  // ---------- refresh: pull down on a touch screen, or the button in the title bar ----------
  $("#reloadBtn").onclick = () => location.reload();
  (() => {
    const ptr = $("#ptr"), THRESHOLD = 64, MAX = 110;
    let startY = 0, startX = 0, pulling = false, dist = 0, busy = false;
    const show = (d, st) => {
      ptr.dataset.state = st || (d >= THRESHOLD ? "ready" : "pull");
      ptr.style.opacity = String(Math.min(1, d / 40));
      ptr.style.transform = `translate(-50%, ${d - 56}px)`;
      ptr.firstElementChild.style.transform = st === "loading" ? "" : `rotate(${d * 3}deg)`;
    };
    const reset = () => { if (busy) return; pulling = false; ptr.classList.add("snap"); show(0, "idle"); };
    document.addEventListener("touchstart", (e) => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || e.target.closest("dialog") || $("#app").hidden) return;
      startY = e.touches[0].clientY; startX = e.touches[0].clientX; pulling = true; dist = 0; ptr.classList.remove("snap");
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
      if (window.scrollY > 0) { dist = 0; reset(); return; }                         // the page itself is scrolling: put the indicator away
      if (dy <= 0) { dist = 0; startY = e.touches[0].clientY; ptr.classList.add("snap"); show(0, "idle"); return; } // dragged back up: cancel, and a new pull can start from here (at the top the page cannot scroll up, so nothing is lost)
      if (Math.abs(dx) > dy && dist === 0) { pulling = false; return; }              // a sideways swipe
      e.preventDefault();                       // we own this gesture: no native bounce
      dist = Math.min(MAX, dy * 0.5);
      show(dist);
    }, { passive: false });
    document.addEventListener("touchend", () => {
      if (!pulling) return;
      pulling = false;
      if (dist >= THRESHOLD) { busy = true; ptr.classList.add("snap"); show(THRESHOLD, "loading"); setTimeout(() => location.reload(), 250); }
      else reset();
    });
    document.addEventListener("touchcancel", reset);
  })();

  // start
  // A valid session whose data could not be loaded (a flaky connection) offers a retry instead of asking for the passcode again.
  let welcomePending = false;     // set after a sign-in whose data load failed, so the retry still greets the admin
  const maybeWelcome = () => { if (welcomePending && state.role === "admin") window.PLC.wizard?.welcome(); welcomePending = false; };
  const startUp = () => api("/api/session").then((s) => (s.role ? showApp().then(maybeWelcome) : showLogin())).catch((e) => {
    showLogin();
    $("#loginError").textContent = e.message || "Something went wrong.";
    $("#retryBtn").hidden = e.status === 401;   // a revoked session needs a passcode, not a retry
  });
  $("#retryBtn").onclick = () => { $("#retryBtn").hidden = true; $("#loginError").textContent = ""; startUp(); };
  startUp();
})();
