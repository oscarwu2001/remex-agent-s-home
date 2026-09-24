// The people of the hospital: faceless, two-tone figures in the Monument
// Valley manner, dressed for the room they work in.

import { P } from './iso.js';

const SKIN = ['#fbf3ea', '#eadbca'];

// Dress by room, so a figure's clothes say where it belongs.
export const LOOKS = {
  'nurses-station': { robe: ['#fdfaf5', '#dfe0e5'], hat: 'cap', accent: '#5eaca6' },
  'operating-room': { robe: ['#72bfb7', '#4f9a95'], hat: 'scrub', accent: '#a9ddd6' },
  'research-office': { robe: ['#f2a592', '#d6806e'], hat: 'beret', accent: '#b8605a' },
  laboratory: { robe: ['#fbfbfb', '#dde3ea'], hat: 'goggles', accent: '#6f90b8' },
  radiology: { robe: ['#b9a0cf', '#977fb0'], hat: 'headlamp', accent: '#f6dc6e' },
  'vision-clinic': { robe: ['#f3cf8e', '#d8ad69'], hat: 'specs', accent: '#585c7c' },
  'general-ward': { robe: ['#a7c3df', '#84a1c2'], hat: 'beanie', accent: '#e3877a' },
};

function hat(kind, accent) {
  switch (kind) {
    case 'cap':
      return (
        `<path d="M-6.9,-32 Q-6.6,-41 0,-41.5 Q6.6,-41 6.9,-32 Z" fill="#ffffff"/>` +
        `<path d="M0,-41.5 Q6.6,-41 6.9,-32 L0,-32 Z" fill="#e6e8ec"/>` +
        `<rect x="-1" y="-39.5" width="2" height="6" fill="${accent}"/>` +
        `<rect x="-3" y="-37.5" width="6" height="2" fill="${accent}"/>`
      );
    case 'scrub':
      return (
        `<path d="M-7,-31 Q-7,-41 0,-41 Q7,-41 7,-31 Z" fill="${accent}"/>` +
        `<path d="M0,-41 Q7,-41 7,-31 L0,-31 Z" fill="#86c9c1"/>` +
        `<rect x="-5.4" y="-30.5" width="10.8" height="5.2" rx="2.2" fill="#e8f7f4"/>`
      );
    case 'beret':
      return (
        `<ellipse cx="-1" cy="-37" rx="8" ry="3.4" transform="rotate(-12 -1 -37)" fill="${accent}"/>` +
        `<circle cx="-1" cy="-40.5" r="1.3" fill="${accent}"/>` +
        '<circle cx="-2.6" cy="-30.5" r="2.1" fill="none" stroke="#585c7c" stroke-width="1"/>' +
        '<circle cx="2.6" cy="-30.5" r="2.1" fill="none" stroke="#585c7c" stroke-width="1"/>'
      );
    case 'goggles':
      return (
        `<rect x="-7" y="-36.5" width="14" height="2.2" fill="${accent}"/>` +
        '<circle cx="-2.8" cy="-35.4" r="2.4" fill="#cfe0f0" stroke="#6f90b8" stroke-width="1"/>' +
        '<circle cx="2.8" cy="-35.4" r="2.4" fill="#cfe0f0" stroke="#6f90b8" stroke-width="1"/>'
      );
    case 'headlamp':
      return (
        '<polygon points="-4,-35 -30,-44 -30,-26" fill="#fff4b8" opacity="0.45" class="beam"/>' +
        '<rect x="-7" y="-36.5" width="14" height="2" fill="#585c7c"/>' +
        `<circle cx="-4.5" cy="-35.5" r="2.6" fill="${accent}" stroke="#585c7c" stroke-width="0.8"/>`
      );
    case 'specs':
      return (
        '<circle cx="-3" cy="-31" r="3" fill="#ffffff" fill-opacity="0.5" stroke="#585c7c" stroke-width="1.4"/>' +
        '<circle cx="3" cy="-31" r="3" fill="#ffffff" fill-opacity="0.5" stroke="#585c7c" stroke-width="1.4"/>' +
        '<path d="M-7,-38 Q0,-44 7,-38" fill="none" stroke="#d8ad69" stroke-width="3" stroke-linecap="round"/>'
      );
    case 'beanie':
      return (
        `<path d="M-6.8,-33 Q-6.6,-41 0,-41 Q6.6,-41 6.8,-33 Z" fill="${accent}"/>` +
        '<circle cx="0" cy="-42" r="2" fill="#f5b4a3"/>'
      );
    default:
      return '';
  }
}

