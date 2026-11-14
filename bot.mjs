#!/usr/bin/env node
/*
 * Світло-бот: графік відключень і повідомлення ДТЕК за адресою -> Telegram-канал.
 *
 * Как работает (коротко):
 *   1. Открывает сайт ДТЕК в настоящем браузере Chrome и берёт оттуда:
 *        - график всех групп на сегодня/завтра;
 *        - данные по дому: группу и текущее отключение (причина, начало,
 *          ориентировочное время восстановления).
 *   2. Если сайт ДТЕК не ответил — берёт график из резервной копии
 *      (github.com/Baskerville42/outage-data-ua). Данных по дому в ней нет.
 *   3. Сравнивает с тем, что уже писал (файл state.json), и отправляет в канал
 *      только новое.
 *
 * Запускается раз в несколько минут (GitHub Actions). Настройки — в файле
 * запуска (.github/workflows/...) и в секретах репозитория.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIN = 60 * 1000;
const HALF = 30 * MIN;

// ───────────────────────── Время (всё считаем по Киеву) ─────────────────────────

function makeFormatter() {
  const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'Europe/Kyiv' });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'Europe/Kiev' });
  }
}
const DTF = makeFormatter();
export const TZ = DTF.resolvedOptions().timeZone;

/** Киевские дата и время для момента ms. */
export function kyiv(ms) {
  const p = {};
  for (const x of DTF.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute,
    date: `${p.year}-${p.month}-${p.day}`, // 2026-11-14
    hm: `${p.hour}:${p.minute}`,           // 18:05
    dm: `${p.day}.${p.month}`,             // 14.11
  };
}

/** Момент (ms) для киевских даты и времени. Часы 24 = полночь следующего дня. */
export function kyivEpoch(y, mo, d, h = 0, mi = 0) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const k = kyiv(t);
    t += want - Date.UTC(k.y, k.mo - 1, k.d, k.h, k.mi);
  }
  return t;
}

export function addDays(date, n) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export function dayStart(date) {
  const [y, mo, d] = date.split('-').map(Number);
  return kyivEpoch(y, mo, d, 0, 0);
}

/** ДТЕК пишет даты как "07:56 02.07.2025" (иногда наоборот: "02.07.2025 07:56"). */
export function parseDtekDate(s) {
  const str = String(s ?? '');
  let m = str.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return kyivEpoch(+m[5], +m[4], +m[3], +m[1], +m[2]);
  m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return kyivEpoch(+m[3], +m[2], +m[1], +m[4], +m[5]);
  return null;
}

// ───────────────────────── График группы ─────────────────────────
// На сайте ДТЕК час кодируется словом. Переводим в две буквы — по одной на
// каждые полчаса: Y = свет есть, N = света нет, M = возможно отключение.
const HOUR_CODES = { yes: 'YY', no: 'NN', first: 'NY', second: 'YN', maybe: 'MM', mfirst: 'MY', msecond: 'YM' };

/**
 * График группы по дням: { '2026-11-14': '48 букв Y/N/M/?' }.
 * fact — объект графика с сайта ДТЕК: fact.data[<полночь, unix-секунды>][<GPV2.1>][<час 1..24>].
 */
export function daySlots(fact, group) {
  const out = {};
  const data = fact && fact.data;
  if (!data || typeof data !== 'object') return out;
  for (const [key, groups] of Object.entries(data)) {
    const hours = groups && groups[group];
    let ts = Number(key);
    if (!hours || !Number.isFinite(ts)) continue;
    if (ts < 1e11) ts *= 1000; // секунды -> миллисекунды
    const date = kyiv(ts + 12 * 60 * MIN).date; // ключ — полночь по Киеву; +12 ч, чтобы не ошибиться с днём
    let s = '';
    for (let h = 1; h <= 24; h++) s += HOUR_CODES[hours[String(h)]] || '??';
    out[date] = s;
  }
  return out;
}

/** Склеенные интервалы нужного состояния ('N' — отключения) через все известные дни. */
export function intervals(days, kind = 'N') {
  const res = [];
  for (const date of Object.keys(days).sort()) {
    const [y, mo, d] = date.split('-').map(Number);
    const s = days[date];
    for (let i = 0; i < 48; i++) {
      if (s[i] !== kind) continue;
      const start = kyivEpoch(y, mo, d, Math.floor(i / 2), (i % 2) * 30);
      const end = kyivEpoch(y, mo, d, Math.floor((i + 1) / 2), ((i + 1) % 2) * 30);
      const last = res[res.length - 1];
      if (last && last.end === start) last.end = end;
      else res.push({ start, end });
    }
  }
  return res;
}

// ───────────────────────── Данные по дому ─────────────────────────

const LAT2CYR = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' };

/** "1а", "1-А", "1/А", "1 A" (латиницей) -> "1А". Дроби вроде "1/2" не трогаем. */
export function normHouse(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[A-Z]/g, (c) => LAT2CYR[c] || c)
    .replace(/\s+/g, '')
    .replace(/[\/\-.](?=[A-ZА-ЯІЇЄҐ])/g, '');
}

export function groupsOf(entry) {
  const r = entry && entry.sub_type_reason;
  const list = Array.isArray(r) ? r : r ? [r] : [];
  return list.map((x) => String(x).trim().toUpperCase()).filter((x) => /^GPV\d/.test(x));
}

function hasNotice(entry) {
  return !!entry && !!(String(entry.sub_type ?? '').trim() || String(entry.start_date ?? '').trim());
}

