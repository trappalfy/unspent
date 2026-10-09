// Approved hero settings: a verbatim copy of brand/hero/hero-settings.json (a test keeps them identical).
// Keys match the prototype's `P` object. Never edit by hand; change only with the owner.
import raw from "./hero-settings.json";

export type HeroSettings = typeof raw;
// Owner, 2026-10-09: the art no longer reacts to the mouse. Everything else stays as approved.
export const heroSettings: Readonly<HeroSettings> = Object.freeze({ ...raw, cursorOn: false });
