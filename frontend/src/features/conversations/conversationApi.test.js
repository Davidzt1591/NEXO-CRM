// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../lib/apiClient';
import { requestDevelopment, transitionWorkflow, updateDevelopment } from './conversationApi';

vi.mock('../../lib/apiClient', () => ({ apiRequest: vi.fn(), jsonBody: JSON.stringify }));

describe('conversation API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });
    apiRequest.mockResolvedValue({ id: 9 });
  });

  it('sends exact versioned CAS transition contract once', async () => {
    await transitionWorkflow({ id: 9, workflow_revision: 4 }, 'waiting', 'customer_response');
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [path, options] = apiRequest.mock.calls[0];
    expect(path).toBe('/api/conversations/9/transitions');
    expect(JSON.parse(options.body)).toMatchObject({ version: 1, state: 'waiting', waiting_reason: 'customer_response', expected_revision: 4 });
  });

  it('uses distinct real escalation endpoints without automatic POST retry', async () => {
    await requestDevelopment({ id: 9, workflow_revision: 5 }, 'Impacto interno');
    await updateDevelopment({ id: 9, workflow_revision: 6 }, 'resolved');
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest.mock.calls[0][0]).toBe('/api/conversations/9/development-escalations');
    expect(apiRequest.mock.calls[1][0]).toBe('/api/conversations/9/development-escalations/status');
    expect(JSON.parse(apiRequest.mock.calls[1][1].body)).toMatchObject({ version: 1, status: 'resolved', expected_revision: 6 });
  });
});
