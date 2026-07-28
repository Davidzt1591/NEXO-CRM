// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveBackendOrigin } from './backendOrigin';

function locationAt(origin) {
  return { origin };
}

describe('backend origin resolution', () => {
  it('prefers an explicitly configured backend URL', () => {
    expect(resolveBackendOrigin('https://api.nexo.example/', locationAt('http://localhost:5173')))
      .toBe('https://api.nexo.example');
  });

  it.each([
    ['http://localhost:5173', 'http://localhost:3001'],
    ['http://192.168.1.40:5173', 'http://192.168.1.40:3001'],
    ['https://nexo.lan:5173', 'https://nexo.lan:5173'],
  ])('derives the same-host backend for a static deployment at %s', (frontendOrigin, backendOrigin) => {
    expect(resolveBackendOrigin(undefined, locationAt(frontendOrigin))).toBe(backendOrigin);
  });

  it('supports an explicitly configured same-origin reverse proxy', () => {
    expect(resolveBackendOrigin('/', locationAt('https://nexo.example')))
      .toBe('https://nexo.example');
  });
});
