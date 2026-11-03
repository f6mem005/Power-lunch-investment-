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

  const state = { scope: (() => { try { return localStorage.getItem("plc-scope") || "all"; } catch { return "all"; } })(), role: null, people: [], deals: [], holdings: [], prices: {}, d: null };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: opts.body ? { "content-type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith("/auth/")) showLogin();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- derived numbers ----------
  function derive() {
    const dealInvested = {};
    state.holdings.forEach((h) => (dealInvested[h.dealId] = (dealInvested[h.dealId] || 0) + h.invested));
    const deals = {};
    state.deals.forEach((deal) => {
      const invested = dealInvested[deal.id] || 0;
      const q = deal.ticker ? state.prices[deal.ticker] : null;
      let value, basis, note;
      if (deal.ticker && deal.sharesHeld && q && q.price) {
        value = deal.sharesHeld * q.price;
        basis = "live";
        note = `${deal.sharesHeld.toLocaleString()} sh × ${usd2.format(q.price)} (${deal.ticker})`;
      } else if (deal.manualValue != null) {
        value = deal.manualValue;
        basis = deal.valueSource;
        note = deal.valueSource === "placeholder" ? "Placeholder from original spreadsheet (90% of cost)" : `${deal.valueSource === "statement" ? "From statement" : "Estimate"}${deal.valueAsOf ? `, as of ${dateFmt(deal.valueAsOf)}` : ""}`;
      } else {
        value = invested;
        basis = "cost";
        note = "No value entered yet - shown at cost";
      }
      deals[deal.id] = { invested, value, basis, note, price: q && q.price };
    });
    const inScope = (dealId) => state.scope === "all" || dealById(dealId)?.channel === state.scope;
    const holdings = state.holdings.filter((h) => inScope(h.dealId)).map((h) => {
      const dd = deals[h.dealId];
      const share = dd && dd.invested ? h.invested / dd.invested : 0;
      const value = dd ? dd.value * share : 0;
      return { ...h, share, value, gain: value + h.distributions - h.invested };
    });
    const people = {};
    state.people.forEach((p, i) => (people[p.id] = { invested: 0, value: 0, distributions: 0, holdings: [], slot: Math.min(i + 1, 9) }));
    holdings.forEach((h) => {
      const t = people[h.personId];
      if (!t) return;
      t.invested += h.invested;
      t.value += h.value;
      t.distributions += h.distributions;
      t.holdings.push(h);
    });
    Object.values(people).forEach((t) => (t.gain = t.value + t.distributions - t.invested));
    const total = holdings.reduce((a, h) => ({ invested: a.invested + h.invested, value: a.value + h.value, distributions: a.distributions + h.distributions }), { invested: 0, value: 0, distributions: 0 });
    total.gain = total.value + total.distributions - total.invested;
    state.d = { deals, holdings, people, total };
  }

  const scopedDealList = () => state.deals.filter((d) => state.scope === "all" || d.channel === state.scope);
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
    const kpi = (label, value, sub, c = "") => `<div class="card kpi"><div class="label">${label}</div><div class="value ${c}">${value}</div><div class="sub">${sub}</div></div>`;
    const rank = (type) => {
      const list = state.people.filter((p) => p.type === type && (f === "all" || people[p.id].invested > 0)).sort((a, b) => people[b.id].value - people[a.id].value);
      const max = Math.max(1, ...list.map((p) => people[p.id].value));
      if (!list.length) return `<p class="muted">Nobody here yet.</p>`;
      return `<div class="bars">${list
        .map((p) => `<div class="bar-row" ${tipAttr(`${p.name}: ${money(people[p.id].value)} value on ${money(people[p.id].invested)} invested`)}><div class="name">${esc(p.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${(people[p.id].value / max) * 100}%"></div></div><div class="val">${money(people[p.id].value)}</div></div>`)
        .join("")}</div>`;
    };
    const rows = scopedDeals
      .slice()
      .sort((a, b) => deals[b.id].value - deals[a.id].value)
      .map((d) => {
        const dd = deals[d.id];
        const dist = state.d.holdings.filter((h) => h.dealId === d.id).reduce((s, h) => s + h.distributions, 0);
        const gain = dd.value + dist - dd.invested;
        return `<tr><td><strong>${esc(d.name)}</strong>${channelPill(d)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}</span>` : ""}</td>
          <td class="num">${money(dd.invested)}</td><td class="num">${money(dd.value)} ${basisBadge(dd)}</td>
          <td class="num ${cls(gain)}">${signed(gain)}</td><td>${ownerBar(d.id)}</td></tr>`;
      })
      .join("");
    return `<div class="stack">
      ${estimated.length ? `<div class="banner" role="status"><strong>${estimated.length} of ${scopedDeals.length} deals</strong> use placeholder or estimated values, so gain/loss for them is not real yet. Set real values under Deals${state.role === "admin" ? "" : " (admin only)"}.</div>` : ""}
      <div class="kpis">
        ${kpi("Total invested", money(total.invested), `${hs.length} holdings across ${scopedDeals.length} deals`)}
        ${kpi("Current value", money(total.value), "Allocated pro-rata by amount invested")}
        ${kpi("Gain / loss", signed(total.gain), total.invested ? `${pct(total.gain / total.invested)} on cost (incl. distributions)` : "", cls(total.gain))}
        ${kpi("Distributions received", money(total.distributions), "Cash returned so far")}
      </div>
      <div class="grid-2">
        <div class="card"><h2>Club members - current value</h2>${rank("member")}</div>
        <div class="card"><h2>Not club members - current value</h2>${rank("non-member")}</div>
      </div>
      <div class="card"><h2>Every investment</h2>${legend()}
        <div class="table-wrap"><table><thead><tr><th>Deal</th><th class="num">Invested</th><th class="num">Current value</th><th class="num">Gain / loss</th><th>Who holds it</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No deals yet.</td></tr>'}</tbody></table></div>
      </div></div>`;
  }

  function peopleCard(p) {
    const t = state.d.people[p.id];
    const rows = t.holdings
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((h) => {
        const d = dealById(h.dealId);
        return `<tr><td>${esc(d?.name)}${channelPill(d)}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td><td class="num">${pct(h.share)}</td><td class="num">${money(h.value)} ${basisBadge(state.d.deals[h.dealId])}</td><td class="num ${cls(h.gain)}">${signed(h.gain)}</td></tr>`;
      })
      .join("");
    return `<div class="card"><div class="person-head"><h3><i class="sw" style="background:${color(p.id)}"></i>${esc(p.name)}</h3>
      <span class="muted">${money(t.invested)} invested · <strong>${money(t.value)}</strong> now · <span class="${cls(t.gain)}">${signed(t.gain)}</span></span></div>
      <div class="table-wrap"><table><thead><tr><th>Deal</th><th>Date</th><th class="num">Invested</th><th class="num">Share of deal</th><th class="num">Value</th><th class="num">Gain / loss</th></tr></thead>
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
      .sort((a, b) => state.d.deals[b.id].value - state.d.deals[a.id].value)
      .map((d) => {
        const dd = state.d.deals[d.id];
        const hs = state.d.holdings.filter((h) => h.dealId === d.id).sort((a, b) => b.invested - a.invested);
        const q = d.ticker ? state.prices[d.ticker] : null;
        const needShares = d.ticker && !d.sharesHeld;
        const gain = dd.value + hs.reduce((s, h) => s + h.distributions, 0) - dd.invested;
        const raise = d.spvTotalRaise ? `Club owns ${pct(dd.invested / d.spvTotalRaise, 3)} of a ${money(d.spvTotalRaise)} SPV raise` : "";
        return `<div class="card"><div class="person-head"><h3>${esc(d.name)} ${channelPill(d)}${d.ticker ? ` <span class="pill">${esc(d.ticker)}${q && q.price ? ` ${usd2.format(q.price)}` : ""}</span>` : ""}</h3>
          <span>${state.role === "admin" ? `<button class="btn small" data-edit-deal="${esc(d.id)}">Update value / details</button>` : ""}</span></div>
          <p class="muted" style="margin:0 0 10px">Invested <strong>${money(dd.invested)}</strong> · Value <strong>${money(dd.value)}</strong> ${basisBadge(dd)} · <span class="${cls(gain)}">${signed(gain)}</span>${raise ? ` · ${raise}` : ""}</p>
          ${needShares ? `<p class="banner">Ticker ${esc(d.ticker)} is set but the share count isn't, so this deal is not priced live yet.${q && q.error ? ` (Price lookup: ${esc(q.error)})` : ""}</p>` : ""}
          ${d.ticker && q && !q.price ? `<p class="muted">Live price unavailable: ${esc(q.error || "no data")}</p>` : ""}
          ${d.notes ? `<p class="muted">${esc(d.notes)}</p>` : ""}
          <div class="table-wrap"><table><thead><tr><th>Holder</th><th>Date</th><th class="num">Invested</th><th class="num">Share</th><th class="num">Value</th><th class="num">Distributions</th></tr></thead><tbody>
          ${hs.map((h) => `<tr><td><i class="sw" style="background:${color(h.personId)}"></i>${esc(personById(h.personId)?.name)}${personById(h.personId)?.type === "non-member" ? ' <span class="pill">non-member</span>' : ""}</td><td>${dateFmt(h.date)}</td><td class="num">${money(h.invested)}</td><td class="num">${pct(h.share)}</td><td class="num">${money(h.value)}</td><td class="num">${money(h.distributions)}</td></tr>`).join("")}
          </tbody></table></div></div>`;
      })
      .join("") || '<p class="muted">No deals yet.</p>'}</div>`;
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
      <div class="card"><h2>Add an investment</h2>
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
            <div><label for="ad-raise">SPV total raise ($)</label><input id="ad-raise" name="spvTotalRaise" type="number" min="0" step="1"></div>
            <div><label for="ad-val">Current value ($, whole deal)</label><input id="ad-val" name="manualValue" type="number" min="0" step="0.01"></div></div>
            <label for="ad-notes">Notes</label><input id="ad-notes" name="notes"><p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Add deal</button></div></form></div>
        <div class="card"><h2>Add a person</h2>
          <form id="addPerson"><label for="ap-name">Name</label><input id="ap-name" name="name" required>
            <label for="ap-type">Status</label><select id="ap-type" name="type"><option value="member">Club member</option><option value="non-member">Not a club member</option></select>
            <p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Add person</button></div></form>
          <h3 style="margin-top:18px">People</h3>
          <ul style="padding-left:18px;margin:6px 0 0">${state.people.map((p) => `<li>${esc(p.name)} - ${p.type === "member" ? "member" : "non-member"} <button class="btn small ghost" data-toggle-person="${esc(p.id)}">Switch</button></li>`).join("")}</ul></div>
      </div>
      <div class="card"><h2>All holdings</h2><div class="table-wrap"><table><thead><tr><th>Deal</th><th>Person</th><th>Date</th><th class="num">Invested</th><th class="num">Distributions</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
  }

  // ---------- dialogs ----------
  const dlg = $("#dlg");
  function openDialog(html, onSubmit) {
    dlg.innerHTML = `<form method="dialog" id="dlgForm">${html}<p class="error" data-err></p><div class="row-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`;
    $("[data-close]", dlg).onclick = () => dlg.close();
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
  function editDeal(id) {
    const d = dealById(id);
    openDialog(
      `<h2>${esc(d.name)}</h2>
      <div class="form-grid">
        <div><label for="e-name">Name</label><input id="e-name" name="name" value="${esc(d.name)}" required></div>
        <div><label for="e-ch">Held through</label><select id="e-ch" name="channel"><option value="club"${d.channel === "club" ? " selected" : ""}>Power Lunch Club</option><option value="individual"${d.channel === "individual" ? " selected" : ""}>Individual</option></select></div>
        <div><label for="e-tk">Ticker (if public)</label><input id="e-tk" name="ticker" value="${esc(d.ticker || "")}"></div>
        <div><label for="e-sh">Shares held (whole deal)</label><input id="e-sh" name="sharesHeld" type="number" min="0" step="any" value="${d.sharesHeld ?? ""}"></div>
        <div><label for="e-val">Current value ($, whole deal)</label><input id="e-val" name="manualValue" type="number" min="0" step="0.01" value="${d.manualValue ?? ""}"></div>
        <div><label for="e-src">Value source</label><select id="e-src" name="valueSource"><option value="statement"${d.valueSource === "statement" ? " selected" : ""}>From a statement</option><option value="estimate"${d.valueSource !== "statement" ? " selected" : ""}>Estimate</option></select></div>
        <div><label for="e-asof">Value as-of date</label><input id="e-asof" name="valueAsOf" type="date" value="${d.valueAsOf || today()}"></div>
        <div><label for="e-raise">SPV total raise ($)</label><input id="e-raise" name="spvTotalRaise" type="number" min="0" step="1" value="${d.spvTotalRaise ?? ""}"></div>
      </div>
      <label for="e-vn">Note for the value history (optional)</label><input id="e-vn" name="valueNote">
      <label for="e-notes">Deal notes</label><input id="e-notes" name="notes" value="${esc(d.notes || "")}">
      <p class="muted">If a ticker and share count are both set and a live price is available, the live price overrides the manual value.</p>
      ${d.valueHistory?.length ? `<details><summary>Value history (${d.valueHistory.length})</summary><ul>${d.valueHistory.slice().reverse().map((v) => `<li>${esc(new Date(v.at).toLocaleDateString())}: ${money(v.value)} (${esc(v.source)})${v.note ? ` - ${esc(v.note)}` : ""}</li>`).join("")}</ul></details>` : ""}`,
      (f) => api(`/api/deals/${id}`, { method: "PUT", body: f }),
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
    );
  }

  // ---------- shell ----------
  const view = $("#view");
  const views = { overview, people, deals, admin };
  function render() {
    let tab = (location.hash || "#overview").slice(1);
    if (!views[tab] || (tab === "admin" && state.role !== "admin")) tab = "overview";
    document.querySelectorAll("#tabs a").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    $("#adminTab").hidden = state.role !== "admin";
    $("#roleBadge").textContent = state.role === "admin" ? "Admin" : "View only";
    const labels = { all: "All", club: "Power Lunch Club", individual: "Individual" };
    $("#scopeBar").innerHTML = `<span class="muted">Show</span>${Object.entries(labels).map(([k, v]) => `<button type="button" role="radio" aria-checked="${state.scope === k}" data-scope="${k}">${v}</button>`).join("")}`;
    view.innerHTML = views[tab]();
  }

  async function refresh() {
    const data = await api("/api/data");
    Object.assign(state, { role: data.role, people: data.people, deals: data.deals, holdings: data.holdings });
    derive();
    render();
    // Prices load separately so a slow quote provider never blocks the page.
    if (state.deals.some((d) => d.ticker)) {
      api("/api/prices").then((p) => { state.prices = p; derive(); render(); }).catch(() => {});
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
      await api("/auth/login", { method: "POST", body: { passcode: $("#passcode").value } });
      $("#passcode").value = "";
      await showApp();
    } catch (err) {
      $("#loginError").textContent = err.message;
    }
  });
  $("#logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST", body: {} }).catch(() => {}); state.role = null; showLogin(); };
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
    if (t.dataset.editDeal) editDeal(t.dataset.editDeal);
    if (t.dataset.editHolding) editHolding(t.dataset.editHolding);
    if (t.dataset.delHolding && confirm("Delete this holding? This can't be undone.")) {
      await api(`/api/holdings/${t.dataset.delHolding}`, { method: "DELETE" }).catch((x) => alert(x.message));
      await refresh();
    }
    if (t.dataset.togglePerson) {
      const p = personById(t.dataset.togglePerson);
      await api(`/api/people/${p.id}`, { method: "PUT", body: { name: p.name, type: p.type === "member" ? "non-member" : "member" } }).catch((x) => alert(x.message));
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

  // start
  api("/api/session").then((s) => (s.role ? showApp() : showLogin())).catch(showLogin);
})();
