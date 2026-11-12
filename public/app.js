(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  const money = (n) => (n == null ? "—" : usd0.format(n));
  const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`);
  const signed = (n) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${usd0.format(Math.abs(n))}`);
  const dateFmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—");
  // Distribution amounts are kept to the cent. One place decides what is dated and what is not, so Year-end and the Edit holding
  // window can't disagree, and sums never show float noise (0.30000000000000004) on screen or in the CSV.
  const r2 = (n) => Math.round(n * 100) / 100;
  const datedSum = (h) => r2((h.distLog || []).reduce((s, e) => s + e.amount, 0));
  const undatedOf = (h) => { const u = r2(h.distributions - datedSum(h)); return u > 0.004 ? u : 0; };
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
    role: null, me: null, previewOf: null, passcodes: {}, k1: [], accountValues: [], clubSection: "yearend", ownDeals: [], ownHoldings: [], priceErrors: {}, adminPeople: [], quotes: {}, people: [], deals: [], holdings: [], d: null,
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
    const last = Math.max(thisYear, ...club.map((h) => Number(h.date.slice(0, 4))), ...club.flatMap((h) => (h.distLog || []).map((e) => Number(e.date.slice(0, 4)))));
    const sum = (list) => list.reduce((s, h) => s + h.invested, 0);
    // Distributions: the dated entries add up by year. The part of a holding's total that has no date (received before dates were
    // tracked) can't be placed in a year, so it is counted only in the "to date" figure of the current year, and reported separately.
    const logOf = (list) => list.flatMap((h) => h.distLog || []);
    const undated = (list) => r2(list.reduce((s, h) => s + undatedOf(h), 0));
    const sumAmt = (list) => r2(list.reduce((s, e) => s + e.amount, 0));
    const out = [];
    for (let y = last; y >= first; y--) {
      const end = `${y}-12-31`;
      const rows = state.people
        .filter((p) => p.type === "member" || club.some((h) => h.personId === p.id))
        .map((p) => {
          const mine = club.filter((h) => h.personId === p.id);
          const held = mine.filter((h) => h.date <= end), dated = logOf(held), isNow = y === thisYear;
          return {
            p, during: sum(mine.filter((h) => h.date.startsWith(String(y)))), cum: sum(held),
            distDuring: sumAmt(dated.filter((e) => e.date.startsWith(String(y)))),
            undated: undated(held),
            distCum: r2(sumAmt(dated.filter((e) => e.date <= end)) + (isNow ? undated(held) : 0)),   // to date includes the undated part
          };
        });
      const members = rows.filter((r) => r.p.type === "member");
      const others = rows.filter((r) => r.p.type !== "member" && (r.cum || r.during));
      const total = {
        during: members.reduce((s, r) => s + r.during, 0), cum: members.reduce((s, r) => s + r.cum, 0),
        distDuring: r2(members.reduce((s, r) => s + r.distDuring, 0)), distCum: r2(members.reduce((s, r) => s + r.distCum, 0)), undated: r2(members.reduce((s, r) => s + r.undated, 0)),
      };
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
          .map((r) => `<tr><td>${esc(r.p.name)}</td><td class="num">${r.during ? money(r.during) : "—"}</td><td class="num">${r.cum ? money(r.cum) : "—"}</td><td class="num">${Y.total.cum ? pct(r.cum / Y.total.cum, 2) : "—"}</td><td class="num">${r.distDuring ? usd2.format(r.distDuring) : "—"}</td><td class="num">${r.distCum ? usd2.format(r.distCum) : "—"}</td></tr>`)
          .join("");
        const others = Y.others.map((r) => `<tr class="muted"><td>${esc(r.p.name)} (non-member, not counted above)</td><td class="num">${r.during ? money(r.during) : "—"}</td><td class="num">${r.cum ? money(r.cum) : "—"}</td><td class="num"></td><td class="num">${r.distDuring ? usd2.format(r.distDuring) : "—"}</td><td class="num">${r.distCum ? usd2.format(r.distCum) : "—"}</td></tr>`).join("");
        return `<div class="card"><div class="person-head"><h3>${Y.y}${Y.current ? " (so far)" : ""}</h3><span class="muted">${Y.deals.length ? `Deals this year: ${esc(Y.deals.join(", "))}` : "No new deals this year"}</span></div>
          <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Invested during ${Y.y}</th><th class="num">Total invested ${esc(label)}</th><th class="num">% of club</th><th class="num">Distributions during ${Y.y}</th><th class="num">Distributions ${Y.current ? "to date" : `through ${Y.y}`}</th></tr></thead>
          <tbody>${body}${others}</tbody><tfoot><tr><td>Total, club members</td><td class="num">${money(Y.total.during)}</td><td class="num">${money(Y.total.cum)}</td><td class="num">100%</td><td class="num">${usd2.format(Y.total.distDuring)}</td><td class="num">${usd2.format(Y.total.distCum)}</td></tr></tfoot></table></div>
          ${Y.total.undated ? `<p class="muted" style="margin:8px 0 0">${Y.current ? `The to-date distributions include ${usd2.format(Y.total.undated)} received before dates were tracked.` : `${usd2.format(Y.total.undated)} of distributions have no date yet, so they are not counted in any single year here.`}${state.role === "admin" ? " Add dates under Manage > Edit holding." : ""}</p>` : ""}</div>`;
      })
      .join("");
    return `<div class="stack"><div class="section-head"><h2>Year-end investment totals</h2><button class="btn" type="button" data-csv-yearend>Download CSV</button></div>
      <p class="muted" style="margin:-4px 0 0">Power Lunch Club deals only. Individual deals are excluded. Amounts are cash invested (including any upfront management fee), by investment date, not current value. Each year's card shows that year on its own and the running total of that year plus all prior years, for both money invested and distributions received. Distributions are counted in the year of the date they were received. Built from the holdings you've entered, so confirm with your accountant before filing.</p>${cards}</div>`;
  }
  function yearEndCsv() {
    // A name that starts with = + - @ would run as a formula when the file is opened in a spreadsheet, so mark it as text.
    const q = (v) => `"${(typeof v === "string" && /^\s*[=+\-@]|^[\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? "'" : "") + String(v).replace(/"/g, '""')}"`;
    const rows = [["Year", "Holder", "Status", "Invested during year", "Total invested at year-end (or to date)", "% of club members' total", "Distributions during year", "Distributions through year-end (or to date)", "Distributions with no date (only in the to-date figure)"]];
    yearEndData().forEach((Y) => {
      Y.members.forEach((r) => rows.push([Y.y, r.p.name, "member", r.during, r.cum, Y.total.cum ? ((r.cum / Y.total.cum) * 100).toFixed(2) : "", r.distDuring, r.distCum, Y.current ? r.undated : ""]));
      Y.others.forEach((r) => rows.push([Y.y, r.p.name, "non-member", r.during, r.cum, "", r.distDuring, r.distCum, Y.current ? r.undated : ""]));
      rows.push([Y.y, "TOTAL (club members)", "", Y.total.during, Y.total.cum, "100.00", Y.total.distDuring, Y.total.distCum, Y.current ? Y.total.undated : ""]);
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
    const ownCount = state.ownDeals.length, ownPeople = new Set(state.ownDeals.map((d) => d.ownerId)).size;
    return `<div class="stack">
      <div class="card"><h2>Members' own deals</h2><p class="muted" style="margin-top:0">Deals members add for themselves are private to the member and to you, and are left out of the club's totals. ${ownCount ? `<strong>${ownCount}</strong> deal${ownCount === 1 ? "" : "s"} from <strong>${ownPeople}</strong> member${ownPeople === 1 ? "" : "s"}.` : "None have been added yet."}</p><a class="btn" href="#mydeals">Open members' own deals</a></div>
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

  // ---------- Club: Year-end totals, K-1s and Accounts (club members and the admin) ----------
  const clubHoldings = () => state.holdings.filter((h) => dealById(h.dealId)?.channel === "club");
  const lineSum = (r, type) => r2(r.lines.filter((l) => l.type === type).reduce((s, l) => s + l.amount, 0));
  const isClubAdmin = () => state.role === "admin" && !state.previewOf;
  const lastYear = () => new Date().getFullYear() - 1;

  // Shares an amount across weights to the cent so the pieces add up to the amount exactly (largest remainder; works for losses too).
  function splitCents(amount, weights) {
    const total = weights.reduce((s, w) => s + w, 0), cents = Math.round(amount * 100);
    const raw = weights.map((w) => (cents * w) / total), base = raw.map((v) => Math.trunc(v));
    const rest = cents - base.reduce((s, v) => s + v, 0), order = raw.map((v, i) => ({ i, frac: Math.abs(v - base[i]) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < Math.abs(rest); k++) base[order[k % order.length].i] += rest > 0 ? 1 : -1;
    return base.map((c) => c / 100);
  }
  // Each K-1 belongs to the club. It is split across the deal's holders by their share of the money in that deal at 12/31 of the K-1's
  // year (an estimate: the real split follows the partnership agreement, so confirm with your accountant). Nothing per member is stored.
  function k1Data() {
    const club = clubHoldings();
    const perYear = new Map();   // year -> Map(personId -> { income, expenses })
    const unsplit = [];          // K-1s for a year when the deal had no investors yet
    for (const r of state.k1) {
      const held = club.filter((h) => h.dealId === r.dealId && h.date <= `${r.year}-12-31`);
      const total = held.reduce((s, h) => s + h.invested, 0);
      if (!total) { unsplit.push(r); continue; }
      const byPerson = new Map();
      for (const h of held) byPerson.set(h.personId, (byPerson.get(h.personId) || 0) + h.invested);
      const year = perYear.get(r.year) || new Map(), ids = [...byPerson.keys()].sort(), weights = ids.map((pid) => byPerson.get(pid));
      const inc = splitCents(lineSum(r, "income"), weights), exp = splitCents(lineSum(r, "expense"), weights);
      ids.forEach((pid, i) => {
        const a = year.get(pid) || { income: 0, expenses: 0 };
        a.income = r2(a.income + inc[i]); a.expenses = r2(a.expenses + exp[i]);
        year.set(pid, a);
      });
      perYear.set(r.year, year);
    }
    return { perYear, unsplit };
  }

  function k1View() {
    const { perYear, unsplit } = k1Data();
    const years = [...new Set(state.k1.map((r) => r.year))].sort((a, b) => b - a);
    const add = isClubAdmin() ? '<button class="btn primary" type="button" data-add-k1>Add K-1 figures</button>' : "";
    const intro = `<p class="muted" style="margin:-4px 0 0">The club's K-1 for each deal and year, split across the deal's holders by their share of the money in that deal at 12/31 of that year. That split is an estimate (the real one follows the partnership agreement), so confirm with your accountant. Each year shows that year on its own and the running total of that year plus all prior years.</p>`;
    if (!years.length) return `<div class="stack"><div class="section-head"><h2>K-1 income and expenses</h2>${add}</div>${intro}<div class="card"><p class="muted" style="margin:0">No K-1 figures entered yet.${isClubAdmin() ? " Press Add K-1 figures after a deal sends its K-1." : ""}</p></div></div>`;
    const net = (a) => r2((a?.income || 0) - (a?.expenses || 0));
    const cumFor = (pid, y) => r2([...perYear.entries()].filter(([yy]) => yy <= y).reduce((s, [, m]) => s + net(m.get(pid)), 0));
    const cards = years.map((y) => {
      const m = perYear.get(y) || new Map();
      const rowOf = (p) => { const a = m.get(p.id); return { p, income: a?.income || 0, expenses: a?.expenses || 0, net: net(a), cum: cumFor(p.id, y) }; };
      const people = state.people.filter((p) => m.has(p.id)).map(rowOf);
      const members = people.filter((r) => r.p.type === "member"), others = people.filter((r) => r.p.type !== "member");
      const sum = (k) => r2(members.reduce((s, r) => s + r[k], 0));
      const cell = (n) => (n ? signed2(n) : "—");
      const row = (r, muted) => `<tr${muted ? ' class="muted"' : ""}><td>${esc(r.p.name)}${muted ? " (non-member, not counted above)" : ""}</td><td class="num">${r.income ? usd2.format(r.income) : "—"}</td><td class="num">${r.expenses ? usd2.format(r.expenses) : "—"}</td><td class="num">${cell(r.net)}</td><td class="num">${cell(r.cum)}</td></tr>`;
      const recs = state.k1.filter((r) => r.year === y).sort((a, b) => (dealById(a.dealId)?.name || "").localeCompare(dealById(b.dealId)?.name || ""));
      const recHtml = recs.map((r) => `<li><div class="person-head" style="margin:0"><span><strong>${esc(dealById(r.dealId)?.name || "Deal")}</strong> · income ${usd2.format(lineSum(r, "income"))} · expenses ${usd2.format(lineSum(r, "expense"))}</span>${isClubAdmin() ? `<button class="btn small" type="button" data-edit-k1="${esc(r.id)}">Edit</button>` : ""}</div>
        <details><summary>${r.lines.length} line${r.lines.length === 1 ? "" : "s"}</summary><ul>${r.lines.map((l) => `<li>${esc(l.label)} (${l.type}): ${usd2.format(l.amount)}</li>`).join("")}</ul>${r.note ? `<p class="muted">${esc(r.note)}</p>` : ""}</details></li>`).join("");
      return `<div class="card"><div class="person-head"><h3>${y}${y === new Date().getFullYear() ? " (so far)" : ""}</h3></div>
        <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">K-1 income ${y}</th><th class="num">K-1 expenses ${y}</th><th class="num">Net ${y}</th><th class="num">Net through ${y}</th></tr></thead>
        <tbody>${members.map((r) => row(r, false)).join("")}${others.map((r) => row(r, true)).join("")}</tbody>
        <tfoot><tr><td>Total, club members</td><td class="num">${usd2.format(sum("income"))}</td><td class="num">${usd2.format(sum("expenses"))}</td><td class="num">${cell(sum("net"))}</td><td class="num">${cell(sum("cum"))}</td></tr></tfoot></table></div>
        <ul class="k1list">${recHtml}</ul></div>`;
    });
    const orphan = unsplit.length ? `<p class="banner">${unsplit.map((r) => `${esc(dealById(r.dealId)?.name || "A deal")} ${r.year}`).join(", ")}: no investors in that deal by 12/31 of the year, so ${unsplit.length === 1 ? "its K-1 can't" : "their K-1s can't"} be split across members.</p>` : "";
    return `<div class="stack"><div class="section-head"><h2>K-1 income and expenses</h2>${add}</div>${intro}${orphan}${cards.join("")}</div>`;
  }
  const signed2 = (n) => `${n < 0 ? "−" : ""}${usd2.format(Math.abs(n))}`;

  // Each member's capital account in the club: start of year + money put in + K-1 net income − distributions = end of year.
  function capitalData() {
    const ye = yearEndData().slice().reverse();   // oldest first
    const { perYear } = k1Data();
    const ends = new Map();                       // personId -> balance at the end of the previous year
    const out = [];
    for (const Y of ye) {
      const k = perYear.get(Y.y) || new Map();
      const rowFor = (r) => {
        const a = k.get(r.p.id), start = ends.get(r.p.id) || 0, k1 = r2((a?.income || 0) - (a?.expenses || 0));
        const dist = r2(r.distDuring + (Y.current ? r.undated : 0));   // this year's figure also takes the distributions that have no date, so it matches Year-end's to-date total
        const end = r2(start + r.during + k1 - dist);
        ends.set(r.p.id, end);
        return { p: r.p, start, contrib: r.during, k1, dist, end };
      };
      const members = Y.members.map(rowFor), others = Y.others.map(rowFor);
      const tot = (key) => r2(members.reduce((s, r) => s + r[key], 0));
      out.push({ y: Y.y, current: Y.current, members, others, total: { start: tot("start"), contrib: tot("contrib"), k1: tot("k1"), dist: tot("dist"), end: tot("end") }, undated: Y.total.undated });
    }
    return out.reverse();                         // newest first
  }

  function accountsView() {
    const admin = isClubAdmin();
    const years = [...new Set(state.accountValues.map((v) => v.year))].sort((a, b) => b - a);
    const dealIds = [...new Set(state.accountValues.map((v) => v.dealId))];
    const names = (id) => dealById(id)?.name || "Deal";
    const valuesTable = !years.length
      ? `<p class="muted" style="margin:0">No year-end account values entered yet.${admin ? " Press Add a year-end value to record what a deal's statement shows at 12/31." : ""}</p>`
      : `<div class="table-wrap"><table><thead><tr><th>Deal</th>${years.map((y) => `<th class="num">12/31/${y}</th>`).join("")}</tr></thead><tbody>${dealIds
          .slice().sort((a, b) => names(a).localeCompare(names(b)))
          .map((id) => `<tr><td>${esc(names(id))}</td>${years.map((y) => {
            const v = state.accountValues.find((x) => x.dealId === id && x.year === y);
            if (!v) return '<td class="num muted">—</td>';
            const prev = state.accountValues.filter((x) => x.dealId === id && x.year < y).sort((a, b) => b.year - a.year)[0];
            const delta = prev ? v.value - prev.value : null;
            const change = prev ? `<div class="${cls(delta)}" style="font-size:12px">${delta >= 0 ? "+" : "−"}${usd0.format(Math.abs(delta))}${prev.value ? ` (${delta >= 0 ? "+" : "−"}${(Math.abs(delta / prev.value) * 100).toFixed(1)}%)` : ""} vs ${prev.year}</div>` : "";
            const val = admin ? `<button class="btn small ghost" type="button" data-edit-acct="${esc(v.id)}" title="${esc(v.note || "Edit")}">${usd0.format(v.value)}</button>` : `<span title="${esc(v.note || "")}">${usd0.format(v.value)}</span>`;
            return `<td class="num">${val}${change}</td>`;
          }).join("")}</tr>`).join("")}</tbody></table></div>`;
    const cap = capitalData();
    const capCards = cap.map((C) => {
      const row = (r, muted) => `<tr${muted ? ' class="muted"' : ""}><td>${esc(r.p.name)}${muted ? " (non-member, not counted above)" : ""}</td><td class="num">${usd2.format(r.start)}</td><td class="num">${r.contrib ? usd2.format(r.contrib) : "—"}</td><td class="num">${r.k1 ? signed2(r.k1) : "—"}</td><td class="num">${r.dist ? usd2.format(r.dist) : "—"}</td><td class="num"><strong>${usd2.format(r.end)}</strong></td></tr>`;
      return `<div class="card"><div class="person-head"><h3>${C.y}${C.current ? " (so far)" : ""}</h3></div>
        <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Start of ${C.y}</th><th class="num">Money in</th><th class="num">K-1 net income</th><th class="num">Distributions</th><th class="num">${C.current ? "Now" : `End of ${C.y}`}</th></tr></thead>
        <tbody>${C.members.map((r) => row(r, false)).join("")}${C.others.map((r) => row(r, true)).join("")}</tbody>
        <tfoot><tr><td>Total, club members</td><td class="num">${usd2.format(C.total.start)}</td><td class="num">${usd2.format(C.total.contrib)}</td><td class="num">${signed2(C.total.k1)}</td><td class="num">${usd2.format(C.total.dist)}</td><td class="num">${usd2.format(C.total.end)}</td></tr></tfoot></table></div></div>`;
    }).join("");
    const undated = cap.length ? cap[0].undated : 0;
    return `<div class="stack">
      <div class="section-head"><h2>Account values</h2>${admin ? '<button class="btn primary" type="button" data-add-acct>Add a year-end value</button>' : ""}</div>
      <div class="card"><h3>Deal account values at year-end</h3><p class="muted" style="margin:4px 0 10px">What each club deal's statement shows at 12/31, with the change from the previous year recorded.</p>${valuesTable}</div>
      <h3 style="margin:8px 0 0">Member capital accounts</h3>
      <p class="muted" style="margin:-4px 0 0">Start of year, plus money put in during the year (including any upfront fee), plus K-1 net income (the K-1s split as described under K-1), minus the distributions received during the year, equals the end of the year. It's built from what is entered here, so it is an estimate to compare with your K-1s and statements.${undated ? ` The current year's distributions include ${usd2.format(undated)} received before dates were tracked, so the balance now matches Year-end's to-date figure.` : ""}</p>
      ${cap.length ? capCards : '<div class="card"><p class="muted" style="margin:0">No Power Lunch Club investments yet.</p></div>'}</div>`;
  }

  function club() {
    const sec = ["yearend", "k1", "accounts"].includes(state.clubSection) ? state.clubSection : "yearend";
    const tabs = [["yearend", "Year-end"], ["k1", "K-1"], ["accounts", "Accounts"]];
    const nav = `<div class="clubnav" role="radiogroup" aria-label="Club records">${tabs.map(([k, label]) => `<button type="button" role="radio" aria-checked="${sec === k}" data-club-sec="${k}">${label}</button>`).join("")}</div>`;
    return `<div class="stack">${nav}${sec === "k1" ? k1View() : sec === "accounts" ? accountsView() : yearend()}</div>`;
  }

  // The K-1 entry window: a deal, a year, and any number of income / expense lines (a loss is a negative income line).
  function editK1(id) {
    const r = id ? state.k1.find((x) => x.id === id) : null;
    const clubDeals = state.deals.filter((d) => d.channel === "club");
    if (!clubDeals.length) { alert("Add a Power Lunch Club deal first."); return; }
    const lines = r ? r.lines : [{ type: "income", label: "Ordinary income", amount: "" }, { type: "expense", label: "Expenses", amount: "" }];
    let n = 0;
    const row = (l) => { const i = n++; return `<div class="k1row"><select class="k1t" name="t${i}" aria-label="Line type"><option value="income"${l.type === "income" ? " selected" : ""}>Income</option><option value="expense"${l.type === "expense" ? " selected" : ""}>Expense</option></select><input class="k1l" name="l${i}" maxlength="60" placeholder="e.g. Interest" aria-label="Line description" value="${esc(l.label || "")}"><input class="k1a" name="a${i}" type="number" step="0.01" inputmode="decimal" placeholder="Amount" aria-label="Amount" value="${l.amount === "" ? "" : esc(String(l.amount))}"></div>`; };
    openDialog(
      `<h2>${r ? "Edit K-1 figures" : "Add K-1 figures"}</h2>
      <div class="form-grid">
        <div><label for="k-deal">Deal</label><select id="k-deal" name="dealId">${options(clubDeals, r?.dealId)}</select></div>
        <div><label for="k-year">Tax year</label><input id="k-year" name="year" type="number" min="1990" max="${lastYear() + 1}" step="1" value="${r?.year ?? lastYear()}" required></div>
      </div>
      <p class="muted" style="margin:10px 0 4px">Income and expense lines from the K-1. Enter a loss as negative income. Blank lines are ignored.</p>
      <div id="k1rows">${lines.map(row).join("")}</div>
      <button class="btn small" type="button" id="k1more">+ Add a line</button>
      <label for="k-note">Note (optional)</label><input id="k-note" name="note" maxlength="500" value="${esc(r?.note || "")}">`,
      (f) => {
        const out = [];
        for (const key of Object.keys(f)) { const m = /^a(\d+)$/.exec(key); if (m) out.push({ type: f["t" + m[1]], label: f["l" + m[1]], amount: f[key] }); }
        return api(r ? `/api/k1/${id}` : "/api/k1", { method: r ? "PUT" : "POST", body: { dealId: f.dealId, year: f.year, note: f.note, lines: out } });
      },
      r ? { label: "Delete K-1", run: async () => { if (!confirm("Delete this K-1? This can't be undone.")) return false; await api(`/api/k1/${id}`, { method: "DELETE" }); return true; } } : undefined,
    );
    $("#k1more", dlg).onclick = () => { $("#k1rows", dlg).insertAdjacentHTML("beforeend", row({ type: "income", label: "", amount: "" })); };
  }

  function editAcct(id) {
    const r = id ? state.accountValues.find((x) => x.id === id) : null;
    const clubDeals = state.deals.filter((d) => d.channel === "club");
    if (!clubDeals.length) { alert("Add a Power Lunch Club deal first."); return; }
    openDialog(
      `<h2>${r ? "Edit year-end value" : "Add a year-end value"}</h2>
      <div class="form-grid">
        <div><label for="v-deal">Deal</label><select id="v-deal" name="dealId">${options(clubDeals, r?.dealId)}</select></div>
        <div><label for="v-year">At 12/31 of</label><input id="v-year" name="year" type="number" min="1990" max="${lastYear() + 1}" step="1" value="${r?.year ?? lastYear()}" required></div>
        <div><label for="v-val">Account value ($)</label><input id="v-val" name="value" type="number" min="0" step="0.01" inputmode="decimal" value="${r ? esc(String(r.value)) : ""}" required></div>
      </div>
      <label for="v-note">Source or note (optional)</label><input id="v-note" name="note" maxlength="500" value="${esc(r?.note || "")}" placeholder="e.g. Q4 statement">`,
      (f) => api(r ? `/api/accountvalues/${id}` : "/api/accountvalues", { method: r ? "PUT" : "POST", body: { dealId: f.dealId, year: f.year, value: f.value, note: f.note } }),
      r ? { label: "Delete value", run: async () => { if (!confirm("Delete this value? This can't be undone.")) return false; await api(`/api/accountvalues/${id}`, { method: "DELETE" }); return true; } } : undefined,
    );
  }

  // ---------- My deals: deals a person adds for themselves; private to them and the admin ----------
  function mydeals() {
    const adminAll = state.role === "admin" && !state.previewOf;
    const canAdd = !!state.me && !state.previewOf;
    const list = state.ownDeals.slice().sort((a, b) => (personById(a.ownerId)?.name || "").localeCompare(personById(b.ownerId)?.name || "") || a.name.localeCompare(b.name));
    const cards = list.map((d) => {
      const hs = state.ownHoldings.filter((h) => h.dealId === d.id);
      const invested = hs.reduce((s, h) => s + h.invested, 0), net = hs.reduce((s, h) => s + h.value, 0), dist = hs.reduce((s, h) => s + h.distributions, 0), carry = hs.reduce((s, h) => s + h.carry, 0);
      const gain = net + dist - invested;
      return `<div class="card" id="own-${esc(d.id)}"><div class="person-head"><h3>${esc(d.name)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}${d.price ? ` ${usd2.format(d.price)}` : ""}</span>` : ""}</h3>
        <span>${state.previewOf ? "" : `<button class="btn small" data-edit-own="${esc(d.id)}">Edit deal</button>`}</span></div>
        ${adminAll ? `<p class="muted" style="margin:0 0 10px">Added by <strong>${esc(personById(d.ownerId)?.name || "someone")}</strong></p>` : ""}
        <p class="muted" style="margin:0 0 10px">${d.sharesHeld ? `Shares held: <strong>${fmtShares(d.sharesHeld)}${d.ticker ? ` ${esc(d.ticker)}` : ""}</strong> · ` : ""}Invested <strong>${money(invested)}</strong> · Net value <strong>${money(net)}</strong> ${basisBadge({ basis: d.basis, note: dealNote(d) })} · <span class="${cls(gain)}">${signed(gain)} (${gainPct(gain, invested)}) net of carry</span></p>
        <p class="muted" style="margin:0 0 10px">${termsText(d) ? `Terms: ${esc(termsText(d))}. ` : "Fee and carry terms not entered. "}Carry ${money(carry)}${dist ? ` · distributions received ${money(dist)}` : ""}${d.basis !== "live" && d.valueAsOf ? ` · value as of ${dateFmt(d.valueAsOf)}` : ""}</p>
        ${d.needsShares ? `<p class="banner">Ticker ${esc(d.ticker)} is set but the share count isn't, so this deal is not priced live yet.${d.priceError || state.priceErrors[d.ticker] ? ` (Price lookup: ${esc(d.priceError || state.priceErrors[d.ticker])})` : ""}</p>` : ""}
        ${d.ticker && !d.needsShares && !d.price ? `<p class="muted">Live price unavailable: ${esc(d.priceError || state.priceErrors[d.ticker] || "still checking")}</p>` : ""}
        ${splitNotice(d)}
        ${d.notes ? `<p class="muted">${esc(d.notes)}</p>` : ""}</div>`;
    });
    return `<div class="stack">
      <div class="card"><h2>${adminAll ? "Members' own deals" : "My deals"}</h2>
        <p class="muted" style="margin-top:0">${adminAll ? "Deals members added for themselves. Each one is visible only to the member who added it and to you, and is left out of the club's totals and the year-end figures. You can edit any of them." : "Deals you add here are private: only you and the admin can see them. They are kept apart from the club's deals and from your other investments, and are not part of any club totals. You can edit or delete them, but you can't add other investors."}</p>
        ${canAdd ? '<div class="row-actions" style="margin-top:0"><button class="btn primary" type="button" data-add-own>Add a deal</button></div>' : ""}${adminAll ? '<a class="btn" href="#admin">Back to Manage</a>' : ""}</div>
      ${cards.length ? cards.join("") : `<div class="card"><p class="muted" style="margin:0">${adminAll ? "No member has added a deal yet." : "You haven't added any deals yet."}</p></div>`}</div>`;
  }
  function addOwnDeal() {
    openDialog(
      `<h2>Add a deal</h2>
      <p class="muted" style="margin-top:0">Only you and the admin will see this deal.</p>
      <div class="form-grid">
        <div><label for="o-name">Deal name</label><input id="o-name" name="name" required maxlength="120"></div>
        <div><label for="o-inv">Amount you invested ($)</label><input id="o-inv" name="invested" type="number" min="0" step="0.01" inputmode="decimal" required></div>
        <div><label for="o-date">Date invested</label><input id="o-date" name="date" type="date" max="${today()}" value="${today()}" required></div>
        <div><label for="o-tk">Ticker (if public)</label><input id="o-tk" name="ticker" maxlength="10"></div>
        <div><label for="o-sh">Shares held (whole deal)</label><input id="o-sh" name="sharesHeld" type="number" min="0" step="any"></div>
        <div><label for="o-val">Current value ($, whole deal, before carry)</label><input id="o-val" name="manualValue" type="number" min="0" step="0.01"></div>
        <div><label for="o-src">Where does the value come from?</label><select id="o-src" name="valueSource"><option value="estimate">My estimate</option><option value="statement">A statement</option></select></div>
        <div><label for="o-fee">Upfront mgmt fee (% of amount invested)</label><input id="o-fee" name="mgmtFeePct" type="number" min="0" max="100" step="0.01"></div>
        <div><label for="o-carry">Carry (% of profit)</label><input id="o-carry" name="carryPct" type="number" min="0" max="100" step="0.01"></div>
      </div>
      <label for="o-notes">Notes</label><input id="o-notes" name="notes" maxlength="500">
      <p class="muted">If you give a ticker and a share count, the live price is used instead of the value you type.</p>`,
      (f) => api("/api/mine/deals", { method: "POST", body: f }),
    );
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
      const save = $("button[type=submit]", e.target);
      if (save.disabled) return;   // a second tap while the first is still being saved
      save.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(e.target)));
        dlg.close();
        await refresh();
      } catch (err) {
        $("[data-err]", dlg).textContent = err.message;
        save.disabled = false;
      }
    };
    dlg.showModal();
  }
  async function deleteDeal(id) {
    const d = dealById(id);
    const hs = state.holdings.filter((h) => h.dealId === id);
    const recs = state.k1.filter((r) => r.dealId === id).length + state.accountValues.filter((r) => r.dealId === id).length;
    const also = [hs.length ? `its ${hs.length} holding${hs.length === 1 ? "" : "s"} (${money(hs.reduce((s, h) => s + h.invested, 0))} invested)` : "", recs ? `its ${recs} K-1 and year-end value record${recs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" AND ");
    const msg = also ? `Delete "${d.name}" AND ${also}? This can't be undone.` : `Delete "${d.name}"? This can't be undone.`;
    if (!confirm(msg)) return false;
    await api(`/api/deals/${id}${hs.length || recs ? "?cascade=1" : ""}`, { method: "DELETE" });
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
    const nOwn = state.ownHoldings.filter((h) => h.personId === id).length;   // in their own private deals (kept out of state.holdings)
    const n = state.holdings.filter((h) => h.personId === id).length + nOwn;
    openDialog(
      `<h2>${esc(p.name)}</h2>
      <label for="p-name">Name</label><input id="p-name" name="name" value="${esc(p.name)}" required>
      <label for="p-type">Status</label><select id="p-type" name="type"><option value="member"${p.type === "member" ? " selected" : ""}>Club member</option><option value="non-member"${p.type !== "member" ? " selected" : ""}>Not a club member</option></select>
      <label for="p-code">Sign-in passcode</label>
      <div class="inv-row" style="grid-template-columns:1fr auto auto"><input id="p-code" name="passcode" autocomplete="off" spellcheck="false" placeholder="${state.passcodes[id] ? "Set. Type a new one to replace it" : "Not set. This person can't sign in yet"}"><button type="button" class="btn small" data-gen>Generate</button>${state.passcodes[id] ? '<button type="button" class="btn small danger" data-rmcode>Remove</button>' : ""}</div>
      <p class="muted">At least 8 characters. Generate makes an easy-to-say 8-character code (like rakobu47). It's stored scrambled and can't be shown again, so copy it before saving and send it to ${esc(p.name)} privately. Changing or removing it signs them out. They sign in with their name (${esc(p.name)}) and this passcode.</p>
      <p class="muted">${n ? `${n} holding${n === 1 ? "" : "s"}${nOwn ? ` (${nOwn} in their own private deals, under Manage > Members' own deals)` : ""}. To delete this person, delete or reassign their holdings first.` : "No holdings, so this person can be deleted."}</p>`,
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
  const ownHoldingOf = (dealId) => state.ownHoldings.find((h) => h.dealId === dealId);
  async function deleteOwnDeal(id) {
    const d = state.ownDeals.find((x) => x.id === id);
    if (!d) return true; // already gone (deleted elsewhere); just close and reload
    if (!confirm(`Delete "${d.name}" and the investment in it? This can't be undone.`)) return false;
    await api(`/api/mine/deals/${id}`, { method: "DELETE" });
    return true;
  }
  // own = a deal a person added for themselves (My deals); otherwise one of the shared deals the admin manages.
  function editDeal(id, own = false) {
    const d = own ? state.ownDeals.find((x) => x.id === id) : dealById(id);
    const h = own ? ownHoldingOf(id) : null;
    const base = own ? `/api/mine/deals/${id}` : `/api/deals/${id}`;
    openDialog(
      `<h2>${esc(d.name)}</h2>
      <div class="form-grid">
        <div><label for="e-name">Name</label><input id="e-name" name="name" value="${esc(d.name)}" required></div>
        ${own ? "" : `<div><label for="e-ch">Held through</label><select id="e-ch" name="channel"><option value="club"${d.channel === "club" ? " selected" : ""}>Power Lunch Club</option><option value="individual"${d.channel === "individual" ? " selected" : ""}>Individual</option></select></div>`}
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
        ${own ? `<div><label for="e-inv">Amount you invested ($)</label><input id="e-inv" name="invested" type="number" min="0" step="0.01" value="${h?.invested ?? ""}" required></div>
        <div><label for="e-idate">Date invested</label><input id="e-idate" name="date" type="date" value="${esc(h?.date || today())}" required></div>
        <div><label for="e-dist">Distributions received ($)</label><input id="e-dist" name="distributions" type="number" min="0" step="0.01" value="${h?.distributions ?? 0}"></div>` : ""}
      </div>
      <label for="e-vn">Note for the value history (optional)</label><input id="e-vn" name="valueNote">
      <label for="e-notes">Deal notes</label><input id="e-notes" name="notes" value="${esc(d.notes || "")}">
      <p class="muted">If a ticker and share count are both set and a live price is available, the live price overrides the manual value.</p>
      ${d.splitLog?.length ? `<details><summary>Split history (${d.splitLog.length})</summary><ul>${d.splitLog.slice().reverse().map((x) => `<li>${dateFmt(x.date)}: ${esc(String(x.to))}-for-${esc(String(x.from))}, ${fmtShares(x.before)} → ${fmtShares(x.after)} shares (${esc((x.source || "Recorded").toLowerCase())})</li>`).join("")}</ul></details>` : ""}
      ${d.valueHistory?.length ? `<details><summary>Value history (${d.valueHistory.length})</summary><ul>${d.valueHistory.slice().reverse().map((v) => `<li>${esc(new Date(v.at).toLocaleDateString())}: ${money(v.value)} (${esc(v.source)})${v.note ? ` - ${esc(v.note)}` : ""}</li>`).join("")}</ul></details>` : ""}`,
      (f) => api(base, { method: "PUT", body: f }),
      { label: "Delete deal", run: () => (own ? deleteOwnDeal(id) : deleteDeal(id)) },
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
          await api(`${base}/split`, { method: "POST", body: { to, from, date } });
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
        <div><label for="h-dist">Distributions, total ($)</label><input id="h-dist" name="distributions" type="number" min="0" step="0.01" value="${h.distributions}"></div></div>
      <h3 style="margin-top:16px">Dated distributions</h3>
      <p class="muted" style="margin:4px 0 8px">Add each distribution with the date it was received, so Year-end can add them up by year. ${datedBits(h)} Adding or removing one changes the total above, and saves right away; any other changes typed in this window are not saved.</p>
      ${(h.distLog || []).length ? `<ul class="distlist">${(h.distLog || []).map((e) => `<li><span>${dateFmt(e.date)} · <strong>${usd2.format(e.amount)}</strong></span> <button class="btn small danger" type="button" data-del-dist="${esc(e.id)}" aria-label="Remove the ${esc(usd2.format(e.amount))} distribution from ${esc(dateFmt(e.date))}">Remove</button></li>`).join("")}</ul>` : ""}
      <div class="form-grid">
        <div><label for="di-date">Date received</label><input id="di-date" type="date" min="${esc(h.date)}" max="${today()}" value="${today()}"></div>
        <div><label for="di-amt">Amount ($)</label><input id="di-amt" type="number" min="0" step="0.01" inputmode="decimal"></div>
      </div>
      <p id="di-err" class="error" role="alert"></p>
      <button class="btn" type="button" id="di-add">Add distribution</button>`,
      (f) => api(`/api/holdings/${id}`, { method: "PUT", body: f }),
      { label: "Delete holding", run: async () => { if (!confirm("Delete this holding? This can't be undone.")) return false; await api(`/api/holdings/${id}`, { method: "DELETE" }); return true; } },
    );
    const formState = () => JSON.stringify([...new FormData($("#dlgForm", dlg))]);
    const openState = formState();
    let busy = false;
    const change = async (call) => {   // add or remove one dated distribution, then reopen this window with the new list
      if (busy) return;
      const err = $("#di-err", dlg);
      if (formState() !== openState && !confirm("You have unsaved changes in this window. Changing the dated distributions saves right away and discards them. Continue?")) return;
      busy = true; err.textContent = "";
      try { await call(); } catch (e) { err.textContent = e.message; busy = false; return; }
      const stillOpen = dlg.open;   // the admin may have pressed Cancel while the request was running
      dlg.close();
      let fresh = true;
      try { await refresh(); } catch { fresh = false; setTimeout(() => refresh(false, true).catch(() => {}), 3000); }
      if (!fresh) { alert("Saved, but the list couldn't reload. Pull down to refresh before changing it again."); return; }
      if (stillOpen && state.holdings.some((x) => x.id === id)) editHolding(id);
    };
    const add = () => {
      const date = $("#di-date", dlg).value, amount = Number($("#di-amt", dlg).value), err = $("#di-err", dlg);
      if (!date || date > today() || date < h.date) { err.textContent = `Choose the date it was received: on or after ${dateFmt(h.date)}, and not in the future.`; return; }
      if (!(amount > 0)) { err.textContent = "Enter the amount received (more than 0)."; return; }
      change(() => api(`/api/holdings/${id}/distributions`, { method: "POST", body: { date, amount } }));
    };
    $("#di-add", dlg).onclick = add;
    for (const el of [$("#di-date", dlg), $("#di-amt", dlg)]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) add(); } });   // Enter must not save the rest of the form
    dlg.querySelectorAll("[data-del-dist]").forEach((b) => (b.onclick = () => {
      const e = (h.distLog || []).find((x) => x.id === b.dataset.delDist);
      if (e && !confirm(`Remove the ${usd2.format(e.amount)} distribution received ${dateFmt(e.date)}? This lowers the holding's total distributions.`)) return;
      change(() => api(`/api/holdings/${id}/distributions/${b.dataset.delDist}`, { method: "DELETE" }));
    }));
  }
  // "$X of the $Y total has dates; $Z is earlier and undated."
  function datedBits(h) {
    const dated = datedSum(h), undated = undatedOf(h);
    return `Total ${usd2.format(h.distributions)}: ${usd2.format(dated)} dated${undated ? `, ${usd2.format(undated)} received before dates were tracked` : ""}.`;
  }

  // ---------- shell ----------
  const view = $("#view");
  const views = { overview, people, deals, club, mydeals, admin };
  const isAdminSession = () => state.role === "admin" || !!state.previewOf;
  const canYearEnd = () => state.role === "admin" || state.me?.type === "member";
  function allowedScopes() {
    if (state.role === "admin") return { all: "All", club: "Power Lunch Club", individual: "Individual" };
    if (state.me?.type === "member") return { club: "Power Lunch Club", individual: "My individual investments" };
    return { all: "My investments" };
  }
  function render() {
    const [rawTab, focusId] = (location.hash || "#overview").slice(1).split("/");
    let tab = rawTab === "yearend" ? "club" : rawTab;   // #yearend was the old name of this tab
    if (!views[tab] || (tab === "admin" && state.role !== "admin") || (tab === "club" && !canYearEnd())) tab = "overview";
    const scopes = allowedScopes();
    if (!scopes[state.scope]) { state.scope = Object.keys(scopes)[0]; derive(); }
    const adminOwn = tab === "mydeals" && state.role === "admin" && !state.previewOf;
    document.querySelectorAll("#tabs a").forEach((a) => (a.dataset.tab === tab || (adminOwn && a.dataset.tab === "admin") ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $("#adminTab").hidden = state.role !== "admin";
    $("#addInvBtn").hidden = state.role !== "admin";
    document.querySelector('#tabs a[data-tab="club"]').hidden = !canYearEnd();
    document.querySelector('#tabs a[data-tab="mydeals"]').hidden = state.role === "admin" && !state.previewOf; // the admin opens these from Manage, so the tab bar keeps its five tabs
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
    $("#scopeBar").hidden = tab === "club" || tab === "mydeals" || keys.length < 2;
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
    Object.assign(state, { role: data.role, me: data.me, people: data.people, deals: data.deals, holdings: data.holdings, ownDeals: data.ownDeals || [], ownHoldings: data.ownHoldings || [], k1: data.k1 || [], accountValues: data.accountValues || [], quotes: data.quotes || {} });
    if (data.role === "admin") Object.assign(state, { adminPeople: data.people, passcodes: data.passcodes || {} });
    if (!state.scope || !allowedScopes()[state.scope]) state.scope = Object.keys(allowedScopes())[0];
    derive();
    if (soft) softRender(); else render();
    // Live prices refresh separately so a slow quote provider never blocks the page; reload once if any price moved.
    if (!afterPrices && [...state.deals, ...state.ownDeals].some((d) => d.ticker)) {
      api(`/api/prices${state.previewOf ? `?as=${encodeURIComponent(state.previewOf)}` : ""}`).then((q) => {
        // Keep the provider's own error text so the Deals tab can say why a price is missing.
        state.priceErrors = Object.fromEntries(Object.entries(q).filter(([, v]) => v.price == null || v.stale || v.error).map(([k, v]) => [k, `${v.error || (v.stale ? "the last live price is out of date" : "no price returned")} (source: ${v.source})`]));
        if (Object.keys(q).some((k) => (q[k].price ?? null) !== (state.quotes[k]?.price ?? null))) refresh(true, true);
        else softRender();
      }).catch(() => {});
    }
  }

  $("#showPass").onchange = (e) => { $("#passcode").type = e.target.checked ? "text" : "password"; };
  function showLogin() {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#showPass").checked = false; $("#passcode").type = "password";   // never leave a passcode showing on the next visit
    $("#passcode").focus();
  }
  addEventListener("pageshow", () => { if (!$("#login").hidden) { $("#showPass").checked = false; $("#passcode").type = "password"; } });   // a page restored from the back/forward cache
  async function showApp() {
    $("#login").hidden = true;
    $("#showPass").checked = false; $("#passcode").type = "password";
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
  // One small half-and-half moon at the end of the tabs. Its label (for screen readers and the hover tip) names the mode it switches to.
  const isDark = () => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const paintTheme = () => {
    const btn = $("#themeBtn"), label = isDark() ? "Switch to Light mode" : "Switch to Dark mode";
    btn.setAttribute("aria-label", label);
    btn.title = label;
  };
  $("#themeBtn").onclick = () => {
    document.documentElement.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("plc-theme", document.documentElement.dataset.theme); } catch {}
    paintTheme();
  };
  try { const t = localStorage.getItem("plc-theme"); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; } catch {}
  paintTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", paintTheme);   // follows the phone's setting until you choose
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
    if (t.dataset.clubSec) { state.clubSection = t.dataset.clubSec; render(); }
    if (t.hasAttribute("data-add-k1")) editK1(null);
    if (t.dataset.editK1) editK1(t.dataset.editK1);
    if (t.hasAttribute("data-add-acct")) editAcct(null);
    if (t.dataset.editAcct) editAcct(t.dataset.editAcct);
    if (t.dataset.editOwn) editDeal(t.dataset.editOwn, true);
    if (t.hasAttribute("data-add-own")) addOwnDeal();
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
