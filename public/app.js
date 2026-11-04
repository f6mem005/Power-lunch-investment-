(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  const money = (n) => (n == null ? "—" : usd0.format(n));
  const pct = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`);
  const signed = (n) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${usd0.format(Math.abs(n))}`);
  const dateFmt = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—");
  const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");

  const state = {
    scope: (() => { try { return localStorage.getItem("plc-scope") || ""; } catch { return ""; } })(),
    role: null, me: null, previewOf: null, passcodes: {}, adminPeople: [], quotes: {}, people: [], deals: [], holdings: [], d: null,
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: opts.method && opts.method !== "GET" ? { "content-type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith("/auth/")) showLogin();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  const legend = () => `<div class="legend">${state.people.map((p) => `<span><i class="sw" style="background:${color(p.id)}"></i>${esc(p.name)}${p.type === "non-member" ? " (non-member)" : ""}</span>`).join("")}</div>`;

  // ---------- views ----------
  function overview() {
    const { deals, total, people } = state.d;
    const f = state.scope;
    const scopedDeals = scopedDealList();
    const hs = state.d.holdings;
    const estimated = scopedDeals.filter((d) => ["placeholder", "cost", "estimate"].includes(deals[d.id].basis));
    const noTerms = scopedDeals.filter((d) => d.mgmtFeePct == null && d.carryPct == null);
    const kpi = (label, value, sub, c = "") => `<div class="card kpi"><div class="label">${label}</div><div class="value ${c}">${value}</div><div class="sub">${sub}</div></div>`;
    const rank = (type) => {
      const empty = !state.people.some((p) => p.type === type && (f === "all" || people[p.id].invested > 0));
      if (empty) return "";
      const list = state.people.filter((p) => p.type === type && (f === "all" || people[p.id].invested > 0)).sort((a, b) => people[b.id].value - people[a.id].value);
      const max = Math.max(1, ...list.map((p) => people[p.id].value));
      return `<div class="bars">${list
        .map((p) => `<div class="bar-row" ${tipAttr(`${p.name}: ${money(people[p.id].value)} value on ${money(people[p.id].invested)} invested`)}><div class="name">${esc(p.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${(people[p.id].value / max) * 100}%"></div></div><div class="val">${money(people[p.id].value)}</div></div>`)
        .join("")}</div>`;
    };
    const showWho = scopedDeals.some((d) => !d.partial);
    const rows = scopedDeals
      .slice()
      .sort((a, b) => deals[b.id].net - deals[a.id].net)
      .map((d) => {
        const dd = deals[d.id];
        const gain = dd.net + dd.dist - dd.invested;
        return `<tr><td><strong>${esc(d.name)}</strong>${channelPill(d)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}</span>` : ""}${termsText(d) ? `<div class="muted small">${esc(termsText(d))}</div>` : ""}</td>
          <td class="num">${money(dd.invested)}</td><td class="num"><span ${tipAttr(`Gross ${money(dd.value)} − carry ${money(dd.carry)} = ${money(dd.net)} net`)}>${money(dd.net)}</span> ${basisBadge(dd)}</td>
          <td class="num ${cls(gain)}">${signed(gain)}</td>${showWho ? `<td>${ownerBar(d.id)}</td>` : ""}</tr>`;
      })
      .join("");
    return `<div class="stack">
      ${estimated.length ? `<div class="banner" role="status"><strong>${estimated.length} of ${scopedDeals.length} deals</strong> use placeholder or estimated values, so gain/loss for them is not real yet. ${state.role === "admin" ? "Set real values under Deals." : ""}</div>` : ""}
      ${noTerms.length ? `<div class="banner" role="status">Fee and carry terms are not entered for <strong>${noTerms.length} of ${scopedDeals.length} deals</strong>, so their values are shown before carry.</div>` : ""}
      <div class="kpis">
        ${kpi("Total invested", money(total.invested), `${hs.length} holdings across ${scopedDeals.length} deals${total.fee ? ` · ${money(total.fee)} of it is upfront fees` : ""}`)}
        ${kpi("Current value (net)", money(total.value), `Gross ${money(total.gross)} · carry −${money(total.carry)}`)}
        ${kpi("Gain / loss", signed(total.gain), total.invested ? `${pct(total.gain / total.invested)} on cost (incl. distributions)` : "", cls(total.gain))}
        ${kpi("Distributions received", money(total.distributions), "Cash returned so far")}
      </div>
      <div class="grid-2">
        ${rank("member") ? `<div class="card"><h2>Club members - net value</h2>${rank("member")}</div>` : ""}
        ${rank("non-member") ? `<div class="card"><h2>${state.me && state.me.type === "non-member" ? "Your investments - net value" : "Not club members - net value"}</h2>${rank("non-member")}</div>` : ""}
      </div>
      <div class="card"><h2>${showWho ? "Every investment" : "Your investments"}</h2>${showWho ? legend() : ""}
        <div class="table-wrap"><table><thead><tr><th>Deal</th><th class="num">Invested</th><th class="num">Value (net of carry)</th><th class="num">Gain / loss</th>${showWho ? "<th>Who holds it</th>" : ""}</tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">Nothing to show here yet.</td></tr>'}</tbody></table></div>
      </div></div>`;
  }

  function peopleCard(p) {
    const t = state.d.people[p.id];
    const rows = t.holdings
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((h) => {
        const d = dealById(h.dealId);
        return `<tr><td>${esc(d?.name)}${channelPill(d)}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td><td class="num">${pct(h.share)}</td><td class="num"><span ${tipAttr(valueTip(h))}>${money(h.value)}</span> ${basisBadge(state.d.deals[h.dealId])}</td><td class="num ${cls(h.gain)}">${signed(h.gain)}</td>${state.role === "admin" ? `<td class="num"><button class="btn small" data-edit-holding="${esc(h.id)}">Edit</button></td>` : ""}</tr>`;
      })
      .join("");
    return `<div class="card"><div class="person-head"><h3><i class="sw" style="background:${color(p.id)}"></i>${esc(p.name)}${state.role === "admin" ? ` <button class="btn small ghost" data-edit-person="${esc(p.id)}">Edit</button>` : ""}</h3>
      <span class="muted">${money(t.invested)} invested · <strong>${money(t.value)}</strong> now · <span class="${cls(t.gain)}">${signed(t.gain)}</span></span></div>
      <div class="table-wrap"><table><thead><tr><th>Deal</th><th>Date</th><th class="num">Invested</th><th class="num">Share of deal</th><th class="num">Value (net)</th><th class="num">Gain / loss</th>${state.role === "admin" ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No holdings yet.</td></tr>'}</tbody></table></div></div>`;
  }
  function people() {
    const has = (p) => state.scope === "all" || state.d.people[p.id].holdings.length > 0;
    const members = state.people.filter((p) => p.type === "member" && has(p));
    const others = state.people.filter((p) => p.type !== "member" && has(p));
    return `<div class="stack"><div class="section-head"><h2>Club members</h2><span class="muted">${members.length} members</span></div>
      ${members.map(peopleCard).join("") || '<p class="muted">No members.</p>'}
      <div class="section-head"><h2>Not club members</h2><span class="muted">${others.length} ${others.length === 1 ? "person" : "people"}</span></div>
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
        return `<div class="card"><div class="person-head"><h3>${esc(d.name)} ${channelPill(d)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}${d.price ? ` ${usd2.format(d.price)}` : ""}</span>` : ""}</h3>
          <span>${state.role === "admin" ? `<button class="btn small" data-edit-deal="${esc(d.id)}">Edit deal</button>` : ""}</span></div>
          <p class="muted" style="margin:0 0 10px">Invested <strong>${money(dd.invested)}</strong> · Net value <strong>${money(dd.net)}</strong> ${basisBadge(dd)} · <span class="${cls(gain)}">${signed(gain)}</span></p>
          <p class="muted" style="margin:0 0 10px">${termsText(d) ? `Terms: ${esc(termsText(d))}. ` : "Fee and carry terms not entered. "}Gross value ${money(dd.value)} − carry ${money(dd.carry)}${dd.fee ? ` · upfront fees paid ${money(dd.fee)} (inside the amount invested)` : ""}</p>
          ${d.needsShares ? `<p class="banner">Ticker ${esc(d.ticker)} is set but the share count isn't, so this deal is not priced live yet.${d.priceError ? ` (Price lookup: ${esc(d.priceError)})` : ""}</p>` : ""}
          ${d.ticker && !d.needsShares && !d.price ? `<p class="muted">Live price unavailable: ${esc(d.priceError || "no data")}</p>` : ""}
          ${d.notes ? `<p class="muted">${esc(d.notes)}</p>` : ""}
          <div class="table-wrap"><table><thead><tr><th>Holder</th><th>Date</th><th class="num">Invested</th>${d.partial ? "" : '<th class="num">Share</th>'}<th class="num">Value (net)</th><th class="num">Distributions</th>${state.role === "admin" ? "<th></th>" : ""}</tr></thead><tbody>
          ${hs.map((h) => `<tr><td><i class="sw" style="background:${color(h.personId)}"></i>${esc(personById(h.personId)?.name)}${personById(h.personId)?.type === "non-member" ? ' <span class="pill">non-member</span>' : ""}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td>${d.partial ? "" : `<td class="num">${pct(h.share)}</td>`}<td class="num"><span ${tipAttr(valueTip(h))}>${money(h.value)}</span></td><td class="num">${money(h.distributions)}</td>${state.role === "admin" ? `<td class="num"><button class="btn small" data-edit-holding="${esc(h.id)}">Edit</button></td>` : ""}</tr>`).join("")}
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
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
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
  const today = () => new Date().toISOString().slice(0, 10);

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
            <div><label for="ad-fee">Upfront mgmt fee (% of amount invested)</label><input id="ad-fee" name="mgmtFeePct" type="number" min="0" max="100" step="0.01"></div>
            <div><label for="ad-carry">Carry (% of profit)</label><input id="ad-carry" name="carryPct" type="number" min="0" max="100" step="0.01"></div></div>
            <label for="ad-notes">Notes</label><input id="ad-notes" name="notes"><p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Add deal</button></div></form></div>
        <div class="card"><h2>Add a person</h2>
          <form id="addPerson"><label for="ap-name">Name</label><input id="ap-name" name="name" required>
            <label for="ap-type">Status</label><select id="ap-type" name="type"><option value="member">Club member</option><option value="non-member">Not a club member</option></select>
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
        <div><label for="e-sh">Shares held (whole deal)</label><input id="e-sh" name="sharesHeld" type="number" min="0" step="any" value="${d.sharesHeld ?? ""}"></div>
        <div><label for="e-fee">Upfront mgmt fee (% of amount invested)</label><input id="e-fee" name="mgmtFeePct" type="number" min="0" max="100" step="0.01" value="${d.mgmtFeePct ?? ""}"></div>
        <div><label for="e-carry">Carry (% of profit)</label><input id="e-carry" name="carryPct" type="number" min="0" max="100" step="0.01" value="${d.carryPct ?? ""}"></div>
        <div><label for="e-val">Current value ($, whole deal, before carry)</label><input id="e-val" name="manualValue" type="number" min="0" step="0.01" value="${d.manualValue ?? ""}"></div>
        <div><label for="e-src">Value source</label><select id="e-src" name="valueSource">${d.valueSource === "placeholder" ? '<option value="placeholder" selected>Placeholder (from spreadsheet)</option>' : ""}<option value="statement"${d.valueSource === "statement" ? " selected" : ""}>From a statement</option><option value="estimate"${d.valueSource === "estimate" ? " selected" : ""}>Estimate</option></select></div>
        <div><label for="e-asof">Value as-of date</label><input id="e-asof" name="valueAsOf" type="date" value="${d.valueAsOf || today()}"></div>
      </div>
      <label for="e-vn">Note for the value history (optional)</label><input id="e-vn" name="valueNote">
      <label for="e-notes">Deal notes</label><input id="e-notes" name="notes" value="${esc(d.notes || "")}">
      <p class="muted">If a ticker and share count are both set and a live price is available, the live price overrides the manual value.</p>
      ${d.valueHistory?.length ? `<details><summary>Value history (${d.valueHistory.length})</summary><ul>${d.valueHistory.slice().reverse().map((v) => `<li>${esc(new Date(v.at).toLocaleDateString())}: ${money(v.value)} (${esc(v.source)})${v.note ? ` - ${esc(v.note)}` : ""}</li>`).join("")}</ul></details>` : ""}`,
      (f) => api(`/api/deals/${id}`, { method: "PUT", body: f }),
      { label: "Delete deal", run: () => deleteDeal(id) },
    );
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
    let tab = (location.hash || "#overview").slice(1);
    if (!views[tab] || (tab === "admin" && state.role !== "admin") || (tab === "yearend" && !canYearEnd())) tab = "overview";
    const scopes = allowedScopes();
    if (!scopes[state.scope]) { state.scope = Object.keys(scopes)[0]; derive(); }
    document.querySelectorAll("#tabs a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $("#adminTab").hidden = state.role !== "admin";
    $("#addInvBtn").hidden = state.role !== "admin";
    document.querySelector('#tabs a[data-tab="yearend"]').hidden = !canYearEnd();
    $("#roleBadge").textContent = state.role === "admin" ? "Admin" : state.me ? `Signed in as ${state.me.name}` : "";
    const sel = $("#previewSel");
    sel.hidden = !isAdminSession();
    if (isAdminSession()) {
      sel.innerHTML = `<option value="">Admin view</option>${state.adminPeople.map((p) => `<option value="${esc(p.id)}"${state.previewOf === p.id ? " selected" : ""}>Preview as ${esc(p.name)}</option>`).join("")}`;
    }
    const bar = $("#previewBar");
    bar.hidden = !state.previewOf;
    if (state.previewOf) bar.innerHTML = `Previewing exactly what <strong>${esc(state.me?.name || "this person")}</strong> sees. Read-only. <button class="btn small" type="button" data-exit-preview>Back to admin view</button>`;
    const keys = Object.keys(scopes);
    $("#scopeBar").innerHTML = `<span class="muted">Show</span>${keys.map((k) => `<button type="button" role="radio" aria-checked="${state.scope === k}" data-scope="${k}">${esc(scopes[k])}</button>`).join("")}`;
    $("#scopeBar").hidden = tab === "yearend" || keys.length < 2;
    view.innerHTML = views[tab]();
  }

  async function refresh(afterPrices = false) {
    const data = await api(`/api/data${state.previewOf ? `?as=${encodeURIComponent(state.previewOf)}` : ""}`);
    Object.assign(state, { role: data.role, me: data.me, people: data.people, deals: data.deals, holdings: data.holdings, quotes: data.quotes || {} });
    if (data.role === "admin") Object.assign(state, { adminPeople: data.people, passcodes: data.passcodes || {} });
    if (!state.scope || !allowedScopes()[state.scope]) state.scope = Object.keys(allowedScopes())[0];
    derive();
    render();
    // Live prices refresh separately so a slow quote provider never blocks the page; reload once if any price moved.
    if (!afterPrices && state.deals.some((d) => d.ticker)) {
      api(`/api/prices${state.previewOf ? `?as=${encodeURIComponent(state.previewOf)}` : ""}`).then((q) => {
        if (Object.keys(q).some((k) => (q[k].price ?? null) !== (state.quotes[k]?.price ?? null))) refresh(true);
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
    $("#app").hidden = false;
    await refresh();
  }

  // ---------- events ----------
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#loginError").textContent = "";
    try {
      await api("/auth/login", { method: "POST", body: { name: $("#loginName").value, passcode: $("#passcode").value } });
      $("#passcode").value = "";
      state.previewOf = null;
      await showApp();
      if (state.role === "admin") window.PLC.wizard?.welcome();
    } catch (err) {
      $("#loginError").textContent = err.message;
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
    try { await fn(Object.fromEntries(new FormData(form))); await refresh(); } catch (e) { err.textContent = e.message; }
  }
  view.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.id === "addHolding") submitForm(f, (b) => api("/api/holdings", { method: "POST", body: b }));
    if (f.id === "addDeal") submitForm(f, (b) => api("/api/deals", { method: "POST", body: b }));
    if (f.id === "addPerson") submitForm(f, (b) => api("/api/people", { method: "POST", body: b }));
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

  // start
  api("/api/session").then((s) => (s.role ? showApp() : showLogin())).catch(showLogin);
})();