/** Ищет дом в ответе сайта (ключи там бывают "1А", "1/А" и т.п.). */
export function findHouse(data, house) {
  const want = normHouse(house);
  const hits = Object.entries(data || {}).filter(([k]) => normHouse(k) === want);
  if (!hits.length) return null;
  const [key, entry] = hits.find(([, v]) => hasNotice(v)) || hits[0];
  const groups = [...new Set(hits.flatMap(([, v]) => groupsOf(v)))];
  return { key, entry, groups };
}

/** Текущее отключение по дому или null. */
export function activeNotice(entry, now) {
  if (!hasNotice(entry)) return null;
  const n = {
    sub: String(entry.sub_type ?? '').trim(),
    start: String(entry.start_date ?? '').trim(),
    end: String(entry.end_date ?? '').trim(),
  };
  if (!n.sub) n.sub = String(entry.type ?? '') === '1' ? 'Планові ремонтні роботи' : 'Відключення';
  n.startMs = parseDtekDate(n.start);
  n.endMs = parseDtekDate(n.end);
  if (n.startMs && n.startMs > now + 5 * MIN) return null; // ещё не началось
  return n;
}

/** Сколько домов улицы с такой же причиной отключения. */
export function streetStats(data, sub) {
  let total = 0;
  let off = 0;
  for (const v of Object.values(data || {})) {
    total++;
    if (String((v && v.sub_type) ?? '').trim() === sub) off++;
  }
  return { total, off };
}

export function noticeKind(sub) {
  const s = String(sub || '').toLowerCase();
  if (s.includes('екстрен')) return { icon: '🚨', title: 'Екстрене відключення', emergency: true };
  if (s.includes('стабілізац')) return { icon: '🔴', title: 'Відключення за графіком', scheduled: true };
  if (s.includes('аварійн')) return { icon: '🔧', title: 'Аварійне відключення', emergency: true };
  if (s.includes('планов')) return { icon: '🛠', title: 'Планові ремонтні роботи' };
  if (s.includes('графік')) return { icon: '🔴', title: 'Відключення за графіком', scheduled: true };
  return { icon: '⚠️', title: 'Відключення' };
}

// ───────────────────────── Тексты сообщений ─────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hm = (ms) => kyiv(ms).hm;

/** Конец интервала: полночь показываем как 24:00. */
function hmEnd(ms) {
  const k = kyiv(ms);
  return k.h === 0 && k.mi === 0 ? '24:00' : k.hm;
}

export function hoursText(ms) {
  const h = Math.round(ms / HALF) / 2;
  let word = 'годин';
  if (!Number.isInteger(h)) word = 'години';
  else if (h % 10 === 1 && h % 100 !== 11) word = 'година';
  else if (h % 10 >= 2 && h % 10 <= 4 && (h % 100 < 12 || h % 100 > 14)) word = 'години';
  return `~${h} ${word}`;
}

export function durText(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(m / 60);
  return h ? `${h}год ${m % 60}хв` : `${m}хв`;
}

function intervalText(iv, today) {
  const sd = kyiv(iv.start).date;
  const prefix = sd === today ? '' : sd === addDays(today, 1) ? 'завтра ' : `${kyiv(iv.start).dm} `;
  return `${prefix}${hm(iv.start)} - ${hmEnd(iv.end)} (${hoursText(iv.end - iv.start)})`;
}

/** Время с датой, если это не сегодня: "07:09" или "07:09 15.11". */
function whenText(ms, today, raw) {
  if (!ms) return esc(raw || '—');
  const k = kyiv(ms);
  return k.date === today ? k.hm : `${k.hm} ${k.dm}`;
}

function nextOffLine(offs, now, today) {
  const cur = offs.find((iv) => iv.start <= now && now < iv.end);
  if (cur) return `🗓 За графіком зараз діє відключення до <b>${hmEnd(cur.end)}</b>`;
  const next = offs.find((iv) => iv.start > now);
  return next
    ? `🗓 Наступне вимкнення: <b>${intervalText(next, today)}</b>`
    : '🗓 Наступних відключень у графіку поки немає';
}

function helloText(cfg, glabel, addrOk) {
  const lines = [
    '✅ <b>Бот запущено</b>',
    `📍 ${esc(cfg.city)}, ${esc(cfg.street)}, ${esc(cfg.house)}`,
  ];
  if (glabel) lines.push(`👥 Група відключень: ${esc(glabel)}`);
  lines.push('ℹ️ Тут будуть графіки, попередження перед вимкненням і повідомлення ДТЕК про відключення за адресою.');
  if (!addrOk) lines.push('⚠️ Сайт ДТЕК зараз не відповів, тому поки працюю лише за графіком. Спробую ще раз за кілька хвилин.');
  return lines.join('\n');
}

function noticeOnText(n, now, today, stats) {
  const kind = noticeKind(n.sub);
  const lines = [`${kind.icon} <b>${hm(now)} ${kind.title}</b>`];
  if (!kind.scheduled) lines.push(esc(n.sub));
  if (kind.emergency && stats && stats.total >= 3 && stats.off >= 1) {
    lines.push(`🏘 Аварія на <b>${stats.off}</b> з ${stats.total} будинків вулиці`);
  }
  if (n.startMs && now - n.startMs > 10 * MIN) lines.push(`⏱ Початок: ${whenText(n.startMs, today)}`);
  if (n.end) lines.push(`🕓 Орієнтовне відновлення: <b>${whenText(n.endMs, today, n.end)}</b>`);
  return lines.join('\n');
}

