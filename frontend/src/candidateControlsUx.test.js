import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

describe('candidate chat controls responsive contract', () => {
  it('keeps the chat header and action row wrappable on narrow screens', () => {
    expect(css).toMatch(/\.chat-header\s*\{[^}]*min-height:\s*68px/);
    expect(css).toMatch(/\.chat-header__left\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.chat-header__actions\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/@media \(max-width:\s*1180px\)[\s\S]*?\.chat-header\s*\{[^}]*height:\s*auto/);
  });

  it('provides a 44px candidate action target without forcing badge overflow', () => {
    expect(css).toMatch(/\.action-btn--candidate\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.candidate-badge\s*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.action-btn--candidate\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it('provides an accessible candidate filter without changing the wrapping container', () => {
    expect(css).toMatch(/\.filter-tabs\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.filter-tab--candidate\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.filter-tab:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  });
});
