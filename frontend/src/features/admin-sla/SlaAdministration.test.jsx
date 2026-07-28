// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '../../lib/apiClient';
import SlaAdministration from './SlaAdministration';
import slaEditorsSource from './SlaEditors.jsx?raw';

vi.mock('../../lib/apiClient', () => ({ apiRequest: vi.fn(), jsonBody: JSON.stringify }));
const areas = [{ id: 1, name: 'Soporte', active: true }];
const calendar = { id: 4, area_id: 1, name: 'Bogotá', timezone: 'America/Bogota', version: 2, active: true };
function reads(path) { return Promise.resolve(path.endsWith('policies') ? { policies: [] } : { calendars: [calendar] }); }

describe('SlaAdministration', () => {
  afterEach(cleanup);
  beforeEach(() => { vi.clearAllMocks(); apiRequest.mockImplementation(reads); });
  it('contains no invented business-time literals in production editors', () => {
    expect(slaEditorsSource).not.toMatch(/(?:08:00|17:00)/);
  });
  it('loads empty state, renders a semantic matrix and supports roving tabs', async () => {
    const user = userEvent.setup(); render(<SlaAdministration areas={areas} />); await screen.findByRole('table');
    expect(screen.getAllByText('SLA no configurado')).toHaveLength(8); expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    expect(screen.getByLabelText('Objetivo (min)')).toHaveValue(null);
    expect(screen.getByLabelText('Aviso (min)')).toHaveValue(null);
    expect(screen.getByText('SLA no configurado.')).toBeInTheDocument();
    const policyTab = screen.getByRole('tab', { name: /políticas/i }); policyTab.focus(); await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /calendarios/i })).toHaveFocus(); expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby');
  });
  it('reviews and saves the exact policy payload with complete summary', async () => {
    const user = userEvent.setup(); render(<SlaAdministration areas={areas} />); await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Calendario'), '4'); await user.type(screen.getByLabelText('Objetivo (min)'), '480'); await user.type(screen.getByLabelText('Aviso (min)'), '60'); await user.click(screen.getByRole('button', { name: /revisar y guardar/i }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).getAllByText('Soporte')).toHaveLength(2); for (const text of ['Crítica', 'Horario hábil', 'Bogotá · v2', '8h 0m', '1h 0m', 'Activa · versión nueva']) expect(within(dialog).getByText(text)).toBeInTheDocument();
    apiRequest.mockImplementation((path, options) => options?.method === 'POST' ? Promise.resolve({ version: 1 }) : reads(path)); await user.click(within(dialog).getByRole('button', { name: /confirmar/i }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/admin/sla/policies', expect.objectContaining({ method: 'POST', body: JSON.stringify({ area_id: 1, priority: 'critical', clock_type: 'support', clock_mode: 'business_hours', calendar_id: 4, target_minutes: 480, warning_minutes: 60 }) })));
    expect(await screen.findByText('Nueva versión de política creada.')).toBeInTheDocument();
  });
  it('edits open exception windows and sends exact calendar payload', async () => {
    const user = userEvent.setup(); render(<SlaAdministration areas={areas} />); await screen.findByRole('table'); await user.click(screen.getByRole('tab', { name: /calendarios/i }));
    await user.type(screen.getByLabelText('Nombre'), 'Especial'); await user.click(screen.getByRole('button', { name: /añadir franja/i })); await user.type(screen.getByLabelText('Inicio de franja 1'), '08:00'); await user.type(screen.getByLabelText('Fin de franja 1'), '17:00'); await user.click(screen.getByRole('button', { name: /añadir excepción/i })); await user.type(screen.getByLabelText('Fecha de excepción 1'), '2026-12-31'); await user.click(screen.getByLabelText('Día cerrado'));
    expect(screen.getByText('Franjas de reemplazo')).toBeInTheDocument(); fireEvent.change(screen.getAllByLabelText('Inicio de franja 1')[1], { target: { value: '08:00' } }); fireEvent.change(screen.getAllByLabelText('Fin de franja 1')[1], { target: { value: '17:00' } }); await user.click(screen.getByRole('button', { name: /revisar y guardar/i })); expect(screen.getByRole('dialog')).toHaveTextContent('2026-12-31: 08:00–17:00');
    apiRequest.mockImplementation((path, options) => options?.method === 'POST' ? Promise.resolve({ version: 1 }) : reads(path)); await user.click(screen.getByRole('button', { name: /confirmar y crear/i }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/admin/sla/calendars', expect.objectContaining({ body: JSON.stringify({ area_id: 1, name: 'Especial', timezone: 'America/Bogota', windows: [{ weekday: 1, start: '08:00', end: '17:00' }], exceptions: [{ date: '2026-12-31', closed: false, windows: [{ start: '08:00', end: '17:00' }] }] }) })));
  });
  it('requires a business-hours window but permits 24x7 without one', async () => {
    const user = userEvent.setup(); render(<SlaAdministration areas={areas} />); await screen.findByRole('table'); await user.click(screen.getByRole('tab', { name: /calendarios/i }));
    await user.type(screen.getByLabelText('Nombre'), 'Continuo'); expect(screen.getByText(/Sin franjas/)).toBeInTheDocument(); await user.click(screen.getByRole('button', { name: /revisar y guardar/i })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Modo'), '24x7'); await user.click(screen.getByRole('button', { name: /revisar y guardar/i })); expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it.each([400, 409, 503])('retains policy draft and dialog after %s save errors', async status => {
    const user = userEvent.setup(); render(<SlaAdministration areas={areas} />); await screen.findByRole('table'); await user.selectOptions(screen.getByLabelText('Calendario'), '4'); await user.type(screen.getByLabelText('Objetivo (min)'), '999'); await user.type(screen.getByLabelText('Aviso (min)'), '60'); await user.click(screen.getByRole('button', { name: /revisar y guardar/i }));
    apiRequest.mockImplementation((path, options) => options?.method === 'POST' ? Promise.reject(Object.assign(new Error('save failed'), { status })) : reads(path)); await user.click(screen.getByRole('button', { name: /confirmar y crear/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument(); await user.click(screen.getByRole('button', { name: /volver al borrador/i })); expect(screen.getByLabelText('Objetivo (min)')).toHaveValue(999);
  });
  it('cancels confirmation and restores focus', async () => {
    const user = userEvent.setup(); render(<SlaAdministration areas={areas} />); await screen.findByRole('table'); await user.selectOptions(screen.getByLabelText('Calendario'), '4'); await user.type(screen.getByLabelText('Objetivo (min)'), '480'); await user.type(screen.getByLabelText('Aviso (min)'), '60'); const trigger = screen.getByRole('button', { name: /revisar y guardar/i }); await user.click(trigger); await user.click(screen.getByRole('button', { name: /volver al borrador/i })); await waitFor(() => expect(trigger).toHaveFocus());
  });
});
