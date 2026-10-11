// How yapd talks of its own accord: normal, or focus and quiet, which hold for
// later whatever a mute would keep quiet, so what needs him and the answer to
// his own message still come through; and whether updates are said in their
// headline, with the rest kept for "more", or in full.

/** The modes that hold what doesn't need him for later. */
export type Hold = "focus" | "quiet"

/** How much of an update is said: its headline, or everything. */
export type Detail = "brief" | "full"
