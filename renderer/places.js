// The words for rooms, departments and gardens. The core rooms, the
// department kinds and the two built-in gardens are named by their ids
// (src/core/rooms.js) in the word tables; a name the user wrote stays as
// written. The main process sends English names; one that is still a
// kind's own name, or a numbered garden's, is shown in the window's language.

import { tr, translate } from './i18n.js';

// { name, purpose } of a room from config.rooms (core or department).
export function placeWords(room) {
  if (!room) return { name: '', purpose: '' };
  if (!room.custom) return { name: tr(`room.${room.id}.name`), purpose: tr(`room.${room.id}.purpose`) };
  const kind = room.kind;
  if (kind === 'custom') {
    const purpose = room.purpose === translate('en', 'dept.ownPurpose') ? tr('dept.ownPurpose') : room.purpose;
    return { name: room.name, purpose };
  }
  return {
    name: room.name === translate('en', `dept.${kind}.name`) ? tr(`dept.${kind}.name`) : room.name,
    purpose: tr(`dept.${kind}.purpose`),
  };
}

// A garden's name: the built-in ones by id, "Garden 3" by its number.
export function gardenWords(garden) {
  if (!garden) return '';
  if (garden.id === 'garden' || garden.id === 'grove') return tr(`garden.${garden.id}`);
  const n = String(garden.id ?? '').replace(/^plot-/, '');
  return garden.name === translate('en', 'garden.numbered', { n }) ? tr('garden.numbered', { n }) : garden.name;
}
