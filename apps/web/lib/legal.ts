// Values for the Terms and Privacy pages that only the owner knows. Until they're set the pages show a visible
// [placeholder]; a production build of the open site refuses to ship without them.

export const legal = {
  entity: process.env.LEGAL_ENTITY ?? "",
  email: process.env.CONTACT_EMAIL ?? "",
  law: process.env.GOVERNING_LAW ?? "",
};

export const LEGAL_UPDATED = "October 9, 2026";

/** A test site behind SITE_ACCESS_KEY isn't open to the public, so it may run with the placeholders. */
export function assertLegalComplete(prelaunch: boolean) {
  if (process.env.SITE_ACCESS_KEY) return;
  const missing = Object.entries({
    LEGAL_ENTITY: legal.entity,
    CONTACT_EMAIL: legal.email,
    GOVERNING_LAW: legal.law,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length && process.env.VERCEL_ENV === "production" && !prelaunch)
    throw new Error(`Terms and Privacy need ${missing.join(", ")} before the site opens`);
}
