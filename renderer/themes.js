// Colourways, after Monument Valley 3: pastel faces whose lit tops warm
// toward butter and whose shaded sides turn cool (violet, indigo, sea blue)
// instead of simply darker. Each is one hue family with one accent. The
// panel and sky tokens for each live in styles.css under the same name.

export const THEMES = {
  // Pink and peach towers, violet shade, mint accent, blossom trees.
  blossom: {
    name: 'Blossom',
    light: '#ffe9c7',
    shadow: '#6e62d4',
    materials: {
      stone: '#f9c9b9', cream: '#fde3c8', coral: '#f28aa0', rose: '#f3a6c0', mint: '#9fe3cf',
      teal: '#6fcfc0', sky: '#a9c4f5', lilac: '#c3a8ef', sand: '#fbd99a', leaf: '#f5a8cf',
      white: '#fff6f0', steel: '#d9d3f2', ink: '#5b4f9a',
    },
    rooms: {
      radiology: '#c3a8ef', 'vision-clinic': '#fbc79f', laboratory: '#f3a6c0', 'nurses-station': '#9fe3cf',
      'operating-room': '#f7b7c8', 'research-office': '#f59aa8', 'general-ward': '#b8b0f0',
    },
  },
  // Periwinkle and ice-blue towers, indigo shade, pink accent.
  tide: {
    name: 'Tide',
    light: '#eef0ff',
    shadow: '#4f58c8',
    materials: {
      stone: '#d6ddfa', cream: '#eef0fb', coral: '#f5a3b5', rose: '#c6c8f5', mint: '#a4ead8',
      teal: '#6fd0c6', sky: '#9ec0f2', lilac: '#b3a8ee', sand: '#fde2b0', leaf: '#8fdcc0',
      white: '#f8faff', steel: '#cfd8f2', ink: '#46508f',
    },
    rooms: {
      radiology: '#a99df0', 'vision-clinic': '#b8d4f7', laboratory: '#8fb4f0', 'nurses-station': '#f5a3b5',
      'operating-room': '#9fe0d6', 'research-office': '#95a4ec', 'general-ward': '#c4d0f6',
    },
  },
  // Mint and jade towers, sea-blue shade, peach accent.
  grove: {
    name: 'Grove',
    light: '#fbf6d8',
    shadow: '#3f7fa8',
    materials: {
      stone: '#d9efdc', cream: '#f1f6e4', coral: '#f6a79a', rose: '#f2c4cf', mint: '#a8e8cf',
      teal: '#62c7b0', sky: '#a6d8e6', lilac: '#bfc8ec', sand: '#f6e2a6', leaf: '#7fd3a6',
      white: '#fbfff8', steel: '#d3e6e0', ink: '#3f6670',
    },
    rooms: {
      radiology: '#8fd3c4', 'vision-clinic': '#e3e9a6', laboratory: '#9fd9e2', 'nurses-station': '#f6b7a6',
      'operating-room': '#b3ebcf', 'research-office': '#7fcfae', 'general-ward': '#c6e2b8',
    },
  },
};

export const DEFAULT_THEME = 'blossom';

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

// One base colour -> the three faces of a solid: the top warms toward the
// theme's light, the shaded side cools toward its shadow hue.
export function shade(base, theme) {
  return { top: mix(base, theme.light, 0.55), left: base, right: mix(base, theme.shadow, 0.4) };
}

// Floor tiles: two pale tints of the room's colour.
export function floorTones(base) {
  return [mix(base, '#ffffff', 0.86), mix(base, '#ffffff', 0.76)];
}