export function personMarkup(roomId) {
  const look = LOOKS[roomId] || LOOKS['general-ward'];
  const [robeLight, robeDark] = look.robe;
  return (
    '<rect class="hit" x="-15" y="-48" width="30" height="58"/>' +
    '<ellipse class="select-ring" cx="0" cy="0" rx="17" ry="8.5"/>' +
    '<ellipse cx="0" cy="0" rx="10" ry="4.6" fill="#3c3552" opacity="0.18"/>' +
    '<g class="figure">' +
    `<path d="M-9,-2 L-5,-23.5 Q0,-26.5 5,-23.5 L9,-2 Q0,3 -9,-2 Z" fill="${robeLight}"/>` +
    `<path d="M0,-25.3 Q3,-25.3 5,-23.5 L9,-2 Q4.5,0.9 0,1.1 Z" fill="${robeDark}"/>` +
    `<circle cx="0" cy="-31" r="6.6" fill="${SKIN[0]}"/>` +
    `<path d="M0,-37.6 A6.6,6.6 0 0 1 0,-24.4 Z" fill="${SKIN[1]}"/>` +
    hat(look.hat, look.accent) +
    '</g>' +
    '<g class="bubble" transform="translate(0 -56)"></g>' +
    '<g class="tag" transform="translate(0 16)"><rect/><text text-anchor="middle" y="3.5"></text></g>'
  );
}

// Status glyphs differ in shape as well as colour: every status, and every
// way of finishing, has its own silhouette.
const INK = '#585c7c';
const BG = '<circle r="9.5" class="b-bg"/>';

