// Афиша Астаны — инициализация, рендер, тема, модальное окно.
import {
  buildDays, renderCalendar, scrollToSelected, todayIso, addDays, formatDay, formatShort,
  relativeLabel, capitalize, eventsWord,
} from './calendar.js';
import {
  CATEGORIES, categoryById, indexEvents, matchesBase, occursOn, filterEvents, sortForDay, categoryCounts,
} from './filters.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
};

const els = {
  days: $('#days'),
  calbar: $('#calbar'),
  viewToggle: $('#viewToggle'),
  viewToggleLabel: $('#viewToggleLabel'),
  chips: $('#chips'),
  search: $('#search'),
  free: $('#freeToggle'),
  results: $('#results'),
  dayTitle: $('#dayTitle'),
  eyebrow: $('#eyebrow'),
  updated: $('#updated'),
  footMeta: $('#footMeta'),
  sources: $('#sources'),
  sheet: $('#sheet'),
  sheetBody: $('#sheetBody'),
  theme: $('#themeToggle'),
};

const cal = buildDays(todayIso());
let events = [];
let byId = new Map();

const state = {
  date: cal.today,
  category: 'all',
  query: '',
  freeOnly: false,
  view: store.get('afisha-view') === 'grid' ? 'grid' : 'strip',
};

/* ---------------- Тема ---------------- */
function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) store.set('afisha-theme', theme);
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach((m) => m.setAttribute('content', theme === 'dark' ? '#090D16' : '#F2F5FA'));
  els.theme.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
}
els.theme.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
});
if (window.matchMedia) {
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
    if (!store.get('afisha-theme')) applyTheme(e.matches ? 'dark' : 'light', false);
  });
}
applyTheme(document.documentElement.dataset.theme || 'light', false);

/* ---------------- URL-состояние ---------------- */
function readUrl() {
  const p = new URLSearchParams(location.search);
  const d = p.get('d');
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cal.today && d <= cal.end) state.date = d;
  const c = p.get('c');
  if (c && categoryById[c]) state.category = c;
  state.query = p.get('q') || '';
  state.freeOnly = p.get('free') === '1';
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.date !== cal.today) p.set('d', state.date);
  if (state.category !== 'all') p.set('c', state.category);
  if (state.query) p.set('q', state.query);
  if (state.freeOnly) p.set('free', '1');
  const qs = p.toString();
  history.replaceState(history.state, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
}

/* ---------------- Рендер ---------------- */
const eventsForDay = (iso) => events.filter((ev) => occursOn(ev, iso) && matchesBase(ev, state));

function renderAll({ scroll = false } = {}) {
  renderCalendar(els.days, cal, eventsForDay, state.date);
  if (scroll) scrollToSelected(els.days, false);
  renderChips();
  renderHeading();
  renderResults();
  writeUrl();
}

function renderHeading({ loading = false } = {}) {
  const rel = relativeLabel(state.date, cal.today);
  const full = formatDay(state.date, { withDow: false });
  const wd = formatDay(state.date).split(', ')[1];
  els.dayTitle.innerHTML = rel
    ? `${rel}, <span class="soft">${esc(full)}</span>`
    : `${esc(capitalize(full))}, <span class="soft">${esc(wd)}</span>`;
  if (loading) { els.eyebrow.textContent = `${capitalize(wd)} · загружаем афишу…`; return; }
  const n = filterEvents(events, state).length;
  els.eyebrow.textContent = rel ? `${capitalize(wd)} · ${n} ${eventsWord(n)}` : `${n} ${eventsWord(n)} в Астане`;
}

function renderChips() {
  const counts = categoryCounts(events, state);
  els.chips.innerHTML = CATEGORIES.map((c) => `
    <button type="button" class="chip${counts[c.id] ? '' : ' chip--zero'}" data-cat="${c.id}" aria-pressed="${state.category === c.id}">
      <svg class="i" aria-hidden="true"><use href="#${c.icon}"/></svg>
      <span>${esc(c.label)}</span>
      <span class="chip__n num">${counts[c.id] || 0}</span>
    </button>`).join('');
}