function noticeEndChangedText(cur, prev, today) {
  const was = prev.end ? ` (було ${whenText(parseDtekDate(prev.end), today, prev.end)})` : '';
  return `🕓 <b>ДТЕК оновив час відновлення: ${whenText(cur.endMs, today, cur.end)}</b>${was}`;
}

function noticeOffText(prev, now, today, offs) {
  const startMs = parseDtekDate(prev.start) || prev.seen;
  const lines = [`✅ <b>${hm(now)} ДТЕК: відключення завершено</b>`];
  if (startMs && now > startMs) lines.push(`🕓 Тривало ${durText(now - startMs)}`);
  lines.push(nextOffLine(offs, now, today));
  return lines.join('\n');
}

function dayIntervals(date, sig, kind) {
  return intervals({ [date]: sig }, kind);
}

function scheduleText(change, date, label, sig, glabel) {
  const dm = kyiv(dayStart(date) + 12 * 60 * MIN).dm;
  const offs = dayIntervals(date, sig, 'N');
  const maybe = dayIntervals(date, sig, 'M');
  const tail = glabel ? ` · група ${esc(glabel)}` : '';
  if (!offs.length && !maybe.length) {
    return `✅ <b>На ${label}, ${dm}, відключень за графіком немає</b>${tail}`;
  }
  const head = change === 'changed' ? `🔄 <b>Графік на ${label} змінено, ${dm}</b>` : `🗓 <b>Графік на ${label}, ${dm}</b>`;
  const lines = [head + tail];
  for (const iv of offs) lines.push(`🔴 ${hm(iv.start)} - ${hmEnd(iv.end)} (${hoursText(iv.end - iv.start)})`);
  for (const iv of maybe) lines.push(`🟡 ${hm(iv.start)} - ${hmEnd(iv.end)} можливе відключення`);
  return lines.join('\n');
}

function warnText(iv, now, today) {
  const mins = Math.max(1, Math.round((iv.start - now) / MIN));
  return [
    `⏳ <b>${hm(now)} Планове відключення за ${mins} хв</b>`,
    `🗓 Вимкнення: <b>${intervalText(iv, today)}</b>`,
  ].join('\n');
}

// ───────────────────────── Что написать в канал ─────────────────────────

// ───────────────────────── Итоги и закреплённое сообщение ─────────────────────────

export function durLong(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  if (!h) return `${m} хв`;
  return m % 60 ? `${h} год ${m % 60} хв` : `${h} год`;
}

function isMonday(date) {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === 1;
}

function summaryRecord(date, sig, st) {
  const offs = sig ? dayIntervals(date, sig, 'N') : [];
  const offMin = offs.reduce((a, iv) => a + (iv.end - iv.start) / MIN, 0);
  return { date, sched: !!sig, offMin: Math.round(offMin), offN: offs.length, n: st.n || 0, min: st.min || 0 };
}

function summaryText(r) {
  const dm = kyiv(dayStart(r.date) + 12 * 60 * MIN).dm;
  const lines = [`📊 <b>Підсумок за ${dm}</b>`];
  if (r.sched) {
    lines.push(r.offMin ? `🔴 За графіком без світла: <b>${durLong(r.offMin)}</b> (${r.offN} відкл.)` : '🟢 За графіком відключень не було');
  }
  if (r.n) lines.push(`⚡ Відключень за даними ДТЕК: ${r.n}${r.min ? `, разом ${durLong(r.min)}` : ''}`);
  return lines.join('\n');
}

function weekText(week) {
  const off = week.reduce((a, h) => a + h.offMin, 0);
  const n = week.reduce((a, h) => a + h.n, 0);
  const min = week.reduce((a, h) => a + h.min, 0);
  const lines = [`📅 <b>За тиждень</b> (${week.length} дн.)`, `🔴 За графіком без світла: <b>${durLong(off)}</b>, в середньому ${durLong(off / week.length)} на день`];
  if (n) lines.push(`⚡ Відключень за даними ДТЕК: ${n}${min ? `, разом ${durLong(min)}` : ''}`);
  return lines.join('\n');
}

/** Текст закреплённого сообщения «Зараз» (без строки времени проверки). */
export function statusBody(state, input, now, cfg, plan) {
  const today = kyiv(now).date;
  const glabel = (plan.group || '').replace(/^GPV/i, '');
  const lines = [`📍 <b>${esc(cfg.street.replace(/^вул\.\s*/i, ''))}, ${esc(cfg.house)}</b>${glabel ? ` · група ${esc(glabel)}` : ''}`];
  if (input.fact && plan.days[today]) {
    const cur = plan.offs.find((iv) => iv.start <= now && now < iv.end);
    const maybe = intervals(plan.days, 'M').find((iv) => iv.start <= now && now < iv.end);
    if (cur) lines.push(`🔴 Зараз за графіком: відключення до <b>${hmEnd(cur.end)}</b>`);
    else if (maybe) lines.push(`🟡 Зараз за графіком: можливе відключення до ${hmEnd(maybe.end)}`);
    else lines.push('🟢 Зараз за графіком: світло є');
    const next = plan.offs.find((iv) => iv.start > now);
    lines.push(next ? `🗓 Наступне вимкнення: <b>${intervalText(next, today)}</b>` : '🗓 Наступних відключень у графіку немає');
  } else {
    lines.push('🗓 Графік зараз недоступний');
  }
  const n = state.notice;
  if (n) {
    const kind = noticeKind(n.sub);
    const end = n.end ? ` до ${whenText(parseDtekDate(n.end), today, n.end)}` : '';
    lines.push(`${kind.icon} ДТЕК: ${kind.title.toLowerCase()}${end}${input.addr && input.addr.ok ? '' : ' (останні дані)'}`);
  } else if (input.addr && input.addr.ok) {
    lines.push('✅ ДТЕК по будинку: відключень немає');
  }
  return lines.join('\n');
}

