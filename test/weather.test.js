'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HOSTS, searchUrl, forecastUrl, parsePlaces, parseCurrent, sceneWeather } = require('../src/core/weather');

test('only Open-Meteo is ever asked, over https', () => {
  for (const url of [searchUrl('Taipei'), forecastUrl({ latitude: 25.05, longitude: 121.53 })]) {
    const u = new URL(url);
    assert.equal(u.protocol, 'https:');
    assert.ok(HOSTS.has(u.host), u.host);
  }
});

test('the place search sends only the name typed', () => {
  const u = new URL(searchUrl('  New Taipei  '));
  assert.equal(u.searchParams.get('name'), 'New Taipei');
  assert.throws(() => searchUrl(' a '), /at least two letters/);
});

test('the forecast sends a rounded location and nothing else about the user', () => {
  const u = new URL(forecastUrl({ latitude: 25.047675, longitude: 121.531846 }, 'fahrenheit'));
  assert.equal(u.searchParams.get('latitude'), '25.05');
  assert.equal(u.searchParams.get('longitude'), '121.53');
  assert.equal(u.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['current', 'latitude', 'longitude', 'temperature_unit']);
  assert.throws(() => forecastUrl({ latitude: 200, longitude: 0 }), /no valid latitude/);
});

test('search results become places; no match is an empty list', () => {
  const places = parsePlaces({ results: [{ name: 'Hsinchu', admin1: 'Taiwan', country: 'Taiwan', latitude: 24.8036, longitude: 120.9686 }] });
  assert.deepEqual(places, [{ name: 'Hsinchu', region: 'Taiwan', country: 'Taiwan', latitude: 24.8, longitude: 120.97 }]);
  assert.deepEqual(parsePlaces({ generationtime_ms: 0.5 }), []);
  assert.throws(() => parsePlaces({ results: 'x' }), /unexpected/);
});

test('weather codes map onto the scene, and unknown ones are errors, not guesses', () => {
  assert.equal(sceneWeather(0), 'clear');
  assert.equal(sceneWeather(3), 'cloudy');
  assert.equal(sceneWeather(45), 'fog');
  assert.equal(sceneWeather(61), 'rain');
  assert.equal(sceneWeather(81), 'rain');
  assert.equal(sceneWeather(95), 'rain');
  assert.equal(sceneWeather(73), 'snow');
  assert.equal(sceneWeather(86), 'snow');
  assert.throws(() => sceneWeather(30), /unknown weather code 30/);
  assert.throws(() => sceneWeather(undefined), /not a number/);
});

test('current weather comes back with its temperature and unit', () => {
  const now = parseCurrent({
    current_units: { temperature_2m: '°C' },
    current: { time: '2026-09-25T14:00', temperature_2m: 27.6, weather_code: 63, is_day: 1 },
  });
  assert.deepEqual(now, { weather: 'rain', temperature: 28, unit: '°C', at: '2026-09-25T14:00' });
  assert.throws(() => parseCurrent({ current: { weather_code: 0 } }), /without a temperature/);
  assert.throws(() => parseCurrent({}), /without current weather/);
});
