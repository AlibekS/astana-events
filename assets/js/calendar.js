// Лента дат: текущая неделя (прошедшие дни приглушены) + ровно 15 дней от сегодня.
// Та же разметка раскладывается CSS-ом в сетку-календарь 7×N.

export const WINDOW_DAYS = 15;
const ASTANA_OFFSET_MIN = 5 * 60; // UTC+5

const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const DOW_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Даты храним как 'YYYY-MM-DD' и считаем в UTC, чтобы не зависеть от пояса зрителя. */
export function todayIso() {
  const now = new Date(Date.now() + ASTANA_OFFSET_MIN * 60000);
  return now.toISOString().slice(0, 10);
}
export function parseIso(iso) { return new Date(iso + 'T00:00:00Z'); }
export function toIso(d) { return d.toISOString().slice(0, 10); }
export function addDays(iso, n) { const d = parseIso(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); }
export function dow(iso) { return parseIso(iso).getUTCDay(); }

export function formatDay(iso, { withDow = true } = {}) {
  const d = parseIso(iso);
  const s = `${d.getUTCDate()} ${MON_GEN[d.getUTCMonth()]}`;
  return withDow ? `${s}, ${DOW_FULL[d.getUTCDay()]}` : s;
}
export function formatShort(iso) {
  const d = parseIso(iso);
  return `${d.getUTCDate()} ${MON_SHORT[d.getUTCMonth()]}`;
}
export function relativeLabel(iso, today = todayIso()) {
  if (iso === today) return 'Сегодня';
  if (iso === addDays(today, 1)) return 'Завтра';
  if (iso === addDays(today, 2)) return 'Послезавтра';
  return null;
}
export function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** Ячейки календаря: с понедельника текущей недели до конца окна, добито до воскресенья. */
export function buildDays(today = todayIso()) {
  const shift = (dow(today) + 6) % 7; // 0 = понедельник
  const start = addDays(today, -shift);
  const end = addDays(today, WINDOW_DAYS - 1);
  const tailPad = (7 - ((dow(end) + 6) % 7) - 1);
  const days = [];
  for (let iso = start; iso <= end; iso = addDays(iso, 1)) {
    const d = parseIso(iso);
    const wd = d.getUTCDay();
    days.push({
      iso,
      num: d.getUTCDate(),
      mon: MON_SHORT[d.getUTCMonth()],
      dow: DOW[wd],
      weekend: wd === 0 || wd === 6,
      past: iso < today,
      today: iso === today,
    });
  }
  for (let i = 1; i <= tailPad; i++) days.push({ iso: addDays(end, i), pad: true });
  return { days, start, end, today };
}

function thumbsHtml(list, total, max, mod) {
  if (!total) return `<span class="stack stack--${mod}"><span class="stack__dot"></span></span>`;
  const imgs = list
    .slice(0, max)
    .map((ev) => `<img class="stack__img" src="${ev.image_thumb || ev.image_small || ev.image_url || ''}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`)
    .join('');
  const more = total > max ? `<span class="stack__more">+${total - max}</span>` : '';
  return `<span class="stack stack--${mod}" aria-hidden="true">${imgs}${more}</span>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
export const eventsWord = (n) => plural(n, 'событие', 'события', 'событий');

/**
 * @param {HTMLElement} root
 * @param {{days: object[]}} cal
 * @param {(iso: string) => object[]} eventsFor — события дня с учётом фильтров
 * @param {string} selected
 */
export function renderCalendar(root, cal, eventsFor, selected) {
  const heads = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
    .map((d, i) => `<span class="day-head${i > 4 ? ' day-head--we' : ''}" aria-hidden="true">${d}</span>`).join('');
  const html = heads + cal.days.map((day) => {
    if (day.pad) return '<span class="day day--pad" aria-hidden="true"></span>';
    const list = day.past ? [] : eventsFor(day.iso);
    const total = list.length;
    const cls = ['day'];
    if (day.weekend) cls.push('day--weekend');
    if (day.past) cls.push('day--past');
    if (day.today) cls.push('day--today');
    if (!total && !day.past) cls.push('day--empty');
    if (day.iso === selected) cls.push('day--selected');
    // В превью — самые «уникальные» события дня: то, что идёт каждый день, уходит в конец.
    const preview = [...list].sort((a, b) => (a._freq || 1) - (b._freq || 1) || (a.time || '99').localeCompare(b.time || '99'));
    const label = `${formatDay(day.iso)}${day.today ? ', сегодня' : ''}: ${day.past ? 'прошедший день' : `${total} ${eventsWord(total)}`}`;
    return `<button type="button" class="${cls.join(' ')}" data-date="${day.iso}" role="option"
        aria-selected="${day.iso === selected}" ${day.past ? 'disabled' : ''}>
        <span class="sr-only">${label}</span>
        ${day.today ? '<span class="day__today" aria-hidden="true"></span>' : ''}
        <span class="day__dow" aria-hidden="true">${day.dow}</span>
        <span class="day__num" aria-hidden="true">${day.num}</span>
        <span class="day__mon" aria-hidden="true">${day.mon}</span>
        <span class="day__count" aria-hidden="true">${day.past ? '' : total ? `${total} ${eventsWord(total)}` : 'пусто'}</span>
        ${day.past ? '' : thumbsHtml(preview, total, 2, 'strip') + thumbsHtml(preview, total, 4, 'grid')}
      </button>`;
  }).join('');
  root.innerHTML = html;
}

/** Плавно прокрутить ленту к выбранной дате (только в режиме ленты). */
export function scrollToSelected(root, smooth = true) {
  const el = root.querySelector('.day--selected');
  if (!el || root.scrollWidth <= root.clientWidth) return;
  const target = el.offsetLeft - root.clientWidth / 2 + el.clientWidth / 2;
  root.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}
