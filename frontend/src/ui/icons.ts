import type { PlaceKind } from '../api';

const KIND_ICON: Record<PlaceKind, string> = {
  bus: 'i-bus',
  train: 'i-train',
  airport: 'i-plane',
  education: 'i-cap',
  hospital: 'i-hospital',
  worship: 'i-worship',
  food: 'i-food',
  shop: 'i-shop',
  fuel: 'i-fuel',
  park: 'i-park',
  hotel: 'i-hotel',
  city: 'i-city',
  street: 'i-road',
  poi: 'i-pin',
  pin: 'i-pin',
};

/** Static SVG markup referencing the sprite in index.html (never user text). */
export function kindIcon(kind: PlaceKind): string {
  return `<svg class="i" aria-hidden="true"><use href="#${KIND_ICON[kind] ?? 'i-pin'}"></use></svg>`;
}

export function icon(id: string): string {
  return `<svg class="i" aria-hidden="true"><use href="#${id}"></use></svg>`;
}
