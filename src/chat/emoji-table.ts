/**
 * Station icons: the 8-bit index a hello frame carries points into this table.
 *
 * The order is part of the wire format: a change makes other stations show other
 * pictures. All 256 slots are used, so a new table means a new wire format.
 * Single code points only (no ZWJ or skin-tone sequences).
 * The first 32 are devices and gear (computer, phone, robot, speakers, wifi ...), so the picker opens on them.
 */

export const EMOJI: readonly string[] = [
  '💻', '📱', '🤖', '🔊', '📶', '📞', '📟', '📺', '📷', '📹', '🔋', '🔌', '💾', '💿', '📀', '📲',
  '⌚', '🔉', '🔈', '📢', '📣', '🔬', '👾', '🛸', '🧭', '⚡', '📼', '🔦', '📠', '🧮', '💽', '🔧',
  '🐀', '🐁', '🐂', '🐃', '🐄', '🐅', '🐆', '🐇', '🐈', '🐉', '🐊', '🐋', '🐌', '🐍', '🐎', '🐏',
  '🐐', '🐑', '🐒', '🐓', '🐔', '🐕', '🐖', '🐗', '🐘', '🐙', '🐚', '🐛', '🐜', '🐝', '🐞', '🐟',
  '🐠', '🐡', '🐢', '🐣', '🐤', '🐥', '🐦', '🐧', '🐨', '🐩', '🐪', '🐫', '🐬', '🐭', '🐮', '🐯',
  '🐰', '🐱', '🐲', '🐳', '🐴', '🐵', '🐶', '🐷', '🐸', '🐹', '🐺', '🐻', '🐼', '🐽', '🐾', '🍅',
  '🍆', '🍇', '🍈', '🍉', '🍊', '🍋', '🍌', '🍍', '🍎', '🍏', '🍐', '🍑', '🍒', '🍓', '🍔', '🍕',
  '🍖', '🍗', '🍘', '🍙', '🍚', '🍛', '🍜', '🍝', '🍞', '🍟', '🍠', '🍡', '🍢', '🍣', '🍤', '🍥',
  '🍦', '🍧', '🍨', '🍩', '🍪', '🍫', '🍬', '🍭', '🍮', '🍯', '🍰', '🍱', '🍲', '🍳', '🍴', '🍵',
  '🍶', '🍷', '🍸', '🍹', '🍺', '🍻', '🍼', '🚀', '🚁', '🚂', '🚃', '🚄', '🚅', '🚆', '🚇', '🚈',
  '🚉', '🚊', '🚋', '🚌', '🚍', '🚎', '🚏', '🚐', '🚑', '🚒', '🚓', '🚔', '🚕', '🚖', '🚗', '🚘',
  '🚙', '🚚', '🚛', '🚜', '🚝', '🚞', '🚟', '🎠', '🎡', '🎢', '🎣', '🎤', '🎥', '🎦', '🎧', '🎨',
  '🎩', '🎪', '🎫', '🎬', '🎭', '🎮', '🎯', '🎰', '🎱', '🎲', '🎳', '🎴', '🎵', '🎶', '🎷', '🎸',
  '🎹', '🎺', '🎻', '🎼', '🎽', '🎾', '🎿', '🌰', '🌱', '🌲', '🌳', '🌴', '🌵', '🌶', '🌷', '🌸',
  '🌹', '🌺', '🌻', '🌼', '🌽', '🌾', '🌿', '🍀', '🍁', '🍂', '🍃', '🍄', '🌟', '🌈', '🌊', '🌍',
  '🌙', '🌞', '🌝', '📡', '📻', '💡', '🔥', '🔑', '💣', '💎', '👑', '🏆', '🔔', '🔭', '🔮', '🧲',
];

export const ICON_COUNT = EMOJI.length;
export const NO_ICON = '❔';

/** The picture for an index; a placeholder for anything outside the table. */
export function emojiFor(index: number): string {
  return EMOJI[index] ?? NO_ICON;
}

/** Icon of a station that sent none (or before its hello): a hash of the station id, so everyone agrees. */
export function defaultIconIndex(stationId: number): number {
  return Math.imul(stationId + 1, 2654435761) >>> 24;
}