export function bubbleMarkup(status) {
  switch (status) {
    case 'working': // spinner
      return `${BG}<path class="spin" d="M0,-5 A5,5 0 1 1 -5,0" fill="none" stroke="#2f6f6b" stroke-width="2.2" stroke-linecap="round"/>`;
    case 'thinking': // pill with three pulsing dots
      return (
        '<rect x="-13" y="-7" width="26" height="14" rx="7" class="b-bg"/>' +
        '<circle class="dot d1" cx="-6" cy="0" r="2"/><circle class="dot d2" cx="0" cy="0" r="2"/><circle class="dot d3" cx="6" cy="0" r="2"/>'
      );
    case 'reporting': // a sheet of notes
      return (
        `${BG}<rect x="-4.5" y="-6" width="9" height="12" rx="1.2" fill="#ffffff" stroke="${INK}" stroke-width="1.4"/>` +
        `<path d="M-2.2,-2.5 H2.2 M-2.2,0.5 H2.2 M-2.2,3.3 H0.8" stroke="${INK}" stroke-width="1.2" stroke-linecap="round"/>`
      );
    case 'blocked': // red disc with a question mark
      return '<circle r="9.5" fill="#b8443f"/><text class="b-q" y="4.5" text-anchor="middle">?</text>';
    case 'your-turn': // speech bubble
      return (
        '<path d="M-12,-8 H12 A3,3 0 0 1 15,-5 V4 A3,3 0 0 1 12,7 H-2 L-7,12 L-6,7 H-12 A3,3 0 0 1 -15,4 V-5 A3,3 0 0 1 -12,-8 Z" class="b-bg"/>' +
        `<rect x="-8" y="-3" width="16" height="2" rx="1" fill="${INK}"/><rect x="-8" y="2" width="10" height="2" rx="1" fill="${INK}"/>`
      );
    case 'delegating': // hourglass
      return `${BG}<path d="M-4,-5 H4 L0,0 L4,5 H-4 L0,0 Z" fill="#8467a3"/>`;
    case 'done': // filled disc, tick
      return '<circle r="9.5" fill="#2f6f6b"/><path d="M-4,0 L-1,3 L4.5,-3.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    case 'quiet': // dashed ring, tick: a presumption, not a report
      return `<circle r="8.5" fill="#ffffff" stroke="#2f6f6b" stroke-width="1.6" stroke-dasharray="3 2.2"/><path d="M-4,0 L-1,3 L4.5,-3.5" fill="none" stroke="#2f6f6b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'failed': // red diamond, cross
      return '<path d="M0,-10.5 L10.5,0 L0,10.5 L-10.5,0 Z" fill="#b8443f"/><path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>';
    case 'stopped': // grey square, stop bar
      return `<rect x="-9" y="-9" width="18" height="18" rx="3" fill="${INK}"/><rect x="-3.5" y="-3.5" width="7" height="7" rx="1" fill="#ffffff"/>`;
    case 'idle': // crescent moon
      return `${BG}<path d="M2.5,-5.5 A6,6 0 1 0 5.5,3 A4.6,4.6 0 1 1 2.5,-5.5 Z" fill="${INK}"/>`;
    default:
      return '';
  }
}

const SPEED = 3.2; // tiles per second
const TAG_CHARS = 13;

export class Person {
  constructor({ id, roomId, layer, at, onSelect }) {
    this.id = id;
    this.roomId = roomId;
    this.pos = at.slice();
    this.path = [];
    this.status = undefined;
    this.leaving = false;
    this.gone = false;
    this.fade = 0;
    this.phase = Math.random() * Math.PI * 2;
    this.el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.el.setAttribute('class', 'person');
    this.el.setAttribute('data-id', id);
    this.el.setAttribute('tabindex', '0');
    this.el.setAttribute('role', 'button');
    this.el.innerHTML = personMarkup(roomId);
    this.figure = this.el.querySelector('.figure');
    this.bubble = this.el.querySelector('.bubble');
    this.tagText = this.el.querySelector('.tag text');
    this.tagRect = this.el.querySelector('.tag rect');
    this.el.addEventListener('click', () => onSelect(id));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(id);
      }
    });
    layer.appendChild(this.el);
  }

  setLabel(name, statusText) {
    // Tags are capped so long project names cannot cover a neighbour; the
    // full name is on the board and in the accessible name.
    const shown = name.length > TAG_CHARS ? `${name.slice(0, TAG_CHARS - 1)}…` : name;
    if (this.tagText.textContent !== shown) {
      this.tagText.textContent = shown;
      const w = Math.max(28, shown.length * 6.3 + 12);
      this.tagRect.setAttribute('x', String(-w / 2));
      this.tagRect.setAttribute('y', '-7');
      this.tagRect.setAttribute('width', String(w));
      this.tagRect.setAttribute('height', '14');
      this.tagRect.setAttribute('rx', '7');
    }
    this.el.setAttribute('aria-label', `${name}: ${statusText}`);
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.bubble.innerHTML = bubbleMarkup(status);
    this.el.dataset.status = status;
  }

  walk(points) {
    this.path = points.map((p) => p.slice());
  }

  leave(points) {
    this.leaving = true;
    this.walk(points);
  }

  get walking() {
    return this.path.length > 0;
  }

  step(dt, t, reducedMotion) {
    if (this.path.length) {
      const target = this.path[0];
      const d = [target[0] - this.pos[0], target[1] - this.pos[1], target[2] - this.pos[2]];
      const len = Math.hypot(d[0], d[1], d[2] * 0.8);
      const move = SPEED * dt;
      if (len <= move || reducedMotion) {
        this.pos = target.slice();
        this.path.shift();
      } else {
        for (let k = 0; k < 3; k++) this.pos[k] += (d[k] / len) * move;
      }
    }

    if (this.leaving && !this.path.length) this.fade = Math.max(0, this.fade - dt * 2.5);
    else this.fade = Math.min(1, this.fade + dt * 2.5);
    if (this.leaving && this.fade === 0) this.gone = true;

    const [sx, sy] = P(this.pos[0], this.pos[1], this.pos[2]);
    this.el.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)}) scale(1.3)`);
    this.el.style.opacity = this.fade.toFixed(3);

    let bob = 0;
    if (!reducedMotion) {
      bob = this.walking
        ? -Math.abs(Math.sin(t * 9 + this.phase)) * 2.6
        : -Math.max(0, Math.sin(t * 1.6 + this.phase)) * 0.8;
    }
    this.figure.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);
  }

  depth() {
    return this.pos[0] + this.pos[1] + this.pos[2] * 0.01;
  }

  remove() {
    this.el.remove();
  }
}
