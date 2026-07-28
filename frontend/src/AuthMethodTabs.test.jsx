// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./store/useAppStore', () => ({ useAppStore: vi.fn() }));
vi.mock('./lib/nexoSocket', () => ({ socket: {} }));
vi.mock('./lib/authSession', () => ({ AUTH_INVALIDATED_EVENT: 'nexo:auth-invalidated', createSession: vi.fn(), deleteSession: vi.fn(), restoreSessionWithRetry: vi.fn() }));
import { AuthMethodTabs } from './App';

describe('AuthMethodTabs', () => {
  it('implements ARIA tabs with arrows, Home, End, roving tab index, and focus', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const { rerender } = render(<AuthMethodTabs mode="qr" onSelect={onSelect} />);
    const qr = screen.getByRole('tab', { name: 'Código QR' });
    const code = screen.getByRole('tab', { name: 'Código numérico' });
    expect(qr).toHaveAttribute('aria-selected', 'true'); expect(qr).toHaveAttribute('tabindex', '0'); expect(code).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(qr, { key: 'ArrowRight' }); expect(onSelect).toHaveBeenLastCalledWith('code');
    rerender(<AuthMethodTabs mode="code" onSelect={onSelect} />); act(() => vi.runOnlyPendingTimers()); expect(code).toHaveFocus();
    fireEvent.keyDown(code, { key: 'Home' }); expect(onSelect).toHaveBeenLastCalledWith('qr');
    fireEvent.keyDown(code, { key: 'End' }); expect(onSelect).toHaveBeenLastCalledWith('code');
    vi.useRealTimers();
  });
});