function timeLine(ev) {
  if (ev.end_date) return `до ${formatShort(ev.end_date)}`;
  if (ev.times && ev.times.length > 1) return `${ev.times[0]} <span class="meta__sep">+${ev.times.length - 1}</span>`;
  return ev.time || 'Весь день';
}

function priceHtml(ev, cls = 'price') {
  if (ev.is_free) return `<span class="${cls} price--free">Бесплатно</span>`;
  if (ev.price_label) return `<span class="${cls}">${esc(ev.price_label)}</span>`;
  return `<span class="${cls} price--na">Цена на сайте</span>`;
}

function posterHtml(ev, { large = false, eager = false } = {}) {
  const cat = categoryById[ev.category] || categoryById.events;
  const fallback = `<span class="poster__fallback"><svg class="i"><use href="#${cat.icon}"/></svg></span>`;
  const src = large ? (ev.image_large || ev.image_url) : (ev.image_small || ev.image_url);
  if (!src) return fallback;
  const srcset = !large && ev.image_small && ev.image_url ? ` srcset="${esc(ev.image_small)} 352w, ${esc(ev.image_url)} 760w" sizes="(max-width: 767px) 92vw, (max-width: 1023px) 46vw, 300px"` : '';
  return `<img src="${esc(src)}"${srcset} alt="" ${large || eager ? '' : 'loading="lazy"'}${eager === 'high' ? ' fetchpriority="high"' : ''} decoding="async" referrerpolicy="no-referrer" data-fallback>`;
}

function cardHtml(ev, i) {
  const cat = categoryById[ev.category] || categoryById.events;
  return `
  <article class="card" style="--i:${Math.min(i, 12)}">
    <div class="poster">
      ${posterHtml(ev, { eager: i === 0 ? 'high' : i < 4 })}
      <span class="badge"><svg class="i" aria-hidden="true"><use href="#${cat.icon}"/></svg>${esc(cat.short || cat.label)}</span>
    </div>
    <div class="card__body">
      <h3 class="card__title"><button type="button" class="card__open" data-open="${esc(ev.id)}">${esc(ev.title)}</button></h3>
      <div class="meta">
        <svg class="i" aria-hidden="true"><use href="#i-clock"/></svg>
        <span class="meta__time">${timeLine(ev)}</span>
        ${ev.venue ? `<span class="meta__sep">·</span><span class="meta__venue">${esc(ev.venue)}</span>` : ''}
      </div>
      <div class="card__foot">
        ${priceHtml(ev)}
        <a class="btn btn--ghost card__cta" href="${esc(ev.ticket_url || ev.source_url)}" target="_blank" rel="noopener" aria-label="Билеты: ${esc(ev.title)}">Билеты<svg class="i" aria-hidden="true"><use href="#i-arrow"/></svg></a>
      </div>
    </div>
  </article>`;
}

function nearestDayWithEvents(from) {
  for (let iso = addDays(from, 1); iso <= cal.end; iso = addDays(iso, 1)) {
    if (eventsForDay(iso).length) return iso;
  }
  for (let iso = addDays(from, -1); iso >= cal.today; iso = addDays(iso, -1)) {
    if (eventsForDay(iso).length) return iso;
  }
  return null;
}

function renderEmpty() {
  const next = nearestDayWithEvents(state.date);
  const filtered = state.category !== 'all' || state.query || state.freeOnly;
  const title = filtered ? 'Ничего не нашлось' : 'В этот день пока пусто';
  const text = next
    ? `Зато ${relativeLabel(next, cal.today)?.toLowerCase() || formatDay(next, { withDow: false })} есть что посмотреть.`
    : 'Попробуйте изменить фильтры или загляните позже — афиша обновляется каждые 6 часов.';
  els.results.innerHTML = `
    <div class="empty">
      <div class="empty__icon"><svg class="i" aria-hidden="true"><use href="#i-grid"/></svg></div>
      <h2>${title}</h2>
      <p>${esc(text)}</p>
      <div class="empty__actions">
        ${next ? `<button type="button" class="btn btn--primary" data-goto="${next}">${esc(capitalize(formatDay(next)))}<svg class="i" aria-hidden="true"><use href="#i-arrow"/></svg></button>` : ''}
        ${filtered ? '<button type="button" class="btn btn--ghost" data-reset>Сбросить фильтры</button>' : ''}
      </div>
    </div>`;
}

