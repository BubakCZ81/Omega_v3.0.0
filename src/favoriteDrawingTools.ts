import {
  registerIcon,
  registerWidgetAction,
  type DrawingTypeKey,
  type Vela,
  type WidgetContext,
} from '@luxalgo/vela';
import { favoriteDrawingToolTypes } from './drawingToolFavorites';

const actionId = 'omega-favorite-drawing-tools';
const toolLabels: Record<string, string> = {
  trendline: 'Trend Line',
  hline: 'Horizontal Line',
  ray: 'Ray',
  extendedline: 'Extended Line',
  vline: 'Vertical Line',
  hray: 'Horizontal Ray',
  crossline: 'Cross Line',
  infoline: 'Info Line',
  trendangle: 'Trend Angle',
  box: 'Rectangle',
  text: 'Text',
  note: 'Note',
  pricenote: 'Price Note',
  comment: 'Comment',
  pricelabel: 'Price Label',
  signpost: 'Signpost',
  parallelchannel: 'Parallel Channel',
  disjointchannel: 'Disjoint Channel',
  flattopbottom: 'Flat Top/Bottom',
  regressionchannel: 'Regression Channel',
  anchoredvwap: 'Anchored VWAP',
  fixedrangevp: 'Fixed Range Volume Profile',
  pitchfork: 'Pitchfork',
  schiffpitchfork: 'Schiff Pitchfork',
  modifiedschiffpitchfork: 'Modified Schiff Pitchfork',
  insidepitchfork: 'Inside Pitchfork',
  arrow: 'Arrow',
  callout: 'Callout',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  polyline: 'Polyline',
  freehand: 'Brush',
  highlighter: 'Highlighter',
  circle: 'Circle',
  rotatedrect: 'Rotated Rectangle',
  path: 'Path',
  arc: 'Arc',
  curve: 'Curve',
  arrowmarkup: 'Arrow Up',
  arrowmarkdown: 'Arrow Down',
  flagmark: 'Flag',
  iconstamp: 'Icon Stamp',
  fibretracement: 'Fibonacci Retracement',
  fibextension: 'Fibonacci Extension',
  fibextensiontrend: 'Trend-Based Fibonacci Extension',
  fibfan: 'Fibonacci Fan',
  fibtimezones: 'Fibonacci Time Zones',
  fibchannel: 'Fibonacci Channel',
  fibspeedfan: 'Fibonacci Speed Resistance Fan',
  trendfibtime: 'Trend-Based Fibonacci Time',
  fibcircles: 'Fibonacci Circles',
  fibarcs: 'Fibonacci Arcs',
  fibwedge: 'Fibonacci Wedge',
  fibspiral: 'Fibonacci Spiral',
  gannfan: 'Gann Fan',
  gannbox: 'Gann Box',
  gannsquare: 'Gann Square',
  datepricerange: 'Date and Price Range',
  position: 'Long/Short Position',
  magnifier: 'Magnifier',
  xabcd: 'XABCD Pattern',
  abcd: 'ABCD Pattern',
  elliottimpulse: 'Elliott Impulse Wave',
  elliottcorrection: 'Elliott Correction Wave',
  headshoulders: 'Head and Shoulders',
  gartley: 'Gartley Pattern',
  bat: 'Bat Pattern',
  butterfly: 'Butterfly Pattern',
  crab: 'Crab Pattern',
  shark: 'Shark Pattern',
  cypher: 'Cypher Pattern',
  fairvaluegap: 'Fair Value Gap',
  orderblock: 'Order Block',
  liquidity: 'Liquidity',
};

function labelFor(type: string): string {
  return toolLabels[type] ?? type.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

export function toggleDrawingFavorite(
  drawings: Pick<Vela['drawings'], 'isFavorite' | 'setFavorite'>,
  type: DrawingTypeKey,
): boolean {
  const next = !drawings.isFavorite(type);
  drawings.setFavorite(type, next);
  return next;
}

function closeMenu(menu: HTMLElement): void {
  menu.remove();
  document.removeEventListener('pointerdown', onOutsidePointerDown, true);
  document.removeEventListener('keydown', onMenuKeydown, true);
}

let activeMenu: HTMLElement | null = null;

function onOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  if (activeMenu && target instanceof Node && !activeMenu.contains(target)) {
    closeMenu(activeMenu);
    activeMenu = null;
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !activeMenu) return;
  closeMenu(activeMenu);
  activeMenu = null;
}

