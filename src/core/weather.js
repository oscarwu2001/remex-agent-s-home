'use strict';

// The one thing the app may fetch from the internet, and only when the user
// turns "Use the real weather" on: the weather at a place they typed, from
// Open-Meteo (free, no key, no account). This module builds the two URLs and
// checks the answers; electron/main.js does the fetching. Nothing about the
// user's sessions is ever sent: only a place name, or a latitude and
// longitude.

const GEOCODE_HOST = 'geocoding-api.open-meteo.com';
const FORECAST_HOST = 'api.open-meteo.com';
const HOSTS = new Set([GEOCODE_HOST, FORECAST_HOST]);

function searchUrl(name) {
  const q = String(name ?? '').trim().slice(0, 80);
  if (q.length < 2) throw new RangeError('Type at least two letters of a town or city');
  const u = new URL(`https://${GEOCODE_HOST}/v1/search`);
  u.searchParams.set('name', q);
  u.searchParams.set('count', '5');
  u.searchParams.set('language', 'en');
  u.searchParams.set('format', 'json');
  return u.toString();
}

function checkPlace(p) {
  const lat = Number(p?.latitude);
  const lon = Number(p?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError('The place has no valid latitude and longitude');
  }
  // Rounded to about a kilometre: enough for the weather, and no finer a
  // location than the user needs to share.
  return { latitude: Math.round(lat * 100) / 100, longitude: Math.round(lon * 100) / 100 };
}

function forecastUrl(place, unit = 'celsius') {
  const { latitude, longitude } = checkPlace(place);
  const u = new URL(`https://${FORECAST_HOST}/v1/forecast`);
  u.searchParams.set('latitude', String(latitude));
  u.searchParams.set('longitude', String(longitude));
  u.searchParams.set('current', 'temperature_2m,weather_code,is_day');
  u.searchParams.set('temperature_unit', unit === 'fahrenheit' ? 'fahrenheit' : 'celsius');
  return u.toString();
}

// Search results -> [{ name, region, country, latitude, longitude }].
function parsePlaces(json) {
  if (!json || typeof json !== 'object') throw new TypeError('The place search answered with something unexpected');
  if (json.results === undefined) return []; // Open-Meteo leaves it out when nothing matches
  if (!Array.isArray(json.results)) throw new TypeError('The place search answered with something unexpected');
  return json.results
    .filter((r) => r && typeof r.name === 'string')
    .map((r) => ({
      name: r.name.slice(0, 80),
      region: typeof r.admin1 === 'string' ? r.admin1.slice(0, 80) : '',
      country: typeof r.country === 'string' ? r.country.slice(0, 80) : '',
      ...checkPlace(r),
    }));
}

// WMO weather codes, as Open-Meteo reports them, onto the scene's weathers.
function sceneWeather(code) {
  if (!Number.isInteger(code)) throw new TypeError(`weather code ${code} is not a number`);
  if (code <= 1) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  throw new RangeError(`unknown weather code ${code}`);
}

// Forecast -> { weather, temperature, unit, at }. A missing or odd field is
// an error, never a guess at the weather.
function parseCurrent(json) {
  const c = json?.current;
  if (!c || typeof c !== 'object') throw new TypeError('The weather service answered without current weather');
  const temperature = Number(c.temperature_2m);
  if (!Number.isFinite(temperature)) throw new TypeError('The weather service answered without a temperature');
  const unit = json.current_units?.temperature_2m === '°F' ? '°F' : '°C';
  return { weather: sceneWeather(c.weather_code), temperature: Math.round(temperature), unit, at: typeof c.time === 'string' ? c.time : undefined };
}

module.exports = { HOSTS, searchUrl, forecastUrl, parsePlaces, parseCurrent, sceneWeather, checkPlace };