function renderResults() {
  const list = filterEvents(events, state);
  if (!list.length) return renderEmpty();
  const { timed, long } = sortForDay(list);
  let i = 0;
  const group = (title, hint, items) => `
    <section class="group">
      <div class="group__head">
        <h2 class="group__title">${title} <small class="num">${items.length}</small></h2>
        ${hint ? `<span class="group__hint">${hint}</span>` : ''}
      </div>
      <div class="grid">${items.map((ev) => cardHtml(ev, i++)).join('')}</div>
    </section>`;
  let html = '';
  if (timed.length) html += group('По расписанию', '', timed);
  if (long.length) html += group('Идут сейчас', 'выставки и программы на несколько дней', long);
  els.results.innerHTML = html;
}

/* ---------------- Модальное окно ---------------- */
function mapLinks(ev) {
  const place = [ev.venue, ev.address].filter(Boolean).join(', ');
  if (!place) return '';
  const q = encodeURIComponent(`${place}, Астана`);
  return `<div class="fact__links">
    <a href="https://2gis.kz/astana/search/${encodeURIComponent(place)}" target="_blank" rel="noopener">Открыть в 2GIS</a>
    <a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Google Maps</a>
  </div>`;
}

function whenHtml(ev) {
  const day = state.date && occursOn(ev, state.date) ? state.date : ev.date;
  if (ev.end_date) {
    return `<div class="fact__main">${esc(capitalize(formatDay(day)))}</div>
      <div class="fact__sub">Идёт с ${esc(formatDay(ev.date, { withDow: false }))} по ${esc(formatDay(ev.end_date, { withDow: false }))}${ev.time ? ` · с ${esc(ev.time)}` : ''}</div>`;
  }
  const times = ev.times && ev.times.length > 1
    ? `<div class="times">${ev.times.map((t) => `<span class="num">${esc(t)}</span>`).join('')}</div>` : '';
  return `<div class="fact__main">${esc(capitalize(formatDay(ev.date)))}${ev.time && !times ? ` · <span class="num">${esc(ev.time)}</span>` : ''}</div>${times}`;
}

function openSheet(id, { push = true } = {}) {
  const ev = byId.get(id);
  if (!ev) return;
  const cat = categoryById[ev.category] || categoryById.events;
  const ticket = ev.ticket_url || ev.source_url;
  els.sheetBody.innerHTML = `
    <div class="sheet__grab" aria-hidden="true"></div>
    <button type="button" class="sheet__close" data-close aria-label="Закрыть"><svg class="i"><use href="#i-close"/></svg></button>
    <a class="sheet__poster" href="${esc(ticket)}" target="_blank" rel="noopener" aria-label="Перейти к билетам: ${esc(ev.title)}">
      ${posterHtml(ev, { large: true })}
      <span class="badge"><svg class="i" aria-hidden="true"><use href="#${cat.icon}"/></svg>${esc(cat.label)}</span>
      <span class="sheet__poster-hint"><svg class="i" aria-hidden="true"><use href="#i-ticket"/></svg>К билетам</span>
    </a>
    <div class="sheet__content">
      <h2 class="sheet__title" id="sheetTitle">${esc(ev.title)}</h2>
      <div class="facts">
        <div class="fact">
          <span class="fact__icon"><svg class="i" aria-hidden="true"><use href="#i-clock"/></svg></span>
          <div>${whenHtml(ev)}</div>
        </div>
        ${ev.venue || ev.address ? `
        <div class="fact">
          <span class="fact__icon"><svg class="i" aria-hidden="true"><use href="#i-pin"/></svg></span>
          <div>
            <div class="fact__main">${esc(ev.venue || ev.address)}</div>
            ${ev.venue && ev.address ? `<div class="fact__sub">${esc(ev.address)}, Астана</div>` : ''}
            ${mapLinks(ev)}
          </div>
        </div>` : ''}
      </div>
      ${ev.short_description ? `<p class="sheet__desc">${esc(ev.short_description)}</p>` : ''}
      <p class="fact__sub">Источник: <a href="${esc(ev.source_url)}" target="_blank" rel="noopener">${esc(ev.source_name || 'страница события')}</a></p>
    </div>
    <div class="sheet__foot">
      <div class="sheet__price">${priceHtml(ev, 'num')}<small>${ev.is_free ? 'вход свободный' : 'стоимость билета'}</small></div>
      <a class="btn btn--primary" href="${esc(ticket)}" target="_blank" rel="noopener">Перейти к билетам<svg class="i" aria-hidden="true"><use href="#i-arrow"/></svg></a>
    </div>`;
  bindFallbacks(els.sheetBody);
  if (!els.sheet.open) {
    els.sheet.showModal();
    document.documentElement.style.overflow = 'hidden';
  }
  els.sheetBody.scrollTop = 0;
  els.sheetBody.style.transform = '';
  if (push && location.hash !== `#${id}`) history.pushState({ sheet: id }, '', `${location.pathname}${location.search}#${id}`);
}

