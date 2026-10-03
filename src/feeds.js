'use strict';
// Clima (Open-Meteo), busca de cidade e notícias (RSS). Tudo gratuito e sem chave.

const UA = 'Mozilla/5.0 (compatible; Jarvis/0.1)';

async function getJson(url, ms = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getWeather(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Coordenadas inválidas.');
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: 1,
  }).toString();
  const j = await getJson(u.toString());
  return { current: j.current, daily: j.daily };
}

async function searchCity(query) {
  if (typeof query !== 'string' || query.trim().length < 2) return [];
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.search = new URLSearchParams({ name: query.trim(), count: 6, language: 'pt', format: 'json' }).toString();
  const j = await getJson(u.toString());
  return (j.results || []).map((r) => ({
    name: r.name,
    admin: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// ---------- RSS ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function clean(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? clean(m[1]) : '';
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = tag(b, 'title');
    let link = tag(b, 'link');
    if (!link) link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    const when = Date.parse(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || '');
    return { title, link, source, time: Number.isFinite(when) ? when : 0 };
  }).filter((i) => i.title && /^https?:\/\//i.test(i.link));
}

/** Alguns feeds (ex.: Folha) vêm em ISO-8859-1; ler tudo como UTF-8 estraga os acentos. */
function decodeBody(buf, contentType) {
  const head = buf.subarray(0, 200).toString('latin1');
  const label = (/charset=["']?([\w-]+)/i.exec(contentType || '') || /encoding=["']([\w-]+)["']/i.exec(head) || [])[1] || 'utf-8';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
  return parseFeed(xml, feed.name).slice(0, 3);
}

/** Até 3 manchetes por fonte, as mais recentes primeiro. Fonte fora do ar não derruba as outras. */
async function getNews(feeds) {
  const list = Array.isArray(feeds) ? feeds.slice(0, 8) : [];
  const settled = await Promise.allSettled(list.map(fetchFeed));
  const items = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failed = settled.filter((r) => r.status === 'rejected').length;
  items.sort((a, b) => b.time - a.time);
  return { items: items.slice(0, 9), failed, total: list.length };
}

module.exports = { getWeather, searchCity, getNews, decodeBody };
