// Visible long enough to notice without delaying any interaction.
export const INCOMING_CASE_HIGHLIGHT_MS = 2200;
export const incomingCaseHighlightDuration = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : INCOMING_CASE_HIGHLIGHT_MS;
