// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../lib/apiClient';
import { useSlaAdministration } from './useSlaAdministration';

vi.mock('../../lib/apiClient', () => ({ apiRequest: vi.fn(), jsonBody: JSON.stringify }));

describe('useSlaAdministration', () => {
  beforeEach(() => vi.clearAllMocks());
  it('loads policies and calendars in parallel and exposes history', async () => {
    apiRequest.mockImplementation(path => Promise.resolve(path.endsWith('policies') ? { policies: [{ id: 1, version: 2 }] } : { calendars: [{ id: 3, version: 1 }] }));
    const { result } = renderHook(() => useSlaAdministration());
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    expect(result.current.policies[0].version).toBe(2); expect(result.current.calendars[0].id).toBe(3);
  });
  it('keeps save errors and reloads after a conflict', async () => {
    apiRequest.mockImplementation((path, options) => options?.method === 'POST' ? Promise.reject(Object.assign(new Error('conflict'), { status: 409 })) : Promise.resolve(path.endsWith('policies') ? { policies: [] } : { calendars: [] }));
    const { result } = renderHook(() => useSlaAdministration()); await waitFor(() => expect(result.current.state.loading).toBe(false));
    await act(() => result.current.savePolicy({ area_id: 1 }));
    expect(result.current.state.error).toMatch(/otra sesión/i); expect(apiRequest).toHaveBeenCalledTimes(5);
  });
  it('reports reload failure without replacing prior data', async () => {
    apiRequest.mockImplementation(path => Promise.resolve(path.endsWith('policies') ? { policies: [{ id: 1 }] } : { calendars: [] }));
    const { result } = renderHook(() => useSlaAdministration()); await waitFor(() => expect(result.current.policies).toHaveLength(1));
    apiRequest.mockRejectedValue(new Error('service unavailable')); await act(() => result.current.reload());
    expect(result.current.policies).toHaveLength(1); expect(result.current.state.error).toMatch(/service unavailable/i);
  });
  it('aborts stale loads and ignores their late results', async () => {
    const deferred = []; apiRequest.mockImplementation((_path, options) => new Promise(resolve => deferred.push({ resolve, signal: options.signal })));
    const { result } = renderHook(() => useSlaAdministration()); await act(async () => { result.current.reload(); });
    expect(deferred[0].signal.aborted).toBe(true); expect(deferred[1].signal.aborted).toBe(true);
    deferred[0].resolve({ policies: [{ id: 'stale' }] }); deferred[1].resolve({ calendars: [] });
    deferred[2].resolve({ policies: [{ id: 'fresh' }] }); deferred[3].resolve({ calendars: [] });
    await waitFor(() => expect(result.current.policies[0].id).toBe('fresh'));
  });
});
