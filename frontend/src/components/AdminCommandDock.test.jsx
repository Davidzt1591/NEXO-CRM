// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Activity, Bot } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import AdminCommandDock from './AdminCommandDock';

const sections = [
  { id: 'resumen', label: 'Resumen', icon: Activity, status: () => 'Listo' },
  { id: 'flujos', label: 'Flujos del bot', icon: Bot, status: () => '3 pasos' },
];

describe('AdminCommandDock', () => {
  it('expands, reports the current module, closes outside, and returns focus after Escape', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<><AdminCommandDock sections={sections} activeModule={sections[0]} context={{}} onSelect={onSelect} /><button type="button">Fuera</button></>);
    const launcher = screen.getByRole('button', { name: 'Abrir comandos' });
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
    expect(launcher).toHaveAttribute('title', expect.stringContaining('Resumen'));
    expect(launcher).toHaveTextContent('');
    expect(screen.queryByRole('navigation', { name: /secciones de administración/i })).not.toBeInTheDocument();

    await user.click(launcher);
    expect(screen.getByRole('button', { name: 'Cerrar comandos' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Resumen' })).toHaveAttribute('aria-current', 'page');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Fuera' }));
    expect(screen.getByRole('button', { name: 'Abrir comandos' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Abrir comandos' })).toHaveTextContent('');

    await user.click(screen.getByRole('button', { name: 'Abrir comandos' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Abrir comandos' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Abrir comandos' }));
    await user.click(screen.getByRole('button', { name: 'Flujos del bot' }));
    expect(onSelect).toHaveBeenCalledWith('flujos');
  });
});
