/* Matchday — client. Vanilla JS, no build step. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const LS = {
    who:   'matchday.who',
    theme: 'matchday.theme',
    open:  'matchday.open',
    lang:  'matchday.lang',
  };

  /** localStorage throws in some privacy modes, so every access is guarded. */
  const store = {
    get(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  const t = (key, vars) => window.I18N.t(key, vars);

  let state = null;
  let view = 'upcoming';
  let who = store.get(LS.who);
  let lang = window.I18N.set(window.I18N.pickInitial(store.get(LS.lang)));
  const open = new Set((store.get(LS.open) || '').split(',').filter(Boolean));

  // ------------------------------------------------------------- helpers ----

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

  const dur = (from, to) => {
    const d = mins(to) - mins(from);
    const h = Math.floor(d / 60);
    const m = d % 60;
    return h && m ? `${h}h${String(m).padStart(2, '0')}` : h ? `${h}h` : `${m}min`;
  };

  // Weekday/month names come from Intl so they follow the chosen language.
  const fmtCache = new Map();
  function dtf(opts) {
    const key = lang + JSON.stringify(opts);
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(lang, opts));
    return fmtCache.get(key);
  }
  const dowShort = (d) => dtf({ weekday: 'short' }).format(d).replace('.', '');
  const monShort = (d) => dtf({ month: 'short' }).format(d).replace('.', '');

  /** Parse YYYY-MM-DD as local noon so it never shifts a day across timezones. */
  const parseDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  };

  const todayIso = () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  };

  const dayDelta = (iso) => Math.round((parseDate(iso) - parseDate(todayIso())) / 86400000);

  const relDay = (iso) => {
    const d = dayDelta(iso);
    if (d === 0) return t('day.today');
    if (d === 1) return t('day.tomorrow');
    if (d === -1) return t('day.yesterday');
    if (d > 1 && d < 7) return t('day.inDays', { n: d });
    if (d < -1 && d > -7) return t('day.daysAgo', { n: -d });
    return '';
  };

  const longDate = (iso) => dtf({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    .format(parseDate(iso));

  const isUpcoming = (ev) => dayDelta(ev.date) >= 0;

  function toast(message, bad = false) {
    const el = document.createElement('div');
    el.className = `toast${bad ? ' toast--bad' : ''}`;
    el.textContent = message;
    $('#toasts').append(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, bad ? 3600 : 1900);
  }

  // ----------------------------------------------------------------- api ----

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json', 'x-matchday': '1' } : { 'x-matchday': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && path !== '/api/session') { showGate(); throw new Error(t('err.session')); }
    if (!res.ok) throw new Error((data && data.error) || t('err.generic', { status: res.status }));
    return data;
  }

  /** Mutating calls all return a fresh snapshot, so one helper re-renders. */
  async function mutate(method, path, body, okMessage) {
    try {
      const next = await api(method, path, body || {});
      if (next && Array.isArray(next.events)) { state = next; render(); }
      if (okMessage) toast(okMessage);
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  }

  async function refresh(quiet = true) {
    try {
      const next = await api('GET', '/api/state');
      const changed = !state || next.rev !== state.rev;
      state = next;
      if (changed) render();
      markSynced();
      return true;
    } catch (err) {
      if (!quiet) toast(err.message, true);
      return false;
    }
  }

  let lastSync = null;

  function paintSync() {
    if (!lastSync) return;
    $('#syncLabel').textContent = t('footer.synced', {
      time: `${String(lastSync.getHours()).padStart(2, '0')}:${String(lastSync.getMinutes()).padStart(2, '0')}`,
    });
  }

  function markSynced() {
    lastSync = new Date();
    paintSync();
  }

  // ---------------------------------------------------------------- gate ----

  function showGate() {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#gatePassword').value = '';
    $('#gateName').value = who;
    // Returning visitors already have a name, so send them to the password.
    setTimeout(() => (who ? $('#gatePassword') : $('#gateName')).focus(), 40);
  }

  function showApp() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
  }

  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#gateSubmit');
    const err = $('#gateError');
    const name = $('#gateName').value.trim();
    if (!name) { err.textContent = t('gate.needName'); err.hidden = false; $('#gateName').focus(); return; }
    btn.disabled = true;
    btn.textContent = t('gate.checking');
    err.hidden = true;
    try {
      // The server returns the roster's spelling, so casing stays consistent.
      const res = await api('POST', '/api/session', { name, password: $('#gatePassword').value });
      setWho((res && res.name) || name);
      await refresh(false);
      showApp();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      if (/password/i.test(e2.message)) $('#gatePassword').select();
      else $('#gateName').focus();
    } finally {
      btn.disabled = false;
      btn.textContent = t('gate.submit');
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('DELETE', '/api/session').catch(() => {});
    state = null;
    showGate();
  });

  // --------------------------------------------------------------- theme ----

  function applyTheme(mode) {
    document.documentElement.dataset.theme = mode;
    store.set(LS.theme, mode);
    $('#themeBtn').textContent = mode === 'dark' ? '☾' : mode === 'light' ? '☀' : '◐';
  }
  applyTheme(store.get(LS.theme, 'auto'));

  $('#themeBtn').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    applyTheme(order[(order.indexOf(document.documentElement.dataset.theme) + 1) % order.length]);
  });

  // ----------------------------------------------------------------- who ----

  function setWho(name) {
    who = String(name || '').trim().slice(0, 60);
    store.set(LS.who, who);
    const label = $('#whoName');
    if (label) label.textContent = who || '—';
  }
  setWho(who);

  const isMe = (name) => Boolean(who) && String(name).toLowerCase() === who.toLowerCase();

  $('#whoBtn').addEventListener('click', () => {
    $('#nameInput').value = who;
    $('#nameError').hidden = true;
    $('#nameModal').showModal();
    setTimeout(() => $('#nameInput').select(), 30);
  });

  $('#nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = $('#nameInput').value.trim();
    if (!next) {
      $('#nameError').textContent = t('name.required');
      $('#nameError').hidden = false;
      return;
    }
    try {
      const res = await api('POST', '/api/members', { name: next });
      setWho((res && res.name) || next);
      if (res && res.state) { state = res.state; }
      render();
      $('#nameModal').close();
      toast(t('name.now', { name: who }));
    } catch (err) {
      $('#nameError').textContent = err.message;
      $('#nameError').hidden = false;
    }
  });

  // ---------------------------------------------------------------- tabs ----

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      view = tab.dataset.view;
      $$('.tab').forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', String(active));
      });
      $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
      render();
    });
  });

  // -------------------------------------------------------------- render ----

  /** Paint every string that lives in index.html rather than in a template. */
  function applyStaticText() {
    const set = (sel, value, attr) => {
      const el = $(sel);
      if (el) { if (attr) el.setAttribute(attr, value); else el.textContent = value; }
    };
    set('#gateSub', t('gate.sub'));
    set('#gateNameLabel', t('gate.name'));
    set('#gateName', t('gate.namePlaceholder'), 'placeholder');
    set('#gatePasswordLabel', t('gate.password'));
    set('#gateSubmit', t('gate.submit'));
    set('#gateHint', t('gate.hint'));
    set('#whoLabel', t('top.signedInAs'));
    set('#whoBtn', t('top.changeName'), 'title');
    set('#themeBtn', t('top.theme'), 'title');
    set('#themeBtn', t('top.theme'), 'aria-label');
    set('#logoutBtn', t('top.signOut'));
    set('#footerShared', t('footer.shared'));
    paintSync();
    $$('.tab').forEach((tab) => { tab.textContent = t(`tab.${tab.dataset.view}`); });
    set('.tabs', t('tabs.aria'), 'aria-label');
    // dialogs
    set('#nameTitle', t('name.title'));
    set('#nameText', t('name.text'));
    set('#nameLabel', t('gate.name'));
    set('#shareTitle', t('share.title'));
    set('#shareText2', t('share.text'));
    set('#shareCopy', t('share.copy'));
    set('#shareClose', t('share.close'));
    set('#evDateLabel', t('ev.date'));
    set('#evKickoffLabel', t('ev.kickoff'));
    set('#evOpponentLabel', t('ev.opponent'));
    set('#evOpponent', t('ev.opponentPlaceholder'), 'placeholder');
    set('#evVenueLabel', t('ev.venue'));
    set('#evVenueOpt', t('common.optional'));
    set('#evVenue', t('ev.venuePlaceholder'), 'placeholder');
    set('#evDutyLegend', t('ev.dutyWindow'));
    set('#evDutyHint', t('ev.dutyHint'));
    set('#evDutyFromLabel', t('ev.from'));
    set('#evDutyToLabel', t('ev.to'));
    set('#evTeardownLabel', t('ev.teardownTarget'));
    set('#evNotesLabel', t('ev.notes'));
    set('#evNotesOpt', t('common.optional'));
    set('#evNotes', t('ev.notesPlaceholder'), 'placeholder');
    set('#evPresetsLabel', t('ev.presets'));
    $$('[data-close]').forEach((b) => { b.textContent = t('common.cancel'); });
    set('#shareClose', t('share.close'));
  }

  function render() {
    if (!state) return;
    applyStaticText();
    $('#teamName').textContent = state.teamName || 'Matchday';
    $('#seasonLabel').textContent = state.season || '';
    document.title = state.teamName ? `${state.teamName} — Matchday` : 'Matchday';

    const upcoming = state.events.filter(isUpcoming);
    const past = state.events.filter((e) => !isUpcoming(e)).reverse();

    if (view === 'upcoming') renderList($('#view-upcoming'), upcoming, true);
    else if (view === 'past') renderList($('#view-past'), past, false);
    else renderSettings();
  }

  function renderList(root, events, upcomingView) {
    const head = `
      <div class="viewhead">
        <span class="viewhead__title">
          ${upcomingView ? t('list.homeGames') : t('list.pastGames')}
          <span class="viewhead__count">${events.length || t('list.none')}</span>
        </span>
        ${upcomingView ? `<button class="btn btn--primary btn--sm" data-act="new">${t('list.add')}</button>` : ''}
      </div>`;

    if (!events.length) {
      root.innerHTML = head + `
        <div class="empty empty--big">
          <span class="empty__title">${upcomingView ? t('list.emptyUpcoming') : t('list.emptyPast')}</span>
          ${upcomingView ? t('list.emptyUpcomingHint') : t('list.emptyPastHint')}
        </div>`;
      return;
    }

    const nextId = upcomingView && events[0] ? events[0].id : null;
    root.innerHTML = head + events.map((ev) => card(ev, ev.id === nextId, upcomingView)).join('');
  }

  function card(ev, isNext, upcomingView) {
    const d = parseDate(ev.date);
    const claimed = ev.items.filter((i) => i.claimedBy).length;
    const total = ev.items.length;
    const need = Math.max(0, (ev.teardownTarget || 0) - ev.teardown.length);
    const rel = relDay(ev.date);
    const expanded = open.has(ev.id) || isNext;

    const stats = [
      total
        ? `<span class="pill ${claimed === total ? 'pill--ok' : claimed ? '' : 'pill--warn'}">${t('card.covered', { done: claimed, total })}</span>`
        : `<span class="pill pill--warn">${t('card.listEmpty')}</span>`,
      `<span class="pill ${ev.slots.length ? '' : 'pill--warn'}">${t('card.available', { n: ev.slots.length })}</span>`,
      ev.teardownTarget
        ? `<span class="pill ${need ? 'pill--warn' : 'pill--ok'}">${need
            ? t('card.crewMore', { n: ev.teardown.length, target: ev.teardownTarget, need })
            : t('card.crew', { n: ev.teardown.length, target: ev.teardownTarget })}</span>`
        : `<span class="pill">${t('card.crewHelping', { n: ev.teardown.length })}</span>`,
    ].join('');

    return `
    <article class="card ${isNext ? 'card--next' : ''} ${upcomingView ? '' : 'card--past'} ${expanded ? 'is-open' : ''}" data-ev="${ev.id}">
      <button class="card__head" type="button" data-act="toggle" aria-expanded="${expanded}">
        <div class="datechip">
          <div class="datechip__dow">${esc(dowShort(d))}</div>
          <div class="datechip__day">${d.getDate()}</div>
          <div class="datechip__mon">${esc(monShort(d))}</div>
        </div>
        <div class="card__mid">
          <h3 class="card__title">
            ${esc(ev.opponent || 'TBD')}
            ${isNext ? `<span class="pill pill--next">${t('card.nextUp')}</span>` : ''}
            ${rel ? `<span class="pill">${esc(rel)}</span>` : ''}
            ${ev.locked ? `<span class="pill pill--lock">${t('card.locked')}</span>` : ''}
          </h3>
          <p class="card__sub">
            ${t('card.kickoff', { time: ev.kickoff })} · ${t('card.duty', { from: ev.dutyFrom, to: ev.dutyTo })}${ev.venue ? ` · ${esc(ev.venue)}` : ''}
          </p>
          <div class="card__stats">${stats}</div>
        </div>
        <span class="card__chev">▶</span>
      </button>
      ${expanded ? `<div class="card__body">${body(ev)}</div>` : ''}
    </article>`;
  }

  function body(ev) {
    const ro = ev.locked;
    return `
      ${ev.notes ? `<div class="block"><div class="block__title">${t('fx.notes')}</div><p class="block__note">${esc(ev.notes)}</p></div>` : ''}
      ${cateringBlock(ev, ro)}
      ${availabilityBlock(ev, ro)}
      ${teardownBlock(ev, ro)}
      <div class="block">
        <div class="block__head">
          <span class="block__title">${t('fx.title')}</span>
          <span class="block__meta">${esc(longDate(ev.date))}</span>
        </div>
        <div class="addbar">
          <button class="btn btn--sm" type="button" data-act="share">${t('fx.share')}</button>
          <button class="btn btn--sm" type="button" data-act="edit">${t('fx.edit')}</button>
          <button class="btn btn--sm" type="button" data-act="lock">${ro ? t('fx.unlock') : t('fx.lock')}</button>
          <button class="btn btn--sm btn--ghost" type="button" data-act="del">${t('fx.delete')}</button>
        </div>
        ${ro ? `<p class="block__note" style="margin-top:8px">${t('fx.lockedNote')}</p>` : ''}
      </div>`;
  }

  // ------------------------------------------------------------- catering ---

  function cateringBlock(ev, ro) {
    const claimed = ev.items.filter((i) => i.claimedBy).length;
    const used = new Set(ev.items.map((i) => i.name.toLowerCase()));
    const presets = (state.cateringPresets || [])
      .map((value) => ({ value, label: window.I18N.presetLabel(value) }))
      .filter(({ value, label }) => !used.has(value.toLowerCase()) && !used.has(label.toLowerCase()));

    const rows = ev.items.length
      ? `<div class="rows">${ev.items.map((item) => {
          const mine = isMe(item.claimedBy);
          return `
          <div class="row ${item.claimedBy ? 'is-claimed' : ''} ${mine ? 'is-mine' : ''}" data-item="${item.id}">
            <div class="row__main">
              <div class="row__name">${esc(item.name)}${item.qty ? `<span class="row__qty">${esc(item.qty)}</span>` : ''}</div>
              ${item.claimedBy
                ? `<p class="row__by">${t('cat.broughtBy', { name: `<b>${esc(item.claimedBy)}</b>` })}${mine ? t('cat.you') : ''}</p>`
                : `<p class="row__by row__by--open">${t('cat.nobody')}</p>`}
              ${item.note ? `<p class="row__note">${esc(item.note)}</p>` : ''}
            </div>
            <div class="row__acts">
              ${ro ? '' : item.claimedBy
                ? (mine
                    ? `<button class="btn btn--sm btn--ghost" type="button" data-act="release">${t('cat.drop')}</button>`
                    : `<button class="btn btn--sm btn--ghost" type="button" data-act="take">${t('cat.takeOver')}</button>`)
                : `<button class="btn btn--sm btn--primary" type="button" data-act="claim">${t('cat.claim')}</button>`}
              ${ro ? '' : `
                <button class="btn btn--sm btn--ghost btn--icon" type="button" data-act="item-edit" title="${t('cat.editTitle')}" aria-label="${t('cat.editAria')}">✎</button>
                <button class="btn btn--sm btn--ghost btn--icon" type="button" data-act="item-del" title="${t('cat.removeTitle')}" aria-label="${t('cat.removeTitle')}">✕</button>`}
            </div>
          </div>`;
        }).join('')}</div>`
      : `<div class="empty">${t('cat.empty')}</div>`;

    return `
    <div class="block">
      <div class="block__head">
        <span class="block__title">${t('cat.title')}</span>
        <span class="block__meta">${ev.items.length ? t('cat.meta', { done: claimed, total: ev.items.length }) : t('cat.metaEmpty')}</span>
      </div>
      ${rows}
      ${ro ? '' : `
        <div class="addbar">
          <input class="input" data-in="itemName" placeholder="${t('cat.addPlaceholder')}" maxlength="60" enterkeyhint="done">
          <input class="input input--qty" data-in="itemQty" placeholder="${t('cat.qtyPlaceholder')}" maxlength="24" enterkeyhint="done">
          <button class="btn btn--sm" type="button" data-act="item-add">${t('cat.add')}</button>
          <button class="btn btn--sm btn--primary" type="button" data-act="item-add-mine">${t('cat.addMine')}</button>
        </div>
        ${presets.length ? `<div class="presets">${presets.map(({ label }) => `<button class="preset" type="button" data-act="preset" data-name="${esc(label)}">+ ${esc(label)}</button>`).join('')}</div>` : ''}`}
    </div>`;
  }

  // --------------------------------------------------------- availability ---

  function availabilityBlock(ev, ro) {
    const rows = ev.slots.length
      ? `<div class="rows">${ev.slots.map((slot) => {
          const mine = isMe(slot.name);
          return `
          <div class="row ${mine ? 'is-claimed is-mine' : ''}" data-slot="${slot.id}">
            <div class="row__main">
              <div class="row__name">
                <span class="timerow__when">${slot.from}–${slot.to}</span>
                <span class="timerow__dur">${dur(slot.from, slot.to)}</span>
              </div>
              <p class="row__by"><b>${esc(slot.name)}</b>${mine ? t('cat.you') : ''}</p>
              ${slot.note ? `<p class="row__note">${esc(slot.note)}</p>` : ''}
            </div>
            <div class="row__acts">
              ${ro ? '' : `
                <button class="btn btn--sm btn--ghost btn--icon" type="button" data-act="slot-edit" title="${t('av.editTitle')}" aria-label="${t('av.editTitle')}">✎</button>
                <button class="btn btn--sm btn--ghost btn--icon" type="button" data-act="slot-del" title="${t('av.removeTitle')}" aria-label="${t('av.removeTitle')}">✕</button>`}
            </div>
          </div>`;
        }).join('')}</div>`
      : `<div class="empty">${t('av.empty')}</div>`;

    const suggestFrom = ev.dutyFrom;
    const suggestTo = ev.slots.length ? ev.dutyTo : ev.kickoff;

    return `
    <div class="block">
      <div class="block__head">
        <span class="block__title">${t('av.title')}</span>
        <span class="block__meta">${t('av.meta', { from: ev.dutyFrom, to: ev.dutyTo })}</span>
      </div>
      ${rows}
      ${coverage(ev)}
      ${ro ? '' : `
        <div class="addbar">
          <input class="input input--time" type="time" data-in="slotFrom" value="${suggestFrom}" step="300" aria-label="${t('av.from')}">
          <input class="input input--time" type="time" data-in="slotTo" value="${suggestTo}" step="300" aria-label="${t('av.to')}">
          <input class="input" data-in="slotNote" placeholder="${t('av.notePlaceholder')}" maxlength="160">
          <button class="btn btn--sm btn--primary" type="button" data-act="slot-add">${t('av.submit')}</button>
        </div>`}
    </div>`;
  }

  /**
   * Coverage bar: slice the duty window into segments at every slot boundary and
   * shade each by how many people overlap it. Zero-coverage segments are gaps.
   */
  function coverage(ev) {
    const start = mins(ev.dutyFrom);
    const end = mins(ev.dutyTo);
    if (end <= start) return '';

    const spans = ev.slots
      .map((s) => ({ a: Math.max(start, mins(s.from)), b: Math.min(end, mins(s.to)) }))
      .filter((s) => s.b > s.a);

    const edges = [...new Set([start, end, ...spans.flatMap((s) => [s.a, s.b])])]
      .filter((v) => v >= start && v <= end)
      .sort((a, b) => a - b);

    const max = Math.max(1, ...spans.map((s) => spans.filter((o) => o.a < s.b && o.b > s.a).length));
    const gaps = [];
    let segs = '';

    for (let i = 0; i < edges.length - 1; i += 1) {
      const a = edges[i];
      const b = edges[i + 1];
      const n = spans.filter((s) => s.a <= a && s.b >= b).length;
      const pct = ((b - a) / (end - start)) * 100;
      const alpha = n ? 0.22 + 0.78 * (n / max) : 0;
      const fmt = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      if (!n) gaps.push(`${fmt(a)}–${fmt(b)}`);
      segs += `<div class="cover__seg" data-n="${n}" style="width:${pct}%${n ? `;background:color-mix(in srgb, var(--accent) ${Math.round(alpha * 100)}%, transparent)` : ''}" title="${t('av.segTitle', { from: fmt(a), to: fmt(b), n, people: n === 1 ? t('av.person') : t('av.people') })}"></div>`;
    }

    const legend = gaps.length
      ? `<p class="cover__legend cover__legend--gap">${t('av.gap', { ranges: gaps.join(', ') })}</p>`
      : spans.length
        ? `<p class="cover__legend cover__legend--ok">${t('av.covered')}</p>`
        : '';

    return `
      <div class="cover">
        <div class="cover__bar" role="img" aria-label="${t('av.coverAria')}">${segs}</div>
        <div class="cover__axis"><span>${ev.dutyFrom}</span><span>${ev.dutyTo}</span></div>
        ${legend}
      </div>`;
  }

  // ------------------------------------------------------------- teardown ---

  function teardownBlock(ev, ro) {
    const target = ev.teardownTarget || 0;
    const n = ev.teardown.length;
    const need = Math.max(0, target - n);
    const pct = target ? Math.min(100, (n / target) * 100) : n ? 100 : 0;
    const joined = ev.teardown.some((p) => isMe(p.name));

    return `
    <div class="block">
      <div class="block__head">
        <span class="block__title">${t('td.title')}</span>
        <span class="block__meta">${target ? t('td.meta', { n, target }) : t('td.metaNoTarget', { n })}</span>
      </div>
      ${target ? `<div class="progress"><div class="progress__fill ${need ? 'is-short' : ''}" style="width:${pct}%"></div></div>` : ''}
      ${n
        ? `<div class="crew">${ev.teardown.map((p) => `
            <span class="crewchip" data-person="${p.id}">
              ${esc(p.name)}${isMe(p.name) ? t('cat.you') : ''}
              ${ro ? '' : `<button class="crewchip__x" type="button" data-act="crew-del" title="${t('td.removeTitle', { name: esc(p.name) })}" aria-label="${t('td.removeTitle', { name: esc(p.name) })}">✕</button>`}
            </span>`).join('')}</div>`
        : `<div class="empty">${t('td.empty')}</div>`}
      ${need ? `<p class="block__note" style="margin-top:9px">${(need === 1 ? t('td.needOne', { n: `<b>${need}</b>` }) : t('td.needMany', { n: `<b>${need}</b>` }))}</p>` : ''}
      ${ro ? '' : `
        <div class="addbar">
          ${joined
            ? `<button class="btn btn--sm btn--ghost" type="button" data-act="crew-leave">${t('td.leave')}</button>`
            : `<button class="btn btn--sm btn--primary" type="button" data-act="crew-join">${t('td.join')}</button>`}
        </div>`}
    </div>`;
  }

  // ------------------------------------------------------------ settings ----

  function renderSettings() {
    const totals = state.events.reduce((acc, ev) => {
      acc.items += ev.items.length;
      acc.slots += ev.slots.length;
      acc.crew += ev.teardown.length;
      return acc;
    }, { items: 0, slots: 0, crew: 0 });

    $('#view-settings').innerHTML = `
      <div class="viewhead"><span class="viewhead__title">${t('set.title')}</span></div>

      <div class="card"><div class="card__body" style="padding:16px">
        <div class="block">
          <div class="block__head"><span class="block__title">${t('set.group')}</span></div>
          <div class="grid2">
            <label class="field">
              <span class="field__label">${t('set.teamName')}</span>
              <input class="input" id="setTeam" maxlength="80" value="${esc(state.teamName)}">
            </label>
            <label class="field">
              <span class="field__label">${t('set.season')} <span class="field__opt">${t('common.optional')}</span></span>
              <input class="input" id="setSeason" maxlength="24" value="${esc(state.season)}" placeholder="2026/27">
            </label>
          </div>
          <div class="addbar"><button class="btn btn--sm btn--primary" type="button" data-act="save-settings">${t('set.save')}</button></div>
        </div>

        <div class="block">
          <div class="block__head"><span class="block__title">${t('set.language')}</span></div>
          <div class="addbar">
            ${window.I18N.langs.map((code) => `
              <button class="btn btn--sm ${code === lang ? 'btn--primary' : ''}" type="button"
                      data-act="set-lang" data-lang="${code}">${esc(window.I18N.name(code))}</button>`).join('')}
          </div>
        </div>

        <div class="block">
          <div class="block__head"><span class="block__title">${t('set.sharing')}</span></div>
          <p class="block__note">${t('set.sharingText')}</p>
          <div class="addbar">
            <input class="input" id="setLink" readonly value="${esc(location.origin)}">
            <button class="btn btn--sm" type="button" data-act="copy-link">${t('set.copyLink')}</button>
          </div>
        </div>

        <div class="block">
          <div class="block__head"><span class="block__title">${t('set.members')}</span></div>
          ${(state.members || []).length
            ? `<div class="crew">${state.members.map((m) => `<span class="crewchip">${esc(m.name)}${isMe(m.name) ? t('cat.you') : ''}</span>`).join('')}</div>`
            : `<p class="block__note">${t('set.membersEmpty')}</p>`}
        </div>

        <div class="block">
          <div class="block__head"><span class="block__title">${t('set.device')}</span></div>
          <p class="block__note">${t('set.deviceStats', {
            name: `<b>${who ? esc(who) : t('common.nobodyYet')}</b>`,
            events: state.events.length,
            items: totals.items,
            slots: totals.slots,
            crew: totals.crew,
          })}</p>
          <p class="block__note">${t('set.devicePrivacy')}</p>
        </div>
      </div></div>`;
  }

  // ------------------------------------------------------------- dialogs ----

  function confirmAsk(title, text, okLabel) {
    okLabel = okLabel || t('common.delete');
    return new Promise((resolve) => {
      const dlg = $('#confirmModal');
      const cancel = $('#confirmModal [data-close]');
      if (cancel) cancel.textContent = t('common.cancel');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#confirmOk').textContent = okLabel;
      const done = (value) => {
        $('#confirmOk').removeEventListener('click', onOk);
        dlg.removeEventListener('close', onClose);
        dlg.close();
        resolve(value);
      };
      const onOk = () => done(true);
      const onClose = () => done(false);
      $('#confirmOk').addEventListener('click', onOk);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

  let editingId = null;

  function openEventModal(ev) {
    editingId = ev ? ev.id : null;
    $('#eventModalTitle').textContent = ev ? t('ev.editTitle') : t('ev.addTitle');
    $('#eventSubmit').textContent = ev ? t('ev.saveChanges') : t('ev.addFixture');
    $('#evPresetWrap').hidden = Boolean(ev);
    $('#eventError').hidden = true;

    const nextSaturday = () => {
      const d = new Date();
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    $('#evDate').value = ev ? ev.date : nextSaturday();
    $('#evKickoff').value = ev ? ev.kickoff : '15:00';
    $('#evOpponent').value = ev ? ev.opponent : '';
    $('#evVenue').value = ev ? ev.venue : '';
    $('#evDutyFrom').value = ev ? ev.dutyFrom : '13:00';
    $('#evDutyTo').value = ev ? ev.dutyTo : '18:00';
    $('#evTeardown').value = ev ? ev.teardownTarget : 4;
    $('#evNotes').value = ev ? ev.notes : '';
    $('#evPresets').checked = true;
    $('#eventModal').showModal();
  }

  $('#eventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#eventError');
    const payload = {
      date: $('#evDate').value,
      kickoff: $('#evKickoff').value,
      opponent: $('#evOpponent').value,
      venue: $('#evVenue').value,
      dutyFrom: $('#evDutyFrom').value,
      dutyTo: $('#evDutyTo').value,
      teardownTarget: $('#evTeardown').value,
      notes: $('#evNotes').value,
    };
    if (!payload.date) { err.textContent = t('ev.pickDate'); err.hidden = false; return; }
    if (mins(payload.dutyTo) <= mins(payload.dutyFrom)) {
      err.textContent = t('ev.dutyOrder');
      err.hidden = false;
      return;
    }
    if (!editingId && $('#evPresets').checked) {
      payload.items = window.I18N.presets().slice(0, 6).map((name) => ({ name }));
    }
    const ok = editingId
      ? await mutate('PATCH', `/api/events/${editingId}`, payload, t('ev.updated'))
      : await mutate('POST', '/api/events', payload, t('ev.added'));
    if (ok) {
      if (!editingId) {
        const added = state.events.find((x) => x.date === payload.date && x.kickoff === payload.kickoff);
        if (added) { open.add(added.id); persistOpen(); render(); }
      }
      $('#eventModal').close();
    } else {
      err.textContent = t('ev.saveFailed');
      err.hidden = false;
    }
  });

  function persistOpen() { store.set(LS.open, [...open].join(',')); }

  // --------------------------------------------------------------- share ----

  function summary(ev) {
    const L = [];
    L.push(`*${state.teamName || 'Home game'} — ${longDate(ev.date)}*`);
    L.push(`⚽ ${t('sum.vs', { opponent: ev.opponent || 'TBD', time: ev.kickoff })}`);
    if (ev.venue) L.push(`📍 ${ev.venue}`);
    L.push(`🕒 ${t('sum.duty', { from: ev.dutyFrom, to: ev.dutyTo })}`);
    if (ev.notes) L.push(`ℹ️ ${ev.notes}`);

    L.push('', `*${t('sum.catering')}*`);
    if (!ev.items.length) {
      L.push(t('sum.nothingListed'));
    } else {
      for (const item of ev.items) {
        const label = item.qty ? `${item.name} (${item.qty})` : item.name;
        L.push(item.claimedBy ? `✅ ${label} — ${item.claimedBy}` : `⬜ ${label} — *${t('sum.free')}*`);
      }
      const free = ev.items.filter((i) => !i.claimedBy).length;
      if (free) L.push(free === 1 ? t('sum.unclaimedOne') : t('sum.unclaimedMany', { n: free }));
    }

    L.push('', `*${t('sum.available')}*`);
    if (!ev.slots.length) L.push(t('sum.nobody'));
    else for (const s of ev.slots) L.push(`• ${s.from}–${s.to} ${s.name}${s.note ? ` (${s.note})` : ''}`);

    L.push('', `*${t('sum.teardown')}*`);
    if (!ev.teardown.length) {
      L.push(t('sum.nobody'));
    } else {
      L.push(ev.teardown.map((p) => p.name).join(', '));
    }
    const need = Math.max(0, (ev.teardownTarget || 0) - ev.teardown.length);
    if (need) L.push(t('sum.moreNeeded', { n: need }));

    L.push('', t('sum.signUp', { url: location.origin }));
    return L.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function openShare(ev) {
    const text = summary(ev);
    $('#shareText').value = text;
    $('#shareModal').showModal();
    $('#shareCopy').onclick = async () => {
      if (await copyText(text)) {
        toast(t('share.copied'));
        $('#shareModal').close();
      } else {
        $('#shareText').select();
        toast(t('share.manual'), true);
      }
    };
  }

  // -------------------------------------------------------- interactions ----

  /** One delegated click handler for the whole app. */
  $('#main').addEventListener('click', async (e) => {
    const trigger = e.target.closest('[data-act]');
    if (!trigger) return;
    const act = trigger.dataset.act;

    if (act === 'new') return openEventModal(null);
    if (act === 'save-settings') {
      return void mutate('PATCH', '/api/settings', {
        teamName: $('#setTeam').value,
        season: $('#setSeason').value,
      }, t('set.saved'));
    }
    if (act === 'set-lang') {
      lang = window.I18N.set(trigger.dataset.lang);
      store.set(LS.lang, lang);
      render();
      return;
    }
    if (act === 'copy-link') {
      return void toast(await copyText(location.origin) ? t('set.linkCopied') : t('set.copyFailed'), false);
    }

    const cardEl = trigger.closest('[data-ev]');
    if (!cardEl) return;
    const id = cardEl.dataset.ev;
    const ev = state.events.find((x) => x.id === id);
    if (!ev) return;

    const base = `/api/events/${id}`;
    const itemId = () => trigger.closest('[data-item]').dataset.item;
    const slotId = () => trigger.closest('[data-slot]').dataset.slot;
    const input = (key) => $(`[data-in="${key}"]`, cardEl);

    switch (act) {
      case 'toggle': {
        if (open.has(id)) open.delete(id); else open.add(id);
        persistOpen();
        return render();
      }

      case 'share': return openShare(ev);
      case 'edit': return openEventModal(ev);

      case 'lock':
        return void mutate('PATCH', base, { locked: !ev.locked }, ev.locked ? t('fx.unlocked') : t('fx.locked'));

      case 'del': {
        if (!await confirmAsk(t('fx.confirmDeleteTitle'),
          t('fx.confirmDeleteText', { opponent: ev.opponent || 'TBD', date: longDate(ev.date) }))) return;
        open.delete(id);
        persistOpen();
        return void mutate('DELETE', base, null, t('fx.deleted'));
      }

      // --- catering -------------------------------------------------------
      case 'claim':
      case 'take':
        return void mutate('PATCH', `${base}/items/${itemId()}`, { claimedBy: who },
          act === 'take' ? t('cat.takenOver') : t('cat.claimed'));

      case 'release':
        return void mutate('PATCH', `${base}/items/${itemId()}`, { claimedBy: '' }, t('cat.released'));

      case 'item-del': {
        const row = trigger.closest('[data-item]');
        const item = ev.items.find((x) => x.id === row.dataset.item);
        if (item && item.claimedBy && !isMe(item.claimedBy)) {
          if (!await confirmAsk(t('cat.confirmRemoveTitle'),
            t('cat.confirmRemoveText', { item: item.name, name: item.claimedBy }), t('common.remove'))) return;
        }
        return void mutate('DELETE', `${base}/items/${row.dataset.item}`, null, t('cat.removed'));
      }

      case 'item-edit': {
        const row = trigger.closest('[data-item]');
        const item = ev.items.find((x) => x.id === row.dataset.item);
        if (!item) return;
        const name = prompt(t('cat.promptName'), item.name);
        if (name === null) return;
        if (!name.trim()) return void toast(t('cat.nameRequired'), true);
        const qty = prompt(t('cat.promptQty'), item.qty || '');
        if (qty === null) return;
        const note = prompt(t('cat.promptNote'), item.note || '');
        if (note === null) return;
        return void mutate('PATCH', `${base}/items/${item.id}`, { name, qty, note }, t('cat.updated'));
      }

      case 'preset':
        return void mutate('POST', `${base}/items`, { name: trigger.dataset.name }, t('cat.added'));

      case 'item-add':
      case 'item-add-mine': {
        const nameEl = input('itemName');
        const qtyEl = input('itemQty');
        const name = nameEl.value.trim();
        if (!name) { nameEl.focus(); return void toast(t('cat.needName'), true); }
        const ok = await mutate('POST', `${base}/items`, {
          name,
          qty: qtyEl.value.trim(),
          claimedBy: act === 'item-add-mine' ? who : '',
        }, t('cat.added'));
        if (ok) {
          const fresh = $(`[data-ev="${id}"] [data-in="itemName"]`);
          if (fresh) fresh.focus();
        }
        return;
      }

      // --- availability ---------------------------------------------------
      case 'slot-add': {
        const from = input('slotFrom').value;
        const to = input('slotTo').value;
        if (!from || !to) return void toast(t('av.bothTimes'), true);
        if (mins(to) <= mins(from)) return void toast(t('av.endAfterStart'), true);
        return void mutate('POST', `${base}/slots`, { name: who, from, to, note: input('slotNote').value.trim() },
          t('av.noted', { from, to }));
      }

      case 'slot-del': {
        const row = trigger.closest('[data-slot]');
        const slot = ev.slots.find((x) => x.id === row.dataset.slot);
        if (slot && !isMe(slot.name)) {
          if (!await confirmAsk(t('av.confirmRemoveTitle'),
            t('av.confirmRemoveText', { name: slot.name }), t('common.remove'))) return;
        }
        return void mutate('DELETE', `${base}/slots/${row.dataset.slot}`, null, t('av.removed'));
      }

      case 'slot-edit': {
        const row = trigger.closest('[data-slot]');
        const slot = ev.slots.find((x) => x.id === row.dataset.slot);
        if (!slot) return;
        const from = prompt(t('av.promptFrom'), slot.from);
        if (from === null) return;
        const to = prompt(t('av.promptTo'), slot.to);
        if (to === null) return;
        return void mutate('PATCH', `${base}/slots/${slot.id}`, { from, to }, t('av.updated'));
      }

      // --- teardown -------------------------------------------------------
      case 'crew-join':
        return void mutate('POST', `${base}/teardown`, { name: who }, t('td.joined'));

      case 'crew-leave': {
        const me = ev.teardown.find((p) => isMe(p.name));
        if (!me) return;
        return void mutate('DELETE', `${base}/teardown/${me.id}`, null, t('td.left'));
      }

      case 'crew-del': {
        const chip = trigger.closest('[data-person]');
        const person = ev.teardown.find((p) => p.id === chip.dataset.person);
        if (person && !isMe(person.name)) {
          if (!await confirmAsk(t('td.confirmRemoveTitle'),
            t('td.confirmRemoveText', { name: person.name }), t('common.remove'))) return;
        }
        return void mutate('DELETE', `${base}/teardown/${chip.dataset.person}`, null, t('td.removed'));
      }
    }
  });

  // Enter inside an add field triggers its button instead of reloading.
  $('#main').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!el.matches || !el.matches('[data-in]')) return;
    e.preventDefault();
    const cardEl = el.closest('[data-ev]');
    const key = el.dataset.in;
    const act = key.startsWith('item') ? 'item-add' : key.startsWith('slot') ? 'slot-add' : null;
    if (act && cardEl) $(`[data-act="${act}"]`, cardEl)?.click();
  });

  // ---------------------------------------------------------------- boot ----

  // Poll gently so a phone left open picks up other people's edits.
  setInterval(() => {
    if (!$('#app').hidden && document.visibilityState === 'visible') refresh(true);
  }, 20000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#app').hidden) refresh(true);
  });

  (async () => {
    applyStaticText();
    if (await refresh(true)) showApp();
    else showGate();
  })();
})();
