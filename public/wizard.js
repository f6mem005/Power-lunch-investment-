// Guided question-and-answer flows for the admin: welcome prompt, "add an investment",
// and "fill in missing deal details". Talks to the app through window.PLC.
(() => {
  const P = window.PLC;
  const { esc, money } = P;
  const $ = (s, el = document) => el.querySelector(s);
  const dlg = $("#wiz");
  const val = (form, name) => (form.elements[name] ? String(form.elements[name].value) : "");
  const num = (s) => (s === "" || s == null ? null : Number(s));
  const radio = (name, value, label, sub, checked) =>
    `<label class="opt"><input type="radio" name="${name}" value="${esc(value)}"${checked ? " checked" : ""}><span><strong>${esc(label)}</strong>${sub ? `<small>${esc(sub)}</small>` : ""}</span></label>`;
  const personOptions = (selected) =>
    `<option value="">Choose a person…</option>${P.state.people.map((p) => `<option value="${esc(p.id)}"${selected === p.id ? " selected" : ""}>${esc(p.name)}${p.type === "non-member" ? " (non-member)" : ""}</option>`).join("")}<option value="__new"${selected === "__new" ? " selected" : ""}>＋ Someone new…</option>`;
  const pctErr = (v, label) => (v !== "" && !(Number(v) >= 0 && Number(v) <= 100) ? `${label} must be between 0 and 100.` : "");
  const tickerOk = (t) => /^[A-Za-z0-9.\-]{1,10}$/.test(t);

  // ---------------- generic step engine ----------------
  function run({ title, steps, ctx, done }) {
    const all = steps;
    const path = [];
    const vis = (s) => !s.show || s.show(ctx);
    const nextIdx = (from) => { for (let k = from + 1; k < all.length; k++) if (vis(all[k])) return k; return -1; };
    let cur = nextIdx(-1);
    const h = {
      repaint: () => paint(),
      replaceAfter: (list) => all.splice(cur + 1, all.length, ...list),
    };

    function paint(error = "") {
      const s = all[cur];
      const visible = all.map((x, k) => [x, k]).filter(([x]) => vis(x));
      const pos = visible.findIndex(([, k]) => k === cur);
      const q = typeof s.q === "function" ? s.q(ctx) : s.q;
      dlg.innerHTML = `<form id="wizForm" novalidate>
        <div class="wiz-top"><span class="muted">${esc(title)}</span><span class="muted">Step ${pos + 1} of ${visible.length}</span></div>
        <div class="wiz-bar"><i style="width:${((pos + 1) / visible.length) * 100}%"></i></div>
        <h2 class="wiz-q">${esc(q)}</h2>
        ${s.help ? `<p class="muted">${esc(typeof s.help === "function" ? s.help(ctx) : s.help)}</p>` : ""}
        <div class="wiz-body">${s.body(ctx)}</div>
        <p class="error" data-err role="alert">${esc(error)}</p>
        <div class="row-actions">
          ${path.length ? '<button class="btn" type="button" data-back>Back</button>' : ""}
          <button class="btn primary" type="submit">${esc(s.nextLabel || "Next")}</button>
          ${s.skip ? `<button class="btn ghost" type="button" data-skip>${esc(s.skip.label)}</button>` : ""}
          <button class="btn ghost" type="button" data-cancel>Cancel</button>
        </div></form>`;
      const form = $("#wizForm", dlg);
      form.addEventListener("submit", (e) => { e.preventDefault(); next(); });
      form.addEventListener("input", () => s.onChange && s.onChange(form, ctx));
      form.addEventListener("change", () => s.onChange && s.onChange(form, ctx));
      form.addEventListener("click", (e) => {
        const a = e.target.closest("[data-act]");
        if (a && s.actions && s.actions[a.dataset.act]) { e.preventDefault(); s.actions[a.dataset.act](form, ctx, h, a.dataset); }
      });
      $("[data-back]", form)?.addEventListener("click", () => { cur = path.pop(); paint(); });
      $("[data-cancel]", form).addEventListener("click", () => dlg.close());
      $("[data-skip]", form)?.addEventListener("click", () => {
        const to = s.skip.to(ctx, all, cur);
        path.push(cur);
        if (to === -1) return finish();
        cur = to; paint();
      });
      s.onChange && s.onChange(form, ctx);
      if (!dlg.open) dlg.showModal();
      form.querySelector("input:not([type=radio]):not([type=checkbox]), select")?.focus();
    }

    async function next() {
      const s = all[cur];
      const form = $("#wizForm", dlg);
      const err = s.read ? s.read(form, ctx, h) : "";
      if (err) return paint(err);
      if (s.commit) {
        const btn = $("[type=submit]", form);
        btn.disabled = true; btn.textContent = "Saving…";
        try { await s.commit(ctx, h); } catch (e) { btn.disabled = false; btn.textContent = s.nextLabel || "Next"; $("[data-err]", form).textContent = e.message; return; }
      }
      const n = nextIdx(cur);
      if (n === -1) return finish();
      path.push(cur); cur = n; paint();
    }

    function finish() {
      const d = done(ctx);
      dlg.innerHTML = `<div><h2 class="wiz-q">${esc(d.title)}</h2><p>${esc(d.message)}</p><div class="row-actions">${d.buttons.map((b, i) => `<button class="btn ${b.primary ? "primary" : ""}" type="button" data-done="${i}">${esc(b.label)}</button>`).join("")}</div></div>`;
      dlg.querySelectorAll("[data-done]").forEach((el) => el.addEventListener("click", () => { dlg.close(); d.buttons[el.dataset.done].run?.(); }));
    }
    paint();
  }

  // ---------------- flow 1: add an investment ----------------
  function addInvestment() {
    const S = P.state;
    const ctx = {
      kind: S.deals.length ? "" : "new", dealId: "", name: "", channel: "club", date: P.today(),
      investors: [{ personId: "", newName: "", newType: "member", amount: "" }],
      mgmtFeePct: "", carryPct: "", notes: "", isPublic: false, ticker: "", shares: "",
      value: "", valueSource: "statement", valueAsOf: P.today(), result: null,
    };
    const isNew = (c) => c.kind === "new";
    const dealName = (c) => (isNew(c) ? c.name : P.dealById(c.dealId)?.name || "the deal");
    const total = (c) => c.investors.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    const syncRows = (form, c) => {
      c.investors = c.investors.map((_, i) => ({
        personId: val(form, `person-${i}`), newName: val(form, `newname-${i}`), newType: val(form, `newtype-${i}`) || "member", amount: val(form, `amount-${i}`),
      }));
    };

    const steps = [
      {
        show: () => S.deals.length > 0,
        q: "Is this money going into a deal that's already on the dashboard, or a brand-new deal?",
        body: (c) => `${radio("kind", "existing", "A deal already on the dashboard", "Adding more money, or another investor", c.kind === "existing")}
          ${radio("kind", "new", "A brand-new deal", "I'll ask about its terms next", c.kind === "new")}
          <select name="dealId" aria-label="Which deal" ${c.kind === "existing" ? "" : "hidden"}><option value="">Choose the deal…</option>${S.deals.map((d) => `<option value="${esc(d.id)}"${c.dealId === d.id ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</select>`,
        onChange: (f) => { const sel = f.elements.dealId; sel.hidden = (f.querySelector("input[name=kind]:checked")?.value !== "existing"); },
        read: (f, c) => {
          c.kind = f.querySelector("input[name=kind]:checked")?.value || "";
          c.dealId = val(f, "dealId");
          if (!c.kind) return "Pick one to continue.";
          if (c.kind === "existing" && !c.dealId) return "Choose which deal.";
        },
      },
      {
        show: isNew, q: "What's the deal called?", help: "For example: Anthropic, Stripe 2027, a new SpaceX round.",
        body: (c) => `<input name="name" value="${esc(c.name)}" autocomplete="off">`,
        read: (f, c) => {
          c.name = val(f, "name").trim();
          if (!c.name) return "Give the deal a name.";
          if (S.deals.some((d) => d.name.toLowerCase() === c.name.toLowerCase())) return "A deal with that name already exists. Go back and choose it as an existing deal.";
        },
      },
      {
        show: isNew, q: "Is this a Power Lunch Club deal, or an individual investment?",
        body: (c) => `${radio("channel", "club", "Power Lunch Club", "Made through the club", c.channel === "club")}${radio("channel", "individual", "Individual", "Made by individuals, outside the club", c.channel === "individual")}`,
        read: (f, c) => { c.channel = f.querySelector("input[name=channel]:checked")?.value || "club"; },
      },
      {
        q: "What date did the money go in?",
        body: (c) => `<input name="date" type="date" value="${esc(c.date)}">`,
        read: (f, c) => { c.date = val(f, "date"); if (!c.date) return "Pick a date."; },
      },
      {
        q: (c) => (isNew(c) ? "Who invested, and how much?" : `Who put money into ${dealName(c)}, and how much?`),
        help: "The amount is the cash each person paid in. Add a row for every investor.",
        body: (c) => `<div class="inv-rows">${c.investors.map((r, i) => `<div class="inv-row">
            <select name="person-${i}" aria-label="Person ${i + 1}">${personOptions(r.personId)}</select>
            <input name="amount-${i}" type="number" min="0" step="0.01" placeholder="Amount ($)" aria-label="Amount ${i + 1}" value="${esc(r.amount)}">
            ${c.investors.length > 1 ? `<button type="button" class="btn small ghost" data-act="remove" data-i="${i}">Remove</button>` : "<span></span>"}
            <div class="inv-new" ${r.personId === "__new" ? "" : "hidden"}><input name="newname-${i}" placeholder="New person's name" value="${esc(r.newName)}"><select name="newtype-${i}" aria-label="Status"><option value="member"${r.newType === "member" ? " selected" : ""}>Club member</option><option value="non-member"${r.newType === "non-member" ? " selected" : ""}>Not a club member</option></select></div></div>`).join("")}</div>
          <button type="button" class="btn small" data-act="add">＋ Add another investor</button>
          <p class="muted" data-total></p>`,
        onChange: (f, c) => {
          c.investors.forEach((_, i) => { f.querySelector(`[name=newname-${i}]`).closest(".inv-new").hidden = val(f, `person-${i}`) !== "__new"; });
          const t = c.investors.reduce((s, _, i) => s + (Number(val(f, `amount-${i}`)) || 0), 0);
          f.querySelector("[data-total]").textContent = `Total: ${money(t)}`;
        },
        actions: {
          add: (f, c, h) => { syncRows(f, c); c.investors.push({ personId: "", newName: "", newType: "member", amount: "" }); h.repaint(); },
          remove: (f, c, h, d) => { syncRows(f, c); c.investors.splice(Number(d.i), 1); h.repaint(); },
        },
        read: (f, c) => {
          syncRows(f, c);
          const seen = new Set();
          for (const [i, r] of c.investors.entries()) {
            const n = i + 1;
            if (!r.personId) return `Choose who invested in row ${n}.`;
            const name = r.personId === "__new" ? r.newName.trim() : "";
            if (r.personId === "__new") {
              if (!name) return `Type the new person's name in row ${n}.`;
              if (P.state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) return `${name} already exists. Pick them from the list instead.`;
            }
            const key = r.personId === "__new" ? `new:${name.toLowerCase()}` : r.personId;
            if (seen.has(key)) return "Someone is listed twice. Combine their amounts into one row.";
            seen.add(key);
            if (!(Number(r.amount) > 0)) return `Enter an amount above $0 in row ${n}.`;
          }
        },
      },
      {
        show: isNew, q: "What are the terms?",
        help: "The upfront fee comes out of the amount invested. Carry is the share of profit the manager keeps. Leave a box blank if you don't know it yet - I'll flag the deal until you do.",
        body: (c) => `<div class="form-grid"><div><label for="w-fee">Upfront management fee (%)</label><input id="w-fee" name="fee" type="number" min="0" max="100" step="0.01" value="${esc(c.mgmtFeePct)}"></div>
          <div><label for="w-carry">Carry (% of profit)</label><input id="w-carry" name="carry" type="number" min="0" max="100" step="0.01" value="${esc(c.carryPct)}"></div></div><p class="muted" data-example></p>`,
        onChange: (f, c) => {
          const fee = num(val(f, "fee")), carry = num(val(f, "carry")), t = total(c), bits = [];
          if (fee != null && t) bits.push(`On ${money(t)} invested, a ${fee}% fee is ${money(t * fee / 100)}, so about ${money(t * (1 - fee / 100))} goes to work.`);
          if (carry != null) bits.push(`${carry}% carry takes ${money(carry * 10)} of every $1,000 of profit.`);
          f.querySelector("[data-example]").textContent = bits.join(" ");
        },
        read: (f, c) => { c.mgmtFeePct = val(f, "fee"); c.carryPct = val(f, "carry"); return pctErr(c.mgmtFeePct, "The fee") || pctErr(c.carryPct, "Carry"); },
      },
      {
        show: isNew, q: "Any notes about the deal?", help: "Optional.",
        body: (c) => `<label for="w-notes">Notes</label><input id="w-notes" name="notes" value="${esc(c.notes)}">`,
        read: (f, c) => { c.notes = val(f, "notes").trim(); },
      },
      {
        show: isNew, q: "Is it public yet?", help: "If it trades on an exchange I can pull a live price.",
        body: (c) => `${radio("pub", "no", "Not public", "Private shares or SPV units", !c.isPublic)}${radio("pub", "yes", "Public", "It has a ticker symbol", c.isPublic)}
          <div class="form-grid" data-pub ${c.isPublic ? "" : "hidden"}><div><label for="w-tk">Ticker</label><input id="w-tk" name="ticker" value="${esc(c.ticker)}" placeholder="e.g. SPCX"></div>
          <div><label for="w-sh">Shares held (whole deal, optional)</label><input id="w-sh" name="shares" type="number" min="0" step="any" value="${esc(c.shares)}"></div></div>`,
        onChange: (f) => { f.querySelector("[data-pub]").hidden = f.querySelector("input[name=pub]:checked")?.value !== "yes"; },
        read: (f, c) => {
          c.isPublic = f.querySelector("input[name=pub]:checked")?.value === "yes";
          c.ticker = val(f, "ticker").trim().toUpperCase(); c.shares = val(f, "shares");
          if (!c.isPublic) { c.ticker = ""; c.shares = ""; return; }
          if (!c.ticker || !tickerOk(c.ticker)) return "Enter the ticker, or choose Not public.";
          if (c.shares !== "" && !(Number(c.shares) >= 0)) return "Shares must be a number.";
        },
      },
      {
        show: isNew, q: "What's the whole position worth today?",
        help: "The value of the entire deal (all investors together), before carry. Leave it blank and the deal shows at cost until you have a real number.",
        body: (c) => `<div class="form-grid"><div><label for="w-val">Current value ($)</label><input id="w-val" name="value" type="number" min="0" step="0.01" value="${esc(c.value)}"></div>
          <div><label for="w-src">Where does it come from?</label><select id="w-src" name="source"><option value="statement"${c.valueSource === "statement" ? " selected" : ""}>A statement</option><option value="estimate"${c.valueSource === "estimate" ? " selected" : ""}>My estimate</option></select></div>
          <div><label for="w-asof">As of</label><input id="w-asof" name="asof" type="date" value="${esc(c.valueAsOf)}"></div></div>`,
        read: (f, c) => { c.value = val(f, "value"); c.valueSource = val(f, "source"); c.valueAsOf = val(f, "asof"); if (c.value !== "" && !(Number(c.value) >= 0)) return "The value must be a number."; },
      },
      {
        q: "Does this look right?", nextLabel: "Save investment",
        body: (c) => {
          const row = (k, v) => `<tr><th scope="row">${esc(k)}</th><td>${v}</td></tr>`;
          const who = c.investors.map((r) => `${esc(r.personId === "__new" ? r.newName : P.personById(r.personId)?.name)}: <strong>${money(Number(r.amount))}</strong>`).join("<br>");
          return `<table class="review">${row("Deal", esc(dealName(c)) + (isNew(c) ? ` (${c.channel === "club" ? "Power Lunch Club" : "Individual"})` : " (existing)"))}
            ${row("Date", esc(c.date))}${row("Who invested", who)}${row("Total", `<strong>${money(total(c))}</strong>`)}
            ${isNew(c) ? row("Terms", `${c.mgmtFeePct === "" ? "fee not set" : `${esc(c.mgmtFeePct)}% upfront fee`} · ${c.carryPct === "" ? "carry not set" : `${esc(c.carryPct)}% carry`}`)
              + row("Public", c.isPublic ? `${esc(c.ticker)}${c.shares ? ` · ${esc(c.shares)} shares` : " · share count not set"}` : "No")
              + row("Value today", c.value === "" ? "Not set - shown at cost" : `${money(Number(c.value))} (${c.valueSource === "statement" ? "statement" : "estimate"})`) : ""}</table>`;
        },
        commit: async (c) => {
          const body = {
            date: c.date,
            investors: c.investors.map((r) => (r.personId === "__new" ? { newPerson: { name: r.newName.trim(), type: r.newType }, invested: r.amount } : { personId: r.personId, invested: r.amount })),
          };
          if (isNew(c)) body.deal = { name: c.name, channel: c.channel, ticker: c.ticker, sharesHeld: c.shares, mgmtFeePct: c.mgmtFeePct, carryPct: c.carryPct, notes: c.notes, manualValue: c.value, valueSource: c.valueSource, valueAsOf: c.valueAsOf };
          else body.dealId = c.dealId;
          c.result = await P.api("/api/investments", { method: "POST", body });
          await P.refresh();
        },
      },
    ];
    run({
      title: "Add an investment", steps, ctx,
      done: (c) => ({
        title: "Saved.",
        message: `${c.result.holdings.length} investor${c.result.holdings.length === 1 ? "" : "s"} added to ${c.result.deal.name} (${money(c.result.holdings.reduce((s, h) => s + h.invested, 0))}).`,
        buttons: [{ label: "Add another", primary: true, run: addInvestment }, { label: "Close" }],
      }),
    });
  }

  // ---------------- flow 2: fill in missing deal details ----------------
  const needs = (d) => {
    const out = [];
    const dd = P.state.d && P.state.d.deals[d.id];
    if (d.mgmtFeePct == null && d.carryPct == null) out.push("fee and carry terms");
    if (dd && ["placeholder", "estimate", "cost"].includes(dd.basis)) out.push("a real value");
    if (d.ticker && !d.sharesHeld) out.push("share count");
    return out;
  };

  function completeDetails() {
    const ctx = { by: {}, saved: 0 };
    const skipGroup = (c, all, cur) => { const g = all[cur].group; for (let k = cur + 1; k < all.length; k++) if (all[k].group !== g) return k; return -1; };
    const stepsFor = (d) => {
      const f = (ctx.by[d.id] = ctx.by[d.id] || {
        fee: d.mgmtFeePct ?? "", carry: d.carryPct ?? "", isPublic: !!d.ticker, ticker: d.ticker || "", shares: d.sharesHeld ?? "",
        value: d.manualValue ?? "", source: d.valueSource, asOf: d.valueAsOf || P.today(),
      });
      const skip = { label: "Skip this deal", to: skipGroup };
      return [
        {
          group: d.id, skip, q: `${d.name}: what are the terms?`,
          help: "Upfront fee comes out of the amount invested. Carry is the share of profit the manager keeps. Leave a box blank if you don't know it.",
          body: () => `<div class="form-grid"><div><label for="c-fee">Upfront management fee (%)</label><input id="c-fee" name="fee" type="number" min="0" max="100" step="0.01" value="${esc(f.fee)}"></div>
            <div><label for="c-carry">Carry (% of profit)</label><input id="c-carry" name="carry" type="number" min="0" max="100" step="0.01" value="${esc(f.carry)}"></div></div>`,
          read: (form) => { f.fee = val(form, "fee"); f.carry = val(form, "carry"); return pctErr(f.fee, "The fee") || pctErr(f.carry, "Carry"); },
        },
        {
          group: d.id, skip, q: `Is ${d.name} public?`, help: "If it trades on an exchange I can pull a live price once you give me the ticker and the share count.",
          body: () => `${radio("pub", "no", "Not public", "", !f.isPublic)}${radio("pub", "yes", "Public", "It has a ticker symbol", f.isPublic)}
            <div class="form-grid" data-pub ${f.isPublic ? "" : "hidden"}><div><label for="c-tk">Ticker</label><input id="c-tk" name="ticker" value="${esc(f.ticker)}" placeholder="e.g. SPCX"></div>
            <div><label for="c-sh">Shares held (whole deal)</label><input id="c-sh" name="shares" type="number" min="0" step="any" value="${esc(f.shares)}"></div></div>`,
          onChange: (form) => { form.querySelector("[data-pub]").hidden = form.querySelector("input[name=pub]:checked")?.value !== "yes"; },
          read: (form) => {
            f.isPublic = form.querySelector("input[name=pub]:checked")?.value === "yes";
            f.ticker = val(form, "ticker").trim().toUpperCase(); f.shares = val(form, "shares");
            if (!f.isPublic) { f.ticker = ""; f.shares = ""; return; }
            if (!f.ticker || !tickerOk(f.ticker)) return "Enter the ticker, or choose Not public.";
            if (f.shares !== "" && !(Number(f.shares) >= 0)) return "Shares must be a number.";
          },
        },
        {
          group: d.id, skip, q: `What's ${d.name} worth today?`, nextLabel: "Save this deal",
          help: "The value of the whole deal (all investors together), before carry. A live price overrides this once the ticker and share count are set.",
          body: () => `<div class="form-grid"><div><label for="c-val">Current value ($)</label><input id="c-val" name="value" type="number" min="0" step="0.01" value="${esc(f.value)}"></div>
            <div><label for="c-src">Where does it come from?</label><select id="c-src" name="source">${d.valueSource === "placeholder" ? `<option value="placeholder"${f.source === "placeholder" ? " selected" : ""}>Placeholder (from the spreadsheet)</option>` : ""}<option value="statement"${f.source === "statement" ? " selected" : ""}>A statement</option><option value="estimate"${f.source === "estimate" ? " selected" : ""}>My estimate</option></select></div>
            <div><label for="c-asof">As of</label><input id="c-asof" name="asof" type="date" value="${esc(f.asOf)}"></div></div>`,
          read: (form) => {
            f.value = val(form, "value"); f.source = val(form, "source"); f.asOf = val(form, "asof");
            if (f.value !== "" && !(Number(f.value) >= 0)) return "The value must be a number.";
            if (f.value !== "" && Number(f.value) !== d.manualValue && f.source === "placeholder") return "You changed the value - choose whether it comes from a statement or is your estimate.";
          },
          commit: async () => {
            const cur = P.dealById(d.id);
            const changed = f.value === "" ? cur.manualValue != null : Number(f.value) !== cur.manualValue;
            await P.api(`/api/deals/${d.id}`, {
              method: "PUT",
              body: {
                name: cur.name, channel: cur.channel, notes: cur.notes, ticker: f.ticker, sharesHeld: f.shares,
                mgmtFeePct: f.fee, carryPct: f.carry, manualValue: f.value, valueSource: f.source,
                valueAsOf: changed ? f.asOf : cur.valueAsOf || "", valueNote: "Guided setup",
              },
            });
            ctx.saved++;
            await P.refresh();
          },
        },
      ];
    };
    const pick = {
      q: "Which deals do you want to go through?",
      help: "I've ticked the ones that are missing something.",
      body: () => P.state.deals.map((d) => { const n = needs(d); return `<label class="opt"><input type="checkbox" name="pick" value="${esc(d.id)}"${n.length ? " checked" : ""}><span><strong>${esc(d.name)}</strong><small>${n.length ? `Needs ${esc(n.join(", "))}` : "Looks complete"}</small></span></label>`; }).join(""),
      read: (form, c, h) => {
        const ids = [...form.querySelectorAll("input[name=pick]:checked")].map((x) => x.value);
        if (!ids.length) return "Pick at least one deal.";
        h.replaceAfter(ids.flatMap((id) => stepsFor(P.dealById(id))));
      },
    };
    run({
      title: "Fill in deal details", steps: [pick], ctx,
      done: (c) => ({
        title: "All set.", message: c.saved ? `${c.saved} deal${c.saved === 1 ? "" : "s"} updated.` : "Nothing was changed.",
        buttons: [{ label: "Close", primary: true }, { label: "Add an investment", run: addInvestment }],
      }),
    });
  }

  // ---------------- welcome prompt after sign-in ----------------
  function welcome() {
    const n = P.state.deals.filter((d) => needs(d).length).length;
    dlg.innerHTML = `<div><h2 class="wiz-q">Welcome back. What would you like to do?</h2>
      <div class="wiz-choices">
        <button class="btn primary big" type="button" data-w="add">Add a new investment</button>
        ${n ? `<button class="btn big" type="button" data-w="complete">Fill in missing deal details <span class="muted">(${n} deal${n === 1 ? "" : "s"} need info)</span></button>` : ""}
        <button class="btn ghost" type="button" data-w="skip">Just show me the dashboard</button>
      </div></div>`;
    dlg.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", () => {
      dlg.close();
      if (b.dataset.w === "add") addInvestment();
      if (b.dataset.w === "complete") completeDetails();
    }));
    dlg.showModal();
  }

  P.wizard = { welcome, addInvestment, completeDetails };
})();