function closeSheet({ fromHistory = false } = {}) {
  if (!els.sheet.open) return;
  els.sheet.close();
}
els.sheet.addEventListener('close', () => {
  document.documentElement.style.overflow = '';
  if (location.hash) {
    if (history.state && history.state.sheet) history.back();
    else history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
});
els.sheet.addEventListener('click', (e) => {
  if (e.target === els.sheet || e.target.closest('[data-close]')) closeSheet();
});
window.addEventListener('popstate', () => {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && byId.has(id)) openSheet(id, { push: false });
  else if (els.sheet.open) els.sheet.close();
});

// Свайп вниз закрывает bottom-sheet на телефоне.
(() => {
  let y0 = null, dy = 0;
  const panel = els.sheetBody;
  panel.addEventListener('touchstart', (e) => {
    y0 = panel.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 === null) return;
    panel.style.transition = 'transform .25s ease';
    if (dy > 110) closeSheet();
    panel.style.transform = '';
    setTimeout(() => { panel.style.transition = ''; }, 260);
    y0 = null;
  });
})();

/* ---------------- Картинки: стильная заглушка при битой ссылке ---------------- */
function bindFallbacks(root) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    if (img.dataset.bound) return;
    img.dataset.bound = '1';
    const fail = () => {
      const ev = byId.get(img.closest('.card')?.querySelector('[data-open]')?.dataset.open);
      // Сначала пробуем запасной размер, потом — градиент.
      if (img.srcset) { img.removeAttribute('srcset'); return; }
      if (ev && ev.image_url && !img.src.endsWith(ev.image_url) && !img.dataset.retried) {
        img.dataset.retried = '1'; img.src = ev.image_url; return;
      }
      const wrap = img.parentElement;
      const icon = wrap.querySelector('.badge use')?.getAttribute('href') || '#i-events';
      img.outerHTML = `<span class="poster__fallback"><svg class="i"><use href="${icon}"/></svg></span>`;
    };
    if (img.complete && img.naturalWidth === 0 && img.src) fail();
    else img.addEventListener('error', fail);
  });
}
new MutationObserver(() => bindFallbacks(els.results)).observe(els.results, { childList: true });

/* ---------------- События интерфейса ---------------- */
function selectDate(iso, { fromGrid = false } = {}) {
  if (!iso || iso < cal.today || iso > cal.end) return;
  state.date = iso;
  if (fromGrid && state.view === 'grid' && window.innerWidth < 768) setView('strip');
  renderAll();
  scrollToSelected(els.days);
  if (fromGrid && window.innerWidth < 768) els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

els.days.addEventListener('click', (e) => {
  const b = e.target.closest('.day[data-date]');
  if (b && !b.disabled) selectDate(b.dataset.date, { fromGrid: state.view === 'grid' });
});
els.days.addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: state.view === 'grid' ? 7 : 1, ArrowUp: state.view === 'grid' ? -7 : -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const next = addDays(state.date, step);
  if (next < cal.today || next > cal.end) return;
  selectDate(next);
  els.days.querySelector('.day--selected')?.focus();
});

