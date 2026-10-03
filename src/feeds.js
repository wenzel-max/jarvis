'use strict';
// Clima e busca de cidade (Open-Meteo). Gratuito e sem chave.

const UA = 'Mozilla/5.0 (compatible; Jarvis/0.1)';

const ENDPOINTS = { forecast: 'https://api.open-meteo.com/v1/forecast' };

async function getJson(url, ms = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getWeather(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Coordenadas inválidas.');
  const u = new URL(ENDPOINTS.forecast);
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

/** Previsão dos próximos dias (1 a 7), para a ferramenta de clima por voz. */
async function getForecast(lat, lon, days = 3) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Coordenadas inválidas.');
  const n = Math.min(7, Math.max(1, Math.round(Number(days) || 1)));
  const u = new URL(ENDPOINTS.forecast);
  u.search = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: n,
  }).toString();
  const j = await getJson(u.toString());
  const d = j.daily || {};
  return {
    current: j.current,
    days: (d.time || []).map((date, i) => ({
      date,
      code: d.weather_code?.[i],
      max: d.temperature_2m_max?.[i],
      min: d.temperature_2m_min?.[i],
      rain: d.precipitation_probability_max?.[i],
    })),
  };
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

module.exports = { getWeather, getForecast, searchCity, ENDPOINTS };
