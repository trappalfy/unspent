// Approved hero settings: a verbatim copy of brand/hero/hero-settings.json (a test keeps them identical).
// Keys match the prototype's `P` object. Never edit by hand; change only with the owner.
import raw from "./hero-settings.json";

export type HeroSettings = typeof raw;
export const heroSettings: Readonly<HeroSettings> = Object.freeze({ ...raw });
