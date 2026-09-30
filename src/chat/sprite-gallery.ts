/**
 * Ready-made sprites for the editor's gallery, from the design page's set. Drawn as text:
 * one hex digit per pixel (a colour of the fixed palette, see sprite.ts), `.` = background.
 * A drawing smaller than its size is centred on load. Pure data.
 */

import { SPRITE_BACKGROUND } from './sprite';

export interface GallerySprite {
  readonly name: string;
  readonly rows: readonly string[];
}

export interface GalleryGroup {
  readonly side: number;
  readonly sprites: readonly GallerySprite[];
}

export const SPRITE_GALLERY: readonly GalleryGroup[] = [
  { side: 4, sprites: [
    { name: 'Heart', rows: ['8..8', '8888', '8888', '.88.'] },
    { name: 'Face', rows: ['aaaa', '0aa0', 'aaaa', 'a00a'] },
    { name: 'Arrow', rows: ['.77.', '7777', '.77.', '.77.'] },
    { name: 'Check', rows: ['...b', '..b.', 'b.b.', '.b..'] },
    { name: 'Cross', rows: ['8..8', '.88.', '.88.', '8..8'] },
    { name: 'Tree', rows: ['.bb.', 'bbbb', 'bbbb', '.44.'] },
  ] },
  { side: 5, sprites: [
    { name: 'Heart', rows: ['.8.8.', '88888', '88888', '.888.', '..8..'] },
    { name: 'Smiley', rows: ['.aaa.', 'a0a0a', 'aaaaa', 'a000a', '.aaa.'] },
    { name: 'Skull', rows: ['.777.', '70707', '77777', '.777.', '.7.7.'] },
    { name: 'Star', rows: ['..a..', '.aaa.', 'aaaaa', '.aaa.', '.a.a.'] },
    { name: 'Note', rows: ['..777', '..7.7', '..7..', '777..', '777..'] },
    { name: 'House', rows: ['..8..', '.888.', '88888', '.f4f.', '.f4f.'] },
    { name: 'Ghost', rows: ['.888.', '87878', '88888', '88888', '8.8.8'] },
    { name: 'Invader', rows: ['.bbb.', 'b0b0b', 'bbbbb', '.b.b.', 'b...b'] },
    { name: 'Sword', rows: ['....7', '.a.7.', '..7..', '.4.a.', '4....'] },
  ] },
  { side: 6, sprites: [
    { name: 'Heart', rows: ['.8..8.', '888888', '888888', '.8888.', '..88..'] },
    { name: 'Face', rows: ['.aaaa.', 'a0aa0a', 'aaaaaa', 'a0aa0a', 'aa00aa', '.aaaa.'] },
  ] },
  { side: 7, sprites: [
    { name: 'Heart', rows: ['.88.88.', '8878888', '8888888', '8888888', '.88888.', '..888..', '...8...'] },
    { name: 'Smiley', rows: ['..aaa..', '.aaaaa.', 'aa0a0aa', 'aaaaaaa', 'a0aaa0a', '.a000a.', '..aaa..'] },
    { name: 'Mushroom', rows: ['..888..', '.87788.', '8778878', '8888888', '.f0f0f.', '.fffff.', '..fff..'] },
    { name: 'Pac-Man', rows: ['..aaa..', '.aaaaa.', 'aaaa...', 'aaa....', 'aaaa...', '.aaaaa.', '..aaa..'] },
    { name: 'Skull', rows: ['.77777.', '7777777', '7007007', '7777777', '.77077.', '.77777.', '.7.7.7.'] },
    { name: 'Ghost', rows: ['..888..', '.88888.', '8778778', '87c87c8', '8888888', '8888888', '8.8.8.8'] },
  ] },
  { side: 8, sprites: [
    { name: 'Heart', rows: ['.88..88.', '87888888', '88888888', '88888888', '.888888.', '..8888..', '...88...'] },
    { name: 'Creeper', rows: ['b3bbb3bb', 'bbb3bbbb', 'b00bb00b', 'b00bb00b', 'bbb00b3b', 'bb0000bb', 'bb0000bb', 'b30bb0bb'] },
    { name: 'Squid invader', rows: ['...bb...', '..bbbb..', '.bbbbbb.', 'bb.bb.bb', 'bbbbbbbb', '..b..b..', '.b.bb.b.', 'b.b..b.b'] },
    { name: 'Sword', rows: ['......76', '.....766', '....766.', '.a.766..', '..a66...', '..4a....', '.4..a...', '4.......'] },
    { name: 'Cat', rows: ['9......9', '99....99', '99999999', '90999909', '99999999', '999ee999', '.999999.'] },
    { name: 'Crewmate', rows: ['..8888..', '.888888.', '888cccc.', '888cc7c.', '2888888.', '2888888.', '.88..88.', '.88..88.'] },
  ] },
  { side: 10, sprites: [
    { name: 'Heart', rows: ['.888..888.', '8878888888', '8788888888', '8888888888', '.88888888.', '..888888..', '...8888...', '....88....'] },
    { name: 'Coffee', rows: ['..7..7....', '...7..7...', '..7..7....', '77777777..', '7444444766', '77777777.6', '77777777.6', '7777777766', '.777777...', '555555555.'] },
  ] },
  { side: 12, sprites: [
    { name: 'Poké Ball', rows: ['....0000....', '..00888800..', '.0888888780.', '.0888888880.', '088880088880', '000007700000', '000007700000', '077770077770', '.0777777770.', '.0777777760.', '..00777700..', '....0000....'] },
    { name: 'Crab invader', rows: ['..b.....b..', '...b...b...', '..bbbbbbb..', '.bb.bbb.bb.', 'bbbbbbbbbbb', 'b.bbbbbbb.b', 'b.b.....b.b', '...bb.bb...'] },
    { name: 'Mate', rows: ['.........6..', '........6...', '.......6....', '..bbbb6bbb..', '.4444444444.', '..44944444..', '..49444444..', '..49444444..', '...444444...', '....4444....', '...555555...'] },
    { name: 'Argentina', rows: ['cccccccccccc', 'cccccccccccc', 'cccccccccccc', 'cccccccccccc', '7777a77a7777', '77777aa77777', '77777aa77777', '7777a77a7777', 'cccccccccccc', 'cccccccccccc', 'cccccccccccc', 'cccccccccccc'] },
  ] },
  { side: 16, sprites: [
    { name: 'Plumber', rows: ['...88888....', '..888888888.', '..444ff4f...', '.4f4fff4fff.', '.4f44fff4fff', '.44ffff4444.', '...fffffff..', '..448444....', '.4448448444.', '444488884444', 'ff48a88a84ff', 'fff888888fff', 'ff88888888ff', '..888..888..', '.444....444.', '4444....4444'] },
    { name: 'Ghost', rows: ['................', '......8888......', '....88888888....', '...8888888888...', '..887788887788..', '.88777788777788.', '.8877cc8877cc88.', '.8877cc8877cc88.', '.88877888877888.', '.88888888888888.', '.88888888888888.', '.88888888888888.', '.88888888888888.', '.88888888888888.', '.88.888..888.88.', '.8...88..88...8.'] },
    { name: 'Cool', rows: ['.....aaaaaa.....', '...aaaaaaaaaa...', '..aaaaaaaaaaaa..', '.aaaaaaaaaaaaaa.', 'a00000000000000a', 'a075000aa075000a', 'aa0000aaaa0000aa', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'aaa0aaaaaaaa0aaa', '.aaa0aaaaaa0aaa.', '.aaaa000000aaaa.', '..aaaaaaaaaaaa..', '...aaaaaaaaaa...', '.....aaaaaa.....'] },
  ] },
];

/** Rows of text -> side x side fixed-palette indices, centred, background filled. */
export function parseRows(rows: readonly string[], side: number): Uint8Array {
  const h = rows.length;
  const w = Math.max(0, ...rows.map((r) => r.length));
  const top = Math.max(0, Math.floor((side - h) / 2));
  const left = Math.max(0, Math.floor((side - w) / 2));
  const px = new Uint8Array(side * side).fill(SPRITE_BACKGROUND);
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      const yy = y + top;
      const xx = x + left;
      if (yy >= side || xx >= side) return;
      const v = c === '.' ? SPRITE_BACKGROUND : parseInt(c, 16);
      px[yy * side + xx] = Number.isNaN(v) ? SPRITE_BACKGROUND : v;
    });
  });
  return px;
}

/** Pixels -> rows of text, the form `parseRows` reads (the background as `.`). */
export function toRows(px: ArrayLike<number>, side: number): string[] {
  return Array.from({ length: side }, (_, y) =>
    Array.from({ length: side }, (_, x) => {
      const v = px[y * side + x]!;
      return v === SPRITE_BACKGROUND ? '.' : v.toString(16);
    }).join(''));
}