export function isNight(now, cfg) {
  const h = kyiv(now).h;
  return cfg.quietFrom > cfg.quietTo ? h >= cfg.quietFrom || h < cfg.quietTo : h >= cfg.quietFrom && h < cfg.quietTo;
}

function isoWeek(ms) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - y0) / 86400000 + 1) / 7)}`;
}

/**
 * Главная логика. Ничего не отправляет и не меняет state сама:
 * возвращает список шагов { text, apply }. Сначала отправляем text (если есть),
 * потом вызываем apply(state) — так сообщение не потеряется и не задвоится.
 *
 * input.addr: { ok, entry, groups, stats } — данные по дому с сайта ДТЕК (или { ok:false }).
 * input.fact: график всех групп (с сайта ДТЕК или из резервной копии) либо null.
 */
export function decide(state, input, now, cfg) {
  const acts = [];
  const w = structuredClone(state);
  const act = (text, apply, opts = {}) => {
    apply(w);
    acts.push({ text, apply, ...opts });
  };

  const today = kyiv(now).date;
  const tomorrow = addDays(today, 1);
  const addr = input.addr && input.addr.ok ? input.addr : null;
  const firstRun = !w.hello;

  // Группа: что говорит сайт по дому -> что запомнили раньше -> что задано в настройках.
  const groupBefore = w.group || cfg.group || '';
  let group = groupBefore;
  if (addr && addr.groups.length && !addr.groups.includes(group)) group = addr.groups[0];
  const glabel = group.replace(/^GPV/i, '');

  if (firstRun) {
    act(helloText(cfg, glabel, !!addr), (s) => {
      s.hello = true;
      s.addrOk = !!addr;
      if (addr && group) s.group = group;
    });
  } else if (addr && w.addrOk === false) {
    // при первом запуске сайт не ответил, а теперь ответил — сообщаем один раз
    act(`🔌 <b>Дані ДТЕК по будинку підключено</b>${glabel ? `\n👥 Група відключень: ${esc(glabel)}` : ''}`, (s) => {
      s.addrOk = true;
      if (group) s.group = group;
      if (group !== groupBefore) {
        s.sched = {};
        s.warned = [];
      }
    });
  } else if (group !== groupBefore && groupBefore) {
    // сайт показал другую группу, чем была раньше: сообщаем и публикуем график заново
    act(`ℹ️ <b>Група відключень будинку за даними ДТЕК: ${esc(glabel)}</b> (раніше ${esc(groupBefore.replace(/^GPV/i, ''))})`, (s) => {
      s.group = group;
      s.sched = {};
      s.warned = [];
    });
  } else if (addr && group && w.group !== group) {
    act(null, (s) => {
      s.group = group;
    });
  }

  const days = input.fact && group ? daySlots(input.fact, group) : {};
  const offs = intervals(days, 'N');

  // 1) Отключение по дому (по данным ДТЕК)
  if (addr) {
    const cur = activeNotice(addr.entry, now);
    const prev = w.notice || null;
    // то же самое отключение, если причина та же, а начало совпадает (или сдвинулось меньше чем на полчаса)
    const same = !!(cur && prev && prev.sub === cur.sub
      && (prev.start === cur.start || Math.abs((parseDtekDate(prev.start) || 0) - (cur.startMs || 1e15)) <= HALF));
    if (cur && !same) {
      act(noticeOnText(cur, now, today, addr.stats), (s) => {
        s.notice = { sub: cur.sub, start: cur.start, end: cur.end, seen: now };
        const d = kyiv(cur.startMs || now).date;
        s.stats = s.stats || {};
        s.stats[d] = s.stats[d] || { n: 0, min: 0 };
        s.stats[d].n++;
      }, { loud: !!noticeKind(cur.sub).emergency });
    } else if (cur && prev && prev.end !== cur.end) {
      act(cur.end ? noticeEndChangedText(cur, prev, today) : null, (s) => {
        s.notice.end = cur.end;
      });
    } else if (!cur && prev) {
      act(noticeOffText(prev, now, today, offs), (s) => {
        const startMs = parseDtekDate(prev.start) || prev.seen || now;
        const d = kyiv(startMs).date;
        s.stats = s.stats || {};
        s.stats[d] = s.stats[d] || { n: 1, min: 0 };
        s.stats[d].min += Math.max(0, Math.round((now - startMs) / MIN));
        s.notice = null;
      });
    }
  }

  // 2) График на сегодня и завтра: пишем, когда появился или изменился
  for (const [date, label] of [[today, 'сьогодні'], [tomorrow, 'завтра']]) {
    const sig = days[date];
    if (!sig) continue;
    const stored = w.sched && w.sched[date];
    let change = null;
    if (stored == null) {
      change = 'new';
    } else {
      // у сегодняшнего дня сравниваем только то, что ещё впереди
      const from = date === today ? Math.min(47, Math.max(0, Math.floor((now - dayStart(date)) / HALF))) : 0;
      if (sig.slice(from) !== stored.slice(from)) change = 'changed';
    }
    if (!change) continue;
    const hasOff = /[NM]/.test(sig);
    const calmBefore = !Object.values(w.sched || {}).some((x) => /[NM]/.test(x));
    const silent = change === 'new' && !hasOff && calmBefore && !firstRun; // в спокойные дни не шумим
    act(silent ? null : scheduleText(change, date, label, sig, glabel), (s) => {
      s.sched = s.sched || {};
      s.sched[date] = sig;
    });
  }

  // 3) Предупреждение перед плановым отключением
  const next = offs.find((iv) => iv.start > now);
  if (next && next.start - now <= cfg.warnMin * MIN && !(w.warned || []).includes(next.start)) {
    act(warnText(next, now, today), (s) => {
      s.warned = s.warned || [];
      s.warned.push(next.start);
    });
  }

  // 4) Утренний итог за вчера (и за неделю по понедельникам)
  const yesterday = addDays(today, -1);
  if (w.summaryFor !== yesterday && kyiv(now).h >= cfg.summaryHour) {
    const sig = w.sched && w.sched[yesterday];
    const st = (w.stats && w.stats[yesterday]) || { n: 0, min: 0 };
    const rec = sig || st.n ? summaryRecord(yesterday, sig, st) : null;
    const hist = [...(w.hist || []).filter((h) => h.date !== yesterday), ...(rec ? [rec] : [])].slice(-14);
    let text = rec && !firstRun ? summaryText(rec) : null;
    if (text && isMonday(today)) {
      const week = hist.filter((h) => h.date >= addDays(today, -7));
      if (week.length >= 3) text += '\n\n' + weekText(week);
    }
    act(text, (s) => {
      s.summaryFor = yesterday;
      s.hist = hist;
    });
  }

  // 5) Уборка в state
  const oldDays = Object.keys(w.sched || {}).filter((d) => d < yesterday);
  const oldStats = Object.keys(w.stats || {}).filter((d) => d < addDays(today, -2));
  const oldWarned = (w.warned || []).filter((t) => t < now - 24 * 60 * MIN);
  if (oldDays.length || oldWarned.length || oldStats.length) {
    act(null, (s) => {
      for (const d of Object.keys(s.sched || {})) if (d < yesterday) delete s.sched[d];
      for (const d of Object.keys(s.stats || {})) if (d < addDays(today, -2)) delete s.stats[d];
      s.warned = (s.warned || []).filter((t) => t >= now - 24 * 60 * MIN);
    });
  }
  const week = isoWeek(now);
  if (w.week !== week) {
    act(null, (s) => {
      s.week = week; // раз в неделю меняем файл, чтобы GitHub не усыпил расписание
    });
  }

  return { acts, group, days, offs, today, tomorrow };
}

// ───────────────────────── Сайт ДТЕК (в браузере Chrome) ─────────────────────────

/* Этот код выполняется ВНУТРИ открытой страницы ДТЕК. */
const IN_PAGE = async ({ city, street }) => {
  const out = { ok: false, diag: {} };
  // eslint-disable-next-line no-undef
  const ds = typeof DisconSchedule !== 'undefined' ? DisconSchedule : null;
  const meta = (name) => {
    const el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute('content') || '' : '';
  };
  // Защитный токен формы: обычно лежит в meta-тегах страницы; на всякий случай смотрим и в запасных местах.
  let token = meta('csrf-token');
  let param = meta('csrf-param');
  try {
    // eslint-disable-next-line no-undef
    if (!token && typeof yii !== 'undefined' && yii.getCsrfToken) token = yii.getCsrfToken() || '';
    // eslint-disable-next-line no-undef
    if (!param && typeof yii !== 'undefined' && yii.getCsrfParam) param = yii.getCsrfParam() || '';
  } catch (e) { /* не страшно */ }
  if (!token) {
    const input = document.querySelector('input[type="hidden"][name^="_csrf"]');
    if (input) {
      token = input.value || '';
      param = param || input.name;
    }
  }
  const ajaxUrl = meta('ajaxUrl') || '/ua/ajax';
  out.diag.title = document.title;
  out.diag.hasSchedule = !!ds;
  out.diag.hasToken = !!token;
  out.diag.browser = navigator.userAgent;
  out.diag.frames = document.querySelectorAll('iframe').length;
  out.fact = (ds && ds.fact) || null;

  const post = async (fields) => {
    const body = new URLSearchParams();
    for (const [k, v] of fields) body.append(k, v);
    if (param && token) body.append(param, token);
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    };
    if (token) headers['X-CSRF-Token'] = token;
    try {
      const r = await fetch(ajaxUrl, { method: 'POST', credentials: 'same-origin', headers, body: body.toString() });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = null;
      }
      return { status: r.status, json, head: json ? '' : text.replace(/\s+/g, ' ').slice(0, 200) };
    } catch (e) {
      return { status: 0, json: null, head: 'fetch error: ' + String(e) };
    }
  };

  const tried = [];
  const ask = async (c, s) => {
    const r = await post([
      ['method', 'getHomeNum'],
      ['data[0][name]', 'city'], ['data[0][value]', c],
      ['data[1][name]', 'street'], ['data[1][value]', s],
      ['data[2][name]', 'updateFact'], ['data[2][value]', (ds && ds.fact && ds.fact.update) || ''],
    ]);
    tried.push({ city: c, street: s, status: r.status, result: r.json ? r.json.result : null, head: r.head });
    return r;
  };
  const good = (r) => !!(r.json && r.json.result !== false && r.json.data && typeof r.json.data === 'object' && Object.keys(r.json.data).length);

  // Названия сравниваем без "м.", "вул." и знаков — на случай, если ДТЕК пишет чуть иначе.
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/^\s*(м|с|смт|сел|с-ще|вул|вулиця|просп|пров|бульв|пл|шосе|туп|узв|наб)\.?\s+/u, '')
    .replace(/[^a-zа-яіїєґ0-9]/gu, '');
  const pick = (list, want) => {
    const w = norm(want);
    if (!w || !Array.isArray(list)) return null;
    return list.find((x) => x === want)
      || list.find((x) => norm(x) === w)
      || list.find((x) => w.length >= 5 && (norm(x).startsWith(w) || (norm(x).length >= 5 && w.startsWith(norm(x)))))
      || null;
  };

  let cityUsed = city;
  let streetUsed = street;
  let r = await ask(city, street);

  if (!good(r)) {
    // Не нашли с первого раза — ищем, как именно ДТЕК называет город и улицу.
    let c2 = city;
    let list = null;
    const embedded = ds && ds.streets;
    if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
      c2 = pick(Object.keys(embedded), city) || city;
      list = embedded[c2];
    }
    if (!Array.isArray(list)) {
      const rs = await post([['method', 'getStreets'], ['data[0][name]', 'city'], ['data[0][value]', c2]]);
      const st = rs.json && rs.json.streets;
      if (Array.isArray(st)) {
        list = st;
      } else if (st && typeof st === 'object') {
        const k = pick(Object.keys(st), c2);
        if (k) {
          c2 = k;
          list = st[k];
        }
      }
    }
    const s2 = pick(list, street);
    out.diag.cityGuess = c2;
    out.diag.streetGuess = s2;
    out.diag.streetsKnown = Array.isArray(list) ? list.length : 0;
    if (s2 && (s2 !== street || c2 !== city)) {
      r = await ask(c2, s2);
      cityUsed = c2;
      streetUsed = s2;
    }
  }

  out.diag.tried = tried;
  if (good(r)) {
    out.ok = true;
    out.home = r.json;
    out.cityUsed = cityUsed;
    out.streetUsed = streetUsed;
    if (r.json.fact && r.json.fact.data) out.fact = r.json.fact; // более свежий график, если сайт его прислал
  }
  return out;
};

async function launchChrome(chromium) {
  // Если есть экран (в GitHub его даёт команда xvfb-run) — открываем обычный Chrome с окном,
  // как у человека. Если экрана нет — работаем без окна.
  const base = { headless: !process.env.DISPLAY, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  const tries = [{ channel: 'chrome' }];
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
    if (fs.existsSync(p)) tries.push({ executablePath: p });
  }
  tries.push({});
  let last;
  for (const t of tries) {
    try {
      return await chromium.launch({ ...base, ...t });
    } catch (e) {
      last = e;
    }
  }
  throw new Error('не удалось запустить браузер Chrome: ' + String((last && last.message) || last).split('\n')[0]);
}

/** Открывает страницу ДТЕК и возвращает { ok, home, fact, cityUsed, streetUsed, diag }. */
export async function scrapeDtek(cfg, hooks = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return { ok: false, error: 'не установлен playwright-core (шаг "npm install" в файле запуска)' };
  }
  let browser;
  let killer;
  let timedOut = false;
  const t0 = Date.now();
  try {
    browser = await launchChrome(chromium);
    // страховка: если сайт завис, через 2 минуты закрываем браузер и идём дальше
    killer = setTimeout(() => {
      timedOut = true;
      browser.close().catch(() => {});
    }, hooks.totalMs || 120000);
    const ctx = await browser.newContext({ locale: 'uk-UA', timezoneId: TZ, viewport: { width: 1366, height: 800 } });
    const page = await ctx.newPage();
    if (hooks.beforeGoto) await hooks.beforeGoto(page);
    const resp = await page.goto(cfg.dtekUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Ждём, пока страница реально загрузится (защита сайта может сначала показать проверку).
    await page
      // eslint-disable-next-line no-undef
      .waitForFunction(() => typeof DisconSchedule !== 'undefined' && document.readyState !== 'loading', null, { timeout: hooks.waitMs || 40000 })
      .catch(() => {});
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await page.evaluate(IN_PAGE, { city: cfg.city, street: cfg.street });
        break;
      } catch (e) {
        if (attempt >= 2) throw e; // страница перезагрузилась посреди запроса — пробуем один раз ещё
        await page.waitForTimeout(3000);
      }
    }
    res.httpStatus = resp ? resp.status() : 0;
    res.ms = Date.now() - t0;
    if (!res.ok && !res.diag.hasSchedule) {
      res.diag.pageText = await page
        .evaluate(() => (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 200))
        .catch(() => '');
    }
    return res;
  } catch (e) {
    const error = timedOut ? 'сайт ДТЕК не ответил за отведённое время' : String((e && e.message) || e).split('\n')[0];
    return { ok: false, error, ms: Date.now() - t0 };
  } finally {
    clearTimeout(killer);
    if (browser) await browser.close().catch(() => {});
  }
}

// ───────────────────────── Резервный источник графика ─────────────────────────

export async function fetchMirror(url) {
  const r = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !j.fact || !j.fact.data) throw new Error('в файле нет графика (fact.data)');
  return j.fact;
}

// ───────────────────────── Telegram ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normChat(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/t\.me\//i, '').replace(/^t\.me\//i, '').replace(/\/+$/, '');
  if (/^-?\d+$/.test(s)) return s;
  return s.startsWith('@') ? s : `@${s}`;
}

function explainTelegramError(status, description) {
  const d = String(description || '').toLowerCase();
  if (status === 401 || status === 404) return 'Telegram не принял токен бота. Проверь секрет TG_TOKEN: скопируй токен из @BotFather заново, целиком.';
  if (d.includes('chat not found')) return 'Telegram не нашёл канал. Проверь секрет TG_CHAT (например @moy_kanal) и что бот добавлен в канал администратором.';
  if (status === 403 || d.includes('not enough rights') || d.includes('need administrator')) return 'У бота нет прав писать в канал. Добавь бота в администраторы канала с правом публиковать сообщения.';
  return `Telegram ответил ошибкой ${status}: ${description || 'без описания'}`;
}

async function tg(cfg, method, payload) {
  for (let attempt = 1; ; attempt++) {
    let r;
    let j = {};
    try {
      r = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      j = await r.json().catch(() => ({}));
    } catch {
      if (attempt < 3) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error('Не удалось связаться с Telegram (сеть). Попробую при следующем запуске.');
    }
    if (j.ok) return j.result;
    if (r.status === 429 && attempt < 3) {
      await sleep((Number(j.parameters && j.parameters.retry_after) || 3) * 1000 + 500);
      continue;
    }
    if (r.status >= 500 && attempt < 3) {
      await sleep(2000 * attempt);
      continue;
    }
    const err = new Error(explainTelegramError(r.status, j.description));
    err.tgDesc = String(j.description || '');
    err.tgStatus = r.status;
    throw err;
  }
}

/** Если TG_CHAT не задан — находим канал сами: это последний канал, где бот получил пост/права. */
async function discoverChat(cfg) {
  const ups = await tg(cfg, 'getUpdates', { timeout: 0, allowed_updates: ['channel_post', 'my_chat_member', 'message'] });
  const chats = (ups || []).map((u) => (u.channel_post || u.my_chat_member || u.message || {}).chat).filter(Boolean).reverse();
  const hit = chats.find((c) => c.type === 'channel') || chats.find((c) => c.type === 'supergroup' || c.type === 'group');
  if (!hit) {
    throw new Error('Не знаю, в какой канал писать. Добавь секрет TG_CHAT (например @moy_kanal). '
      + 'Или: сделай бота администратором канала, напиши в канал любое сообщение и запусти ещё раз.');
  }
  return { id: String(hit.id), title: hit.title || '' };
}

/** Создаёт/обновляет закреплённое сообщение. Правит его, только если что-то поменялось или прошло 30 минут. */
async function updatePinned(cfg, state, chat, body, now) {
  const pin = state.pin || {};
  const fresh = pin.body === body && now - (pin.at || 0) < 30 * MIN;
  if (fresh && pin.id) return;
  const text = `${body}\n🔄 Перевірено о ${hm(now)}`;
  if (cfg.dryRun) {
    console.log('\n----- закреплённое -----\n' + text + '\n------------------------');
    state.pin = { id: pin.id || 1, body, at: now };
    return;
  }
  if (!chat) return;
  if (pin.id) {
    try {
      await tg(cfg, 'editMessageText', { chat_id: chat, message_id: pin.id, text, parse_mode: 'HTML', disable_web_page_preview: true });
      state.pin = { id: pin.id, body, at: now };
      return;
    } catch (e) {
      if (/not modified/i.test(e.tgDesc || '')) {
        state.pin = { id: pin.id, body, at: now };
        return;
      }
      if (!/not found|can't be edited|message_id_invalid/i.test(e.tgDesc || '')) throw e;
      // сообщение удалили — создаём новое
    }
  }
  const m = await tg(cfg, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: true });
  state.pin = { id: m.message_id, body, at: now };
  try {
    await tg(cfg, 'pinChatMessage', { chat_id: chat, message_id: m.message_id, disable_notification: true });
  } catch (e) {
    console.log(`::warning::Не получилось закрепить сообщение (дай боту право редактировать/закреплять): ${e.message}`);
  }
}

// ───────────────────────── Запуск ─────────────────────────

const log = (...a) => console.log('[svitlo]', ...a);

export function readConfig(env = process.env) {
  const group = String(env.GROUP || '').trim().toUpperCase().replace(/^GPV/, '');
  return {
    token: String(env.TG_TOKEN || '').trim(),
    chat: normChat(env.TG_CHAT),
    city: String(env.CITY || 'м. Вишневе').trim(),
    street: String(env.STREET || 'вул. Вітянська').trim(),
    house: String(env.HOUSE || '1А').trim(),
    group: group ? `GPV${group}` : '',
    warnMin: Number(env.WARN_MIN) > 0 ? Number(env.WARN_MIN) : 30,
    // тихие часы: сообщения без звука (аварии — со звуком). QUIET="0" выключает
    quietFrom: env.QUIET === '0' ? 0 : Number.isFinite(Number(env.QUIET_FROM)) && env.QUIET_FROM !== undefined && env.QUIET_FROM !== '' ? Number(env.QUIET_FROM) : 23,
    quietTo: env.QUIET === '0' ? 0 : Number.isFinite(Number(env.QUIET_TO)) && env.QUIET_TO !== undefined && env.QUIET_TO !== '' ? Number(env.QUIET_TO) : 7,
    summaryHour: Number.isFinite(Number(env.SUMMARY_HOUR)) && env.SUMMARY_HOUR ? Number(env.SUMMARY_HOUR) : 7,
    pin: env.PIN !== '0',
    dtekUrl: env.DTEK_URL || 'https://www.dtek-krem.com.ua/ua/shutdowns',
    mirrorUrl: env.MIRROR_URL || 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json',
    stateFile: env.STATE_FILE || 'state.json',
    dryRun: env.DRY_RUN === '1',
  };
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    if (e.code !== 'ENOENT') log('state.json не читается, начинаю с чистого листа:', e.message);
    return {};
  }
}

function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function describeDay(sig, date) {
  if (!sig) return 'нет данных';
  const offs = dayIntervals(date, sig, 'N').map((iv) => `${hm(iv.start)}-${hmEnd(iv.end)}`);
  return offs.length ? offs.join(', ') : 'без отключений';
}

export async function main(env = process.env, deps = {}) {
  const scrape = deps.scrape || scrapeDtek;
  const mirror = deps.mirror || fetchMirror;
  const cfg = readConfig(env);
  const state = loadState(cfg.stateFile);
  const now = deps.now || Date.now();
  const k = kyiv(now);
  log(`Время по Киеву: ${k.dm} ${k.hm}. Адрес: ${cfg.city}, ${cfg.street}, ${cfg.house}`);

  if (!cfg.token && !cfg.dryRun) {
    throw new Error('Нет токена бота. Добавь секрет TG_TOKEN: Settings → Secrets and variables → Actions → New repository secret.');
  }

  // 1. Сайт ДТЕК: график + данные по дому
  let addr = { ok: false };
  let fact = null;
  let source = '';
  const site = await scrape(cfg);
  if (site.fact && site.fact.data) {
    fact = site.fact;
    source = 'сайт ДТЕК';
  }
  if (site.ok) {
    const found = findHouse(site.home.data, cfg.house);
    if (found) {
      const cur = activeNotice(found.entry, now);
      addr = { ok: true, entry: found.entry, groups: found.groups, stats: cur ? streetStats(site.home.data, cur.sub) : null };
      log(`ДТЕК: дом найден (${site.cityUsed}, ${site.streetUsed}, ${found.key}), группа: ${found.groups.join(', ') || 'не указана'}`);
      log(cur ? `ДТЕК по дому: ОТКЛЮЧЕНИЕ — ${cur.sub}; начало ${cur.start || '?'}; восстановление ${cur.end || '?'}` : 'ДТЕК по дому: отключений нет');
    } else {
      const keys = Object.keys(site.home.data);
      console.log(`::warning::На улице "${site.streetUsed}" сайт ДТЕК не показал дом "${cfg.house}". Есть дома: ${keys.slice(0, 40).join(', ')}`);
    }
  } else {
    console.log(`::warning::Сайт ДТЕК не отдал данные по дому (${site.error || 'страница не загрузилась как надо'}). Работаю по графику.`);
    log('Диагностика:', JSON.stringify({ http: site.httpStatus, ms: site.ms, ...(site.diag || {}) }));
  }

  // 2. Резервный график — если с сайта его взять не удалось или в нём нет сегодняшнего дня
  const groupGuess = (addr.ok && addr.groups[0]) || state.group || cfg.group;
  const hasToday = (f) => !!(f && groupGuess && daySlots(f, groupGuess)[k.date]);
  if (!hasToday(fact)) {
    try {
      const copy = await mirror(cfg.mirrorUrl);
      if (!fact || hasToday(copy)) {
        fact = copy;
        source = 'резервная копия';
      }
    } catch (e) {
      if (!fact) console.log(`::warning::Резервный график тоже недоступен: ${e.message}`);
    }
  }

  // 3. Решаем, что писать
  const plan = decide(state, { addr, fact }, now, cfg);
  if (fact) {
    log(`График (${source}, обновлён ${fact.update || '?'}), группа ${plan.group || '?'}: `
      + `сегодня — ${describeDay(plan.days[plan.today], plan.today)}; завтра — ${describeDay(plan.days[plan.tomorrow], plan.tomorrow)}`);
  }

  // 4. Отправляем
  let chat = cfg.chat || state.chat || '';
  let sent = 0;
  for (const a of plan.acts) {
    if (a.text) {
      if (cfg.dryRun) {
        console.log('\n----- сообщение -----\n' + a.text + '\n---------------------');
      } else {
        if (!chat) {
          const found = await discoverChat(cfg);
          chat = found.id;
          state.chat = chat;
          log(`Канал найден автоматически: ${found.title}`);
        }
        const quiet = isNight(now, cfg) && !a.loud;
        await tg(cfg, 'sendMessage', { chat_id: chat, text: a.text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: quiet });
      }
      sent++;
    }
    a.apply(state);
    saveState(cfg.stateFile, state);
  }
  log(`Готово. Отправлено сообщений: ${sent}`);

  // 5. Закреплённое сообщение «Зараз»
  if (cfg.pin && (fact || addr.ok)) {
    try {
      await updatePinned(cfg, state, chat, statusBody(state, { addr, fact }, now, cfg, plan), now);
    } catch (e) {
      console.log(`::warning::Не удалось обновить закреплённое сообщение: ${e.message}`);
    }
    saveState(cfg.stateFile, state);
  }

  if (!fact && !addr.ok) {
    throw new Error('Ни сайт ДТЕК, ни резервный график сейчас недоступны. Попробую при следующем запуске.');
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.log(`::error::${String((e && e.message) || e)}`);
    // Красный крестик ставим только при ручном запуске: GitHub шлёт письмо на каждый
    // неудачный запуск, а по расписанию их было бы по письму каждые 5 минут.
    if (process.env.GITHUB_EVENT_NAME !== 'schedule') process.exitCode = 1;
  });
}
