// Фильтрация событий в памяти: дата, категория, поиск, «только бесплатные».

export const CATEGORIES = [
  { id: 'all', label: 'Все', icon: 'i-all' },
  { id: 'concerts', label: 'Концерты и звёзды', short: 'Концерты', icon: 'i-concerts' },
  { id: 'theater', label: 'Театр и балет', short: 'Театр', icon: 'i-theater' },
  { id: 'exhibitions', label: 'Выставки и музеи', short: 'Выставки', icon: 'i-exhibitions' },
  { id: 'events', label: 'Шоу, стендап и ивенты', short: 'Шоу', icon: 'i-events' },
];

export const categoryById = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/** Событие идёт в этот день: точная дата или внутри периода date…end_date. */
export function occursOn(ev, iso) {
  if (ev.end_date) return ev.date <= iso && iso <= ev.end_date;
  return ev.date === iso;
}

export function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'“”„]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Подготовить индекс для поиска один раз при загрузке. */
export function indexEvents(events) {
  for (const ev of events) {
    ev._search = normalize([ev.title, ev.venue, ev.address, ev.category_label].join(' '));
  }
  return events;
}

/** Фильтры без даты: категория, поиск, бесплатные. */
export function matchesBase(ev, { category = 'all', query = '', freeOnly = false } = {}) {
  if (category !== 'all' && ev.category !== category) return false;
  if (freeOnly && !ev.is_free) return false;
  if (query) {
    const words = normalize(query).split(' ').filter(Boolean);
    for (const w of words) if (!ev._search.includes(w)) return false;
  }
  return true;
}

export function filterEvents(events, state) {
  return events.filter((ev) => matchesBase(ev, state) && (!state.date || occursOn(ev, state.date)));
}

/** Разовые события по времени, затем длительные (выставки и т.п.). */
export function sortForDay(list) {
  const timed = [];
  const long = [];
  for (const ev of list) (ev.end_date ? long : timed).push(ev);
  timed.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title, 'ru'));
  long.sort((a, b) => (a.end_date || '').localeCompare(b.end_date || '') || a.title.localeCompare(b.title, 'ru'));
  return { timed, long };
}

/** Счётчики по категориям для выбранного дня (с учётом поиска и «бесплатно»). */
export function categoryCounts(events, state) {
  const counts = { all: 0 };
  for (const ev of events) {
    if (state.date && !occursOn(ev, state.date)) continue;
    if (!matchesBase(ev, { ...state, category: 'all' })) continue;
    counts.all += 1;
    counts[ev.category] = (counts[ev.category] || 0) + 1;
  }
  return counts;
}
