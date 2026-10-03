'use strict';
// Clima e busca de cidade (Open-Meteo). Gratuito e sem chave.

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

module.exports = { getWeather, searchCity };