function openFavoriteMenu(ctx: WidgetContext): void {
  if (activeMenu) {
    closeMenu(activeMenu);
    activeMenu = null;
  }

  const anchor = ctx.host.querySelector<HTMLButtonElement>('.vela-widget-action-left[aria-label="Favorite drawing tools"]');
  const drawings = ctx.chart.drawings;
  const menu = document.createElement('div');
  menu.className = 'omega-favorite-tools-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Favorite drawing tools');

  const heading = document.createElement('strong');
  heading.className = 'omega-favorite-tools-heading';
  heading.textContent = 'Favorite drawing tools';
  menu.append(heading);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'omega-favorite-tools-search';
  search.placeholder = 'Find a drawing tool…';
  search.setAttribute('aria-label', 'Find a drawing tool');
  menu.append(search);

  const list = document.createElement('div');
  list.className = 'omega-favorite-tools-list';
  const renderTools = () => {
    const query = search.value.trim().toLocaleLowerCase();
    // This menu is the favorites shortcut: it must never fall back to the
    // full drawing-tool catalogue.
    const favorites = favoriteDrawingToolTypes(drawings.favorites());
    list.replaceChildren();
    if (favorites.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'omega-favorite-tools-empty';
      empty.textContent = 'No favorite drawing tools yet. Star a tool in the drawing toolbar to add it here.';
      list.append(empty);
      return;
    }
    const matches = favorites.filter(type => labelFor(type).toLocaleLowerCase().includes(query));
    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'omega-favorite-tools-empty';
      empty.textContent = 'No favorite drawing tools match your search.';
      list.append(empty);
      return;
    }
    for (const type of matches) {
      const row = document.createElement('div');
      row.className = 'omega-favorite-tool-row';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'omega-favorite-tool-item';
      select.setAttribute('role', 'menuitem');
      select.textContent = labelFor(type);
      select.addEventListener('click', () => {
        drawings.setTool(type as DrawingTypeKey);
        closeMenu(menu);
        activeMenu = null;
      });

      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'omega-favorite-tool-star';
      const isFavorite = drawings.isFavorite(type as DrawingTypeKey);
      favorite.textContent = isFavorite ? '★' : '☆';
      favorite.setAttribute('aria-label', `${isFavorite ? 'Remove' : 'Add'} ${labelFor(type)} ${isFavorite ? 'from' : 'to'} favorites`);
      favorite.setAttribute('aria-pressed', String(isFavorite));
      favorite.title = isFavorite ? 'Remove from favorites' : 'Add to favorites';
      favorite.addEventListener('click', event => {
        event.stopPropagation();
        toggleDrawingFavorite(drawings, type as DrawingTypeKey);
        renderTools();
        search.focus();
      });
      row.append(select, favorite);
      list.append(row);
    }
  };
  search.addEventListener('input', renderTools);
  renderTools();
  menu.append(list);

  const rect = anchor?.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(
    rect?.left ?? window.innerWidth / 2,
    window.innerWidth - 256,
  ))}px`;
  menu.style.top = `${Math.max(8, (rect?.bottom ?? 52) + 6)}px`;
  document.body.append(menu);
  activeMenu = menu;

  window.requestAnimationFrame(() => {
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    document.addEventListener('keydown', onMenuKeydown, true);
  });
  search.focus();
}

registerIcon(
  'omega-favorite-tools',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m8 1.5 1.9 4 4.4.6-3.2 3.1.8 4.4L8 11.5l-3.9 2.1.8-4.4-3.2-3.1 4.4-.6z"/></svg>',
);

registerWidgetAction({
  id: actionId,
  target: 'topbar',
  label: 'Favorite drawing tools',
  icon: 'omega-favorite-tools',
  iconOnly: true,
  align: 'left',
  order: 10,
  mobile: 'menu',
  run: openFavoriteMenu,
});
