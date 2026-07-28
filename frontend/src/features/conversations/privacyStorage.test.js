// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSensitiveBrowserStorage, LEGACY_SENSITIVE_STORAGE_KEYS } from './privacyStorage';

describe('conversation privacy storage', () => {
  beforeEach(() => {
    const makeStorage = () => { const values = new Map(); return { clear: vi.fn(() => values.clear()), getItem: vi.fn(key => values.get(key) ?? null), setItem: vi.fn((key, value) => values.set(key, String(value))), removeItem: vi.fn(key => values.delete(key)) }; };
    vi.stubGlobal('localStorage', makeStorage()); vi.stubGlobal('sessionStorage', makeStorage());
  });
  afterEach(() => vi.unstubAllGlobals());
  it('removes every legacy customer storage key while retaining safe preferences', () => {
    LEGACY_SENSITIVE_STORAGE_KEYS.forEach(key => { localStorage.setItem(key, 'secret'); sessionStorage.setItem(key, 'secret'); });
    localStorage.setItem('nexo_conversation_view', 'board'); localStorage.setItem('nexo_board_notifications', 'on');
    clearSensitiveBrowserStorage();
    LEGACY_SENSITIVE_STORAGE_KEYS.forEach(key => { expect(localStorage.getItem(key)).toBeNull(); expect(sessionStorage.getItem(key)).toBeNull(); });
    expect(localStorage.getItem('nexo_conversation_view')).toBe('board'); expect(localStorage.getItem('nexo_board_notifications')).toBe('on');
  });

  it('does not let a second principal recover first-principal contacts or messages', async () => {
    vi.resetModules();
    const { useAppStore } = await import('../../store/useAppStore');
    useAppStore.getState().setContacts({ 1: { nombre_analista: 'First principal' } });
    useAppStore.getState().setChatMessages({ 1: [{ body: 'secret' }] });
    useAppStore.getState().clearSensitiveState();
    expect(useAppStore.getState().contacts).toEqual({}); expect(useAppStore.getState().chatMessages).toEqual({});
    expect(sessionStorage.getItem('nexo_contacts')).toBeNull();
  });
});
