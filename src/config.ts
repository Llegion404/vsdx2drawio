// Funnel configuration — the only file to edit when wiring real accounts.
// Replace the placeholder waitlist URL with your Tally form link, and drop the
// Cloudflare beacon token in to activate funnel-event analytics.

export const CONFIG = {
  /** Tally (or similar) waitlist form URL. 'PLACEHOLDER' hides the CTA button. */
  waitlistUrl: 'PLACEHOLDER',

  /**
   * Donation link — shown in the footer. 'PLACEHOLDER' hides it.
   * NOTE: GitHub Sponsors is unavailable from Uzbekistan (Stripe/PayPal rails).
   * Working options: Dodo Payments link (supports UZ merchants, individuals),
   * or a crypto-donate page — set the URL here once the account exists.
   */
  donateUrl: 'PLACEHOLDER',

  /** Repo URL for the "star on GitHub" footer link. */
  repoUrl: 'https://github.com/Llegion404/vsdx2drawio',

  /** Cloudflare Web Analytics beacon token (data-cf-beacon value). Empty = disabled. */
  cfBeaconToken: '',

  /** Optional price wording A/B variants (cycled by ?exp= param for testing). */
  priceVariants: ['$99–199/seat, one-time', '$149/seat, one-time'] as string[],
};
