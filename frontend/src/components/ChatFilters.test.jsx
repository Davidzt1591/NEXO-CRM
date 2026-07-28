// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatFilters from './ChatFilters';

afterEach(cleanup);

describe('ChatFilters', () => {
  it('exposes the candidate filter as inactive programmatically', () => {
    render(<ChatFilters filter="all" isAdmin onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Candidatos' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('exposes the candidate filter as active programmatically', () => {
    render(<ChatFilters filter="candidates" isAdmin onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Candidatos' })).toHaveAttribute('aria-pressed', 'true');
  });
});
