// Speakers window — the "who is speaking" overlay in the top-left corner of the
// game, Discord style. The orchestrator decides who is on the list (speakers.ts
// in services) and sends it whenever it changes; this only draws it.
//
// It sits far from the minimap, so unlike the scanner window nothing drawn
// here can end up in the minimap capture.

import { listen } from '@tauri-apps/api/event';
import type { SpeakerEntry } from '../services/speakers';

const list = document.getElementById('speakers')!;

function row(entry: SpeakerEntry): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'speaker ' + entry.team + (entry.self ? ' self' : '');
  li.dataset.key = entry.key;
  li.dataset.icon = entry.iconUrl ?? '';

  // The champion's round icon; its first letter on a dark disc until (or if)
  // the icon cannot be had.
  const fallback = document.createElement('div');
  fallback.className = 'icon icon-fallback';
  fallback.textContent = entry.label.match(/\(([^)]+)\)$/)?.[1]?.charAt(0) ?? entry.label.charAt(0);
  if (entry.iconUrl) {
    const img = document.createElement('img');
    img.className = 'icon';
    img.src = entry.iconUrl;
    img.alt = '';
    img.onerror = () => img.replaceWith(fallback);
    li.appendChild(img);
  } else {
    li.appendChild(fallback);
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.label;
  li.appendChild(name);
  return li;
}

listen<{ entries: SpeakerEntry[] }>('speakers:update', (event) => {
  // Rows already showing are kept as they are (no image reload, no re-entry
  // animation); new speakers are added, those who stopped are removed.
  const entries = event.payload.entries;
  const existing = new Map<string, HTMLLIElement>();
  for (const li of Array.from(list.children) as HTMLLIElement[]) existing.set(li.dataset.key ?? '', li);
  const next = entries.map((e) => {
    const li = existing.get(e.key);
    return li && li.querySelector('.name')?.textContent === e.label && li.dataset.icon === (e.iconUrl ?? '') ? li : row(e);
  });
  list.replaceChildren(...next);
});

export {};