function setView(view) {
  state.view = view;
  store.set('afisha-view', view);
  els.calbar.classList.toggle('calbar--grid', view === 'grid');
  els.viewToggle.setAttribute('aria-pressed', String(view === 'grid'));
  els.viewToggleLabel.textContent = view === 'grid' ? 'Лента' : 'Календарь';
  els.viewToggle.setAttribute('aria-label', view === 'grid' ? 'Свернуть в ленту дат' : 'Показать календарь на 3 недели');
  if (view === 'strip') requestAnimationFrame(() => scrollToSelected(els.days, false));
}
els.viewToggle.addEventListener('click', () => setView(state.view === 'grid' ? 'strip' : 'grid'));

els.chips.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.category = b.dataset.cat;
  renderAll();
});

let searchTimer;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = els.search.value.trim(); renderAll(); }, 120);
});

els.free.addEventListener('click', () => {
  state.freeOnly = !state.freeOnly;
  els.free.setAttribute('aria-checked', String(state.freeOnly));
  renderAll();
});

els.results.addEventListener('click', (e) => {
  if (e.target.closest('.card__cta')) return; // прямой переход к билетам
  const go = e.target.closest('[data-goto]');
  if (go) { selectDate(go.dataset.goto); return; }
  if (e.target.closest('[data-reset]')) {
    Object.assign(state, { category: 'all', query: '', freeOnly: false });
    els.search.value = '';
    els.free.setAttribute('aria-checked', 'false');
    renderAll();
    return;
  }
  const card = e.target.closest('.card');
  const id = card?.querySelector('[data-open]')?.dataset.open;
  if (id) openSheet(id);
});

/* ---------------- Загрузка данных ---------------- */
function formatUpdated(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() + 5 * 3600000);
  const day = formatDay(local.toISOString().slice(0, 10), { withDow: false });
  const hm = local.toISOString().slice(11, 16);
  return `${day} в ${hm}`;
}

async function load() {
  readUrl();
  els.search.value = state.query;
  els.free.setAttribute('aria-checked', String(state.freeOnly));
  setView(state.view);
  renderCalendar(els.days, cal, () => [], state.date);
  renderChips();
  renderHeading({ loading: true });
  try {
    const res = await fetch('data/events.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    events = indexEvents((data.events || []).filter((ev) => (ev.end_date || ev.date) >= cal.today));
    byId = new Map(events.map((ev) => [ev.id, ev]));
    // Сколько дней окна занимает событие с таким названием (для разнообразия превью в календаре).
    const freq = new Map();
    for (let iso = cal.today; iso <= cal.end; iso = addDays(iso, 1)) {
      const seen = new Set(events.filter((ev) => occursOn(ev, iso)).map((ev) => ev.title));
      seen.forEach((t) => freq.set(t, (freq.get(t) || 0) + 1));
    }
    events.forEach((ev) => { ev._freq = freq.get(ev.title) || 1; });
    if (data.updated_at) {
      const u = formatUpdated(data.updated_at);
      els.updated.textContent = `Обновлено ${u}`;
      els.updated.hidden = false;
      els.footMeta.textContent = `Обновлено ${u} · ${events.length} ${eventsWord(events.length)} на ближайшие 15 дней`;
    }
    const names = [...new Set(events.map((e) => e.source_name).filter(Boolean))];
    if (names.length) els.sources.textContent = names.join(', ');
  } catch (err) {
    console.error(err);
    els.results.innerHTML = `<div class="empty"><div class="empty__icon"><svg class="i"><use href="#i-close"/></svg></div>
      <h2>Не удалось загрузить афишу</h2><p>Проверьте соединение и обновите страницу.</p>
      <div class="empty__actions"><button class="btn btn--primary" type="button" onclick="location.reload()">Обновить</button></div></div>`;
    renderCalendar(els.days, cal, () => [], state.date);
    return;
  }
  renderAll({ scroll: true });
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId && byId.has(hashId)) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    openSheet(hashId);
  }
}

load();
