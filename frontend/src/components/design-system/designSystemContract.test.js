import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./design-system.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../main.jsx', import.meta.url), 'utf8');
const conversationsCss = readFileSync(new URL('../../features/conversations/conversations.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
const appCoordinator = readFileSync(new URL('../../features/app/AppCoordinator.jsx', import.meta.url), 'utf8');
const conversationExperience = readFileSync(new URL('../../features/conversations/ConversationExperience.jsx', import.meta.url), 'utf8');

describe('design system delivery contracts', () => {
  it('bundles only required local Lato weights and makes Lato the app font', () => {
    expect(main).toMatch(/@fontsource\/lato\/latin-400\.css/);
    expect(main).toMatch(/@fontsource\/lato\/latin-700\.css/);
    expect(main).toMatch(/@fontsource\/lato\/latin-900\.css/);
    expect(`${html}\n${appCss}`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(appCss).toMatch(/body\s*\{[\s\S]*?font-family:\s*'Lato'/);
  });

  it('wraps the application in the notification provider', () => {
    expect(main).toMatch(/<ToastProvider><App\s*\/><\/ToastProvider>/);
  });

  it('defines narrow Case Pulse layout and reduced-motion fallbacks', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*?\.nx-case-pulse__ribbon\s*\{\s*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.nx-spin\s*\{\s*animation:\s*none/);
  });

  it('keeps raw color values inside named token declarations only', () => {
    const componentRules = css.slice(css.indexOf('\n}\n') + 3);
    expect(componentRules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('gives board mode the workspace and a full-screen mobile case overlay', () => {
    expect(conversationsCss).toMatch(/\.workspace--board>\.sidebar\s*\{display:none\}/);
    expect(conversationsCss).toMatch(/@media\(max-width:760px\)[\s\S]*?\.nx-board-workspace-overlay\{[^}]*width:100vw;[^}]*height:100dvh/);
    expect(`${app}\n${appCoordinator}`).toMatch(/workspace--board/);
    expect(conversationExperience).toMatch(/Volver al tablero/);
  });
});
