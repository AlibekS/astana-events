#!/usr/bin/env python3
"""
Сборщик афиши Астаны.

Собирает события из открытых источников, оставляет только г. Астана
и окно «сегодня … +14 дней» (ровно 15 дней), убирает дубли и сохраняет
результат в data/events.json + data/meta.json.

Защита от пустого коммита: если источники ничего не вернули или вернули
подозрительно мало событий по сравнению с прошлым запуском, существующий
events.json НЕ перезаписывается.

Запуск:  python scraper/parse_astana.py [--out data] [--max-pages 6] [--verbose]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

# Астана живёт в UTC+5 (единый часовой пояс Казахстана с 2024 года).
ASTANA_TZ = timezone(timedelta(hours=5))
WINDOW_DAYS = 15

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36 AstanaAfishaBot/1.0 (+github.io static digest)"
)

log = logging.getLogger("afisha")

# ---------------------------------------------------------------------------
# Категории
# ---------------------------------------------------------------------------
CATEGORY_LABELS = {
    "concerts": "Концерты и звёзды",
    "theater": "Театр и балет",
    "exhibitions": "Выставки и музеи",
    "events": "Шоу, стендап и ивенты",
}

# Ключевые слова в названии важнее рубрики источника.
TITLE_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("theater", ("балет", "спектакл", "опера ", "оперa", "мюзикл", "театр", "постановк", "щелкунчик", "драма")),
    ("exhibitions", ("выставк", "экспозици", "музей", "галере", "ожившие полотна", "арт-пространств")),
    ("events", ("стендап", "stand up", "stand-up", "standup", "квиз", "quiz", "шоу", "фестивал", "вечеринк", "киноужин", "киноужин")),
    ("concerts", ("концерт", "оркестр", "трибьют", "tribute", "сольник", "гастрол", "live", "dj ", "джаз", "jazz", "рок", "симфони", "вокал")),
]

SOURCE_CATEGORY_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("concerts", ("концерт",)),
    ("theater", ("театр", "спектакл", "мюзикл", "балет", "опер")),
    ("exhibitions", ("выставк", "музе", "ярмарк")),
]

# Рубрики sxodim, которые мы обходим (образование, конференции, туры — мимо).
SXODIM_LISTINGS = [
    "afisha",
    "events/kontserty",
    "events/teatr",
    "events/vystavki",
    "events/stand-up",
    "events/festivali",
    "events/vecherinki",
    "events/razvlecheniya",
    "events/besplatnye-sobytiya",
    "events/novogodnee",
    "events/sen-myuzikli",
    "events/dlya-detey",
    "events/sport",
    "events/kino",
    "events/igry",
]
SXODIM_SKIP_CATEGORIES = ("образован", "конференц", "форум", "экскурс", "тур", "курс", "тренинг")

# ---------------------------------------------------------------------------
# Гео-фильтр
# ---------------------------------------------------------------------------
GEO_STOP_WORDS = (
    "алматы", "almaty", "шымкент", "shymkent", "караганд", "karaganda", "актобе", "aktobe",
    "атырау", "atyrau", "павлодар", "pavlodar", "усть-каменогорск", "өскемен", "костанай",
    "kostanay", "тараз", "taraz", "кокшетау", "kokshetau", "актау", "aktau", "семей", "semey",
    "туркестан", "turkistan", "петропавловск", "уральск", "oral", "кызылорд", "талдыкорган",
    "экибастуз", "бурабай", "burabay", "щучинск", "боровое", "ташкент", "бишкек", "москв",
)
ASTANA_WORDS = ("астана", "astana", "нур-султан", "nur-sultan", "ақмола")

# ---------------------------------------------------------------------------
# Утилиты
# ---------------------------------------------------------------------------
MONTHS = {
    "январ": 1, "феврал": 2, "март": 3, "апрел": 4, "мая": 5, "май": 5, "июн": 6,
    "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12,
}
MONTH_RE = "|".join(MONTHS)
CARD_DATE_RE = re.compile(rf"(\d{{1,2}})\s+({MONTH_RE})\w*", re.I)
STREET_RE = re.compile(
    r"^\s*(ул\.?|улица|пр\.?|пр-т|проспект|бульвар|б-р|шоссе|переулок|пер\.?|мкр|микрорайон|"
    r"площадь|пл\.?|наб\.?|набережная|көшесі|даңғылы|трасса|жк|ж\.?м\.?|район|e\d+|а\d+|\d)",
    re.I,
)


def today_astana() -> date:
    return datetime.now(ASTANA_TZ).date()


def clean(text: str | None) -> str:
    if not text:
        return ""
    text = text.replace("​", "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def normalize_title(title: str) -> str:
    title = clean(title)
    title = re.sub(r"\s+(в|in)\s+(г\.\s*)?(Астане|Astana)\s*$", "", title, flags=re.I)
    return title.strip(" -–—")


def title_key(title: str) -> str:
    t = title.lower().replace("ё", "е")
    t = re.sub(r"[«»\"'“”„.,:;!?()\-–—]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def shorten(text: str, limit: int = 420) -> str:
    text = clean(text)
    if len(text) <= limit:
        return text
    sentences = re.split(r"(?<=[.!?…])\s+", text)
    out = ""
    for s in sentences:
        if len(out) + len(s) + 1 > limit:
            break
        out = f"{out} {s}".strip()
    return out or text[: limit - 1].rstrip() + "…"


def format_price(value: int) -> str:
    return f"{value:,}".replace(",", " ")


def parse_price(text: str | None) -> int | None:
    if not text:
        return None
    m = re.search(r"(\d[\d\s ]{0,9})", text)
    if not m:
        return None
    digits = re.sub(r"\D", "", m.group(1))
    return int(digits) if digits else None


def split_venue(street: str) -> tuple[str, str]:
    """«Казахконцерт», пр. Мангилик Ел, 10/1  ->  (venue, address)."""
    street = clean(street)
    parts = [p.strip() for p in street.split(",") if p.strip()]
    if not parts:
        return "", ""
    for i, part in enumerate(parts):
        if STREET_RE.match(part):
            if i == 0:
                return "", ", ".join(parts)
            return ", ".join(parts[:i]), ", ".join(parts[i:])
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], ", ".join(parts[1:])


def is_astana(*texts: str | None) -> bool:
    blob = " ".join(t.lower() for t in texts if t)
    return not any(w in blob for w in GEO_STOP_WORDS)


def categorize(title: str, source_category: str = "") -> str:
    t = f" {title.lower()} "
    for cat, words in TITLE_RULES:
        if any(w in t for w in words):
            return cat
    sc = source_category.lower()
    for cat, words in SOURCE_CATEGORY_RULES:
        if any(w in sc for w in words):
            return cat
    return "events"


def parse_iso(value: str | None) -> tuple[date | None, str | None]:
    """'2026-12-19T19:00:00+05:00' -> (date, '19:00'); '2026-01-01' -> (date, None)."""
    if not value:
        return None, None
    value = value.strip()
    try:
        if "T" in value:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo:
                dt = dt.astimezone(ASTANA_TZ)
            t = dt.strftime("%H:%M")
            return dt.date(), (None if t == "00:00" else t)
        return date.fromisoformat(value[:10]), None
    except ValueError:
        return None, None


# ---------------------------------------------------------------------------
# Модель
# ---------------------------------------------------------------------------
@dataclass
class Event:
    id: str
    title: str
    category: str
    date: str
    end_date: str | None
    time: str | None
    venue: str
    address: str
    price_from: int | None
    is_free: bool
    image_url: str | None
    image_large: str | None
    source_url: str
    ticket_url: str | None
    source_name: str
    short_description: str
    extra: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        if self.is_free:
            price_label = "Бесплатно"
        elif self.price_from:
            price_label = f"от {format_price(self.price_from)} ₸"
        else:
            price_label = None
        return {
            "id": self.id,
            "title": self.title,
            "category": self.category,
            "category_label": CATEGORY_LABELS[self.category],
            "date": self.date,
            "end_date": self.end_date,
            "time": self.time,
            "venue": self.venue,
            "address": self.address,
            "price_from": self.price_from,
            "price_label": price_label,
            "is_free": self.is_free,
            "image_url": self.image_url,
            "image_large": self.image_large,
            "source_url": self.source_url,
            "ticket_url": self.ticket_url or self.source_url,
            "source_name": self.source_name,
            "short_description": self.short_description,
        }


@dataclass
class Window:
    start: date
    end: date  # включительно

    def contains(self, d: date) -> bool:
        return self.start <= d <= self.end

    def overlaps(self, a: date, b: date) -> bool:
        return a <= self.end and b >= self.start


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def make_client() -> httpx.Client:
    return httpx.Client(
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6",
        },
        timeout=httpx.Timeout(25.0, connect=15.0),
        follow_redirects=True,
        limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
    )


def fetch(client: httpx.Client, url: str, retries: int = 3) -> str | None:
    for attempt in range(1, retries + 1):
        try:
            r = client.get(url)
            if r.status_code == 200:
                return r.text
            if r.status_code in (403, 404, 410):
                log.debug("HTTP %s %s", r.status_code, url)
                return None
            log.debug("HTTP %s %s (attempt %d)", r.status_code, url, attempt)
        except httpx.HTTPError as exc:
            log.debug("%s %s (attempt %d)", type(exc).__name__, url, attempt)
        time.sleep(1.5 * attempt)
    return None


def json_ld_blocks(soup: BeautifulSoup) -> Iterable[dict]:
    for tag in soup.find_all("script", type="application/ld+json"):
        raw = tag.string or tag.get_text() or ""
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        items = data if isinstance(data, list) else data.get("@graph", [data]) if isinstance(data, dict) else []
        for item in items:
            if isinstance(item, dict):
                yield item


# ---------------------------------------------------------------------------
# Источник: sxodim.com
# ---------------------------------------------------------------------------
SXODIM = "https://sxodim.com"


def sx_image_variant(url: str | None, size: str) -> str | None:
    if not url:
        return None
    url = urljoin(SXODIM, clean(url))
    return re.sub(r"_\d+x\d+-q-(\d+)\.(jpe?g|png|webp)$", rf"_{size}-q-\1.\2", url)


def card_dates_out_of_window(info: str, window: Window) -> bool:
    """True, если в карточке ровно одна дата и она точно вне окна (детали не качаем)."""
    found = CARD_DATE_RE.findall(info or "")
    if len(found) != 1 or "-" in info or "—" in info:
        return False
    day, mon = found[0]
    month = next(v for k, v in MONTHS.items() if mon.lower().startswith(k))
    # Год на карточке не пишется: выбираем ближайший к окну.
    candidates = []
    for y in (window.start.year - 1, window.start.year, window.start.year + 1):
        try:
            candidates.append(date(y, month, int(day)))
        except ValueError:
            pass
    return not any(window.contains(c) for c in candidates)


def sx_collect_cards(client: httpx.Client, window: Window, max_pages: int) -> dict[str, dict]:
    cards: dict[str, dict] = {}
    for listing in SXODIM_LISTINGS:
        for page in range(1, max_pages + 1):
            url = f"{SXODIM}/astana/{listing}" + (f"?page={page}" if page > 1 else "")
            html = fetch(client, url)
            if not html:
                break
            soup = BeautifulSoup(html, "lxml")
            new = 0
            page_cards = soup.select(".impression-card")
            for card in page_cards:
                link = card.select_one("a.impression-card-title") or card.select_one("a[href*='/astana/event/']")
                if not link or "/astana/event/" not in (link.get("href") or ""):
                    continue
                href = urljoin(SXODIM, link["href"]).split("?")[0]
                if href in cards:
                    continue
                category = clean(card.get("data-category"))
                if any(w in category.lower() for w in SXODIM_SKIP_CATEGORIES):
                    continue
                info = clean(card.select_one(".impression-card-info").get_text(" ") if card.select_one(".impression-card-info") else "")
                img = card.select_one("img")
                cards[href] = {
                    "url": href,
                    "id": card.get("data-id") or hashlib.md5(href.encode()).hexdigest()[:8],
                    "category": category,
                    "info": info,
                    "image": img.get("src") if img else None,
                    "listing": listing,
                    "skip": card_dates_out_of_window(info, window),
                }
                new += 1
            log.debug("%s p%d: +%d", listing, page, new)
            if not page_cards or not soup.select_one(f"a[href*='page={page + 1}']"):
                break
            time.sleep(0.4)
    return cards


def sx_parse_event(html: str, card: dict, window: Window) -> list[Event]:
    soup = BeautifulSoup(html, "lxml")
    ld_event: dict = {}
    breadcrumb_cat = ""
    for block in json_ld_blocks(soup):
        btype = block.get("@type")
        if btype == "Event" and not ld_event:
            ld_event = block
        elif btype == "BreadcrumbList":
            items = block.get("itemListElement") or []
            if len(items) >= 2:
                breadcrumb_cat = clean(items[1].get("name"))
    if not ld_event:
        return []

    title = normalize_title(ld_event.get("name") or card.get("title") or "")
    location = ld_event.get("location") or {}
    address_obj = location.get("address") or {}
    if isinstance(address_obj, str):
        address_obj = {"streetAddress": address_obj}
    locality = clean(address_obj.get("addressLocality"))
    street = clean(address_obj.get("streetAddress"))
    venue, address = split_venue(street)
    if not venue:
        venue = clean(location.get("name")) if clean(location.get("name")) != clean(ld_event.get("name")) else ""

    # Гео-фильтр: город и стоп-слова.
    if locality and not any(w in locality.lower() for w in ASTANA_WORDS):
        return []
    if not is_astana(street, title):
        return []

    source_cat = card.get("category") or breadcrumb_cat
    if any(w in source_cat.lower() for w in SXODIM_SKIP_CATEGORIES):
        return []
    category = categorize(title, source_cat)

    offers = ld_event.get("offers") or {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    price = offers.get("price")
    try:
        price = int(float(price)) if price not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    price_text = clean((soup.select_one(".event_date_block .str") or soup.select_one(".event_date_block")) and
                       (soup.select_one(".event_date_block .str") or soup.select_one(".event_date_block")).get_text(" "))
    if price is None:
        price = parse_price(price_text)
    is_free = (
        price == 0
        or "бесплат" in price_text.lower()
        or "тегін" in price_text.lower()
        or "besplatn" in card.get("listing", "")
    )
    if is_free:
        price = 0
    ticket_url = offers.get("url") or None
    if ticket_url and "sxodim.com" not in ticket_url and not ticket_url.startswith("http"):
        ticket_url = urljoin(SXODIM, ticket_url)

    images = ld_event.get("image") or []
    if isinstance(images, str):
        images = [images]
    base_img = card.get("image") or (images[0] if images else None)
    image_url = sx_image_variant(base_img, "760x427")
    image_large = sx_image_variant(images[0] if images else base_img, "1400x790")
    image_small = sx_image_variant(base_img, "352x198")

    description = shorten(ld_event.get("description") or "")
    start_d, start_t = parse_iso(ld_event.get("startDate"))
    end_d, _ = parse_iso(ld_event.get("endDate"))

    # Сеансы со страницы: data-date='19.12.2026 19:00:00'
    sessions: list[tuple[date, str | None]] = []
    for block in soup.select(".event_date_block[data-date]"):
        raw = clean(block.get("data-date"))
        try:
            dt = datetime.strptime(raw, "%d.%m.%Y %H:%M:%S")
        except ValueError:
            try:
                dt = datetime.strptime(raw, "%d.%m.%Y")
            except ValueError:
                continue
        t = dt.strftime("%H:%M")
        sessions.append((dt.date(), None if t == "00:00" else t))
    sessions = sorted(set(sessions))

    base = dict(
        title=title,
        category=category,
        venue=venue,
        address=address,
        price_from=price,
        is_free=is_free,
        image_url=image_url,
        image_large=image_large,
        source_url=card["url"],
        ticket_url=ticket_url,
        source_name="Sxodim",
        short_description=description,
        extra={"image_small": image_small, "image_thumb": sx_image_variant(base_img, "80x80")},
    )
    sid = f"sx_{card['id']}"
    out: list[Event] = []

    if len(sessions) > 1:
        by_day: dict[date, list[str]] = {}
        for d, t in sessions:
            if window.contains(d):
                by_day.setdefault(d, [])
                if t:
                    by_day[d].append(t)
        for d, times in sorted(by_day.items()):
            ev = Event(id=f"{sid}_{d:%Y%m%d}", date=d.isoformat(), end_date=None,
                       time=times[0] if times else None, **{**base, "extra": dict(base["extra"])})
            if len(times) > 1:
                ev.extra["times"] = times
            out.append(ev)
    elif start_d and end_d and end_d > start_d:
        if window.overlaps(start_d, end_d):
            out.append(Event(id=sid, date=start_d.isoformat(), end_date=end_d.isoformat(),
                             time=start_t, **base))
    else:
        d, t = (sessions[0] if sessions else (start_d, start_t))
        if d and window.contains(d):
            out.append(Event(id=sid, date=d.isoformat(), end_date=None, time=t or start_t, **base))
    return out


def source_sxodim(window: Window, max_pages: int, workers: int = 5) -> list[Event]:
    with make_client() as client:
        cards = sx_collect_cards(client, window, max_pages)
        todo = [c for c in cards.values() if not c["skip"]]
        log.info("sxodim: карточек %d, к загрузке %d", len(cards), len(todo))

        def work(card: dict) -> list[Event]:
            html = fetch(client, card["url"])
            if not html:
                return []
            try:
                return sx_parse_event(html, card, window)
            except Exception:  # noqa: BLE001 — одна битая страница не должна ронять сбор
                log.exception("sxodim: ошибка разбора %s", card["url"])
                return []

        events: list[Event] = []
        with cf.ThreadPoolExecutor(max_workers=workers) as pool:
            for result in pool.map(work, todo):
                events.extend(result)
    log.info("sxodim: событий в окне %d", len(events))
    return events


# ---------------------------------------------------------------------------
# Источник: ticketon.kz (часто закрыт Cloudflare — сбой не критичен)
# ---------------------------------------------------------------------------
TICKETON = "https://ticketon.kz"


def source_ticketon(window: Window, max_pages: int) -> list[Event]:
    events: list[Event] = []
    with make_client() as client:
        html = fetch(client, f"{TICKETON}/astana", retries=1)
        if not html or "Just a moment" in html[:2000]:
            log.warning("ticketon: недоступен (вероятно, защита Cloudflare) — пропускаю")
            return []
        soup = BeautifulSoup(html, "lxml")
        for block in json_ld_blocks(soup):
            if block.get("@type") not in ("Event", "MusicEvent", "TheaterEvent", "ExhibitionEvent", "ComedyEvent"):
                continue
            title = normalize_title(block.get("name") or "")
            loc = block.get("location") or {}
            addr = loc.get("address") or {}
            if isinstance(addr, str):
                addr = {"streetAddress": addr}
            street = clean(addr.get("streetAddress"))
            locality = clean(addr.get("addressLocality"))
            if locality and not any(w in locality.lower() for w in ASTANA_WORDS):
                continue
            if not is_astana(street, title):
                continue
            d, t = parse_iso(block.get("startDate"))
            e, _ = parse_iso(block.get("endDate"))
            if not d:
                continue
            if e and e > d:
                if not window.overlaps(d, e):
                    continue
            elif not window.contains(d):
                continue
            offers = block.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            price = parse_price(str(offers.get("lowPrice") or offers.get("price") or ""))
            url = urljoin(TICKETON, block.get("url") or "")
            img = block.get("image")
            img = img[0] if isinstance(img, list) and img else img
            events.append(Event(
                id="tk_" + hashlib.md5(f"{url}{d}{t}".encode()).hexdigest()[:10],
                title=title, category=categorize(title), date=d.isoformat(),
                end_date=e.isoformat() if e and e > d else None, time=t,
                venue=clean(loc.get("name")), address=street,
                price_from=price, is_free=price == 0, image_url=img, image_large=img,
                source_url=url, ticket_url=url, source_name="Ticketon",
                short_description=shorten(block.get("description") or ""),
            ))
    log.info("ticketon: событий в окне %d", len(events))
    return events


SOURCES = {
    "ticketon": source_ticketon,
    "sxodim": source_sxodim,
}

# ---------------------------------------------------------------------------
# Сборка
# ---------------------------------------------------------------------------
def dedupe(events: list[Event]) -> list[Event]:
    """Одинаковое название + дата + время = дубль. Ticketon приоритетнее (он первый)."""
    seen: dict[tuple, Event] = {}
    for ev in events:
        key = (title_key(ev.title), ev.date, ev.time or "")
        if key in seen:
            kept = seen[key]
            # дополним пустые поля
            for f in ("image_url", "image_large", "short_description", "venue", "address"):
                if not getattr(kept, f) and getattr(ev, f):
                    setattr(kept, f, getattr(ev, f))
            if kept.price_from is None and ev.price_from is not None:
                kept.price_from, kept.is_free = ev.price_from, ev.is_free
            continue
        seen[key] = ev
    return list(seen.values())


def build(window: Window, max_pages: int, only: list[str] | None = None) -> tuple[list[dict], dict]:
    all_events: list[Event] = []
    status: dict[str, dict] = {}
    for name, fn in SOURCES.items():
        if only and name not in only:
            continue
        started = time.time()
        try:
            got = fn(window, max_pages)
            status[name] = {"ok": bool(got), "count": len(got), "seconds": round(time.time() - started, 1)}
            all_events.extend(got)
        except Exception as exc:  # noqa: BLE001
            log.exception("источник %s упал", name)
            status[name] = {"ok": False, "count": 0, "error": type(exc).__name__}
    events = dedupe(all_events)
    events.sort(key=lambda e: (e.date, e.time or "99:99", e.title))
    out = []
    for e in events:
        j = e.to_json()
        for k in ("image_small", "image_thumb"):
            if e.extra.get(k):
                j[k] = e.extra[k]
        if e.extra.get("times"):
            j["times"] = e.extra["times"]
        out.append(j)
    return out, status


def content_hash(events: list[dict]) -> str:
    return hashlib.sha256(json.dumps(events, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--max-pages", type=int, default=12)
    ap.add_argument("--min-ratio", type=float, default=0.35,
                    help="не перезаписывать, если событий меньше этой доли от прошлого запуска")
    ap.add_argument("--only", nargs="*", help="запустить только указанные источники")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    today = today_astana()
    window = Window(today, today + timedelta(days=WINDOW_DAYS - 1))
    log.info("окно: %s … %s", window.start, window.end)

    events, status = build(window, args.max_pages, args.only)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    events_path = out_dir / "events.json"
    meta_path = out_dir / "meta.json"

    previous: list[dict] = []
    if events_path.exists():
        try:
            previous = json.loads(events_path.read_text("utf-8")).get("events", [])
        except (json.JSONDecodeError, OSError):
            previous = []

    now = datetime.now(ASTANA_TZ).replace(microsecond=0).isoformat()

    # Защита от пустого/обрезанного обновления.
    gh = os.environ.get("GITHUB_ACTIONS") == "true"
    if not events:
        log.error("источники не вернули ни одного события — events.json не трогаю")
        if gh:
            print("::warning::Источники не вернули событий — данные не обновлены")
        return 0
    prev_in_window = [e for e in previous if (e.get("end_date") or e["date"]) >= window.start.isoformat()]
    if len(prev_in_window) >= 10 and len(events) < len(prev_in_window) * args.min_ratio:
        log.error("подозрительно мало событий (%d против %d) — events.json не трогаю",
                  len(events), len(prev_in_window))
        if gh:
            print(f"::warning::Подозрительно мало событий ({len(events)} против {len(prev_in_window)}) — данные не обновлены")
        return 0

    if previous and content_hash(previous) == content_hash(events):
        log.info("события не изменились — файлы не перезаписываю")
        return 0

    payload = {"updated_at": now, "city": "Астана", "window": {"start": window.start.isoformat(),
               "end": window.end.isoformat()}, "events": events}
    events_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    meta = {"updated_at": now, "count": len(events), "sources": status,
            "window": payload["window"]}
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", "utf-8")
    log.info("сохранено событий: %d → %s", len(events), events_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
