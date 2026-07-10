// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SalesforceCaseModal from './SalesforceCaseModal';

const API = 'http://localhost:3001/api/sf';

const REQUIRED_CASE_FIELDS = {
  Id: '500xx',
  CaseNumber: '00001042',
  Status: 'Nuevo',
  AccountId: '001xx',
  Account: { Name: 'Acme' },
  Origin: 'WhatsApp',
  Priority: 'Alta',
  Tipificacion__c: 'Consulta',
  Categoria__c: 'Soporte',
  Plataforma__c: 'NEXO',
  Soluci_n_primer_contacto__c: 'Sí',
  Nivel_de_atenci_n__c: 'Nivel 1',
  Atribuible__c: 'Cliente',
  Pais__c: 'CO',
  Tipo_de_cliente__c: 'Empresa',
  Agente_due_o_del_ticket__c: 'Ada',
  Escalado_a_nivel_t_cnico__c: 'No',
};

const DESCRIBE_RESPONSE = {
  picklists: {
    Status: [{ value: 'En espera', label: 'En espera' }],
    subetapa_en_espera__c: [{ value: 'Cliente', label: 'Cliente' }],
    Subetapa_resuelto__c: [{ value: 'Solucionado', label: 'Solucionado' }],
  },
  dependencies: {},
};

const TICKET = {
  id: 42,
  sf_case_id: '500xx',
  sf_case_number: '00001042',
  situacion: 'Needs help',
  nombre_analista: 'Ada',
  correo: 'ada@example.com',
  telefono: '573001112233',
};

function jsonResponse(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function installSalesforceFetch() {
  const fetchMock = vi.fn((url) => {
    const rawUrl = String(url);
    if (rawUrl === `${API}/describe`) return jsonResponse(DESCRIBE_RESPONSE);
    if (rawUrl === `${API}/me`) return jsonResponse({ userId: '005xx', displayName: 'Ada', email: 'ada@example.com' });
    if (rawUrl.startsWith(`${API}/cases/500xx?`)) return jsonResponse(REQUIRED_CASE_FIELDS);
    if (rawUrl === `${API}/cases`) return jsonResponse({ id: '500new', CaseNumber: '00001043' });
    if (rawUrl === `${API}/cases/500xx`) return jsonResponse({ ok: true });
  if (rawUrl === `${API}/cases/500xx/assign-me`) return jsonResponse({ ok: true });
  if (rawUrl === `${API}/cases/500xx/close`) return jsonResponse({ ok: true });
    if (rawUrl.startsWith(`${API}/accounts?`)) return jsonResponse([{ id: '001yy', name: 'Acme Corp' }]);
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function parseBody(call) {
  return JSON.parse(call[1]?.body || '{}');
}

describe('SalesforceCaseModal ticket contract', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends local ticket_id for existing case read, update, assign, and close requests', async () => {
    const fetchMock = installSalesforceFetch();

    render(<SalesforceCaseModal ticket={TICKET} onClose={() => {}} onCaseCreated={() => {}} />);

    await screen.findByText(/Operando como/i);

    const readCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith(`${API}/cases/500xx?`));
    expect(String(readCall[0])).toContain('ticket_id=42');

    fireEvent.click(screen.getByRole('button', { name: /Actualizar Caso/i }));
    await waitFor(() => {
      const updateCall = fetchMock.mock.calls.find(([url, options]) => String(url) === `${API}/cases/500xx` && options?.method === 'PATCH');
      expect(parseBody(updateCall).ticket_id).toBe(42);
    });

    fireEvent.click(screen.getByRole('button', { name: /Asignarme/i }));
    await waitFor(() => {
      const assignCall = fetchMock.mock.calls.find(([url]) => String(url) === `${API}/cases/500xx/assign-me`);
      expect(parseBody(assignCall).ticket_id).toBe(42);
    });

    fireEvent.change(screen.getByPlaceholderText(/solución aplicada/i), { target: { value: 'Resolved with documented steps' } });
    fireEvent.click(screen.getByRole('button', { name: /Cerrar Caso/i }));
    expect(await screen.findAllByText(/Subetapa de Resolución/i)).toHaveLength(2);
    fireEvent.change(screen.getAllByRole('combobox').at(-1), { target: { value: 'Solucionado' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar Cierre/i }));

    await waitFor(() => {
      const closeCall = fetchMock.mock.calls.find(([url]) => String(url) === `${API}/cases/500xx/close`);
      expect(parseBody(closeCall).ticket_id).toBe(42);
    });
  });

  it('sends local ticket_id when creating a Salesforce case', async () => {
    const fetchMock = installSalesforceFetch();

    render(<SalesforceCaseModal ticket={{ ...TICKET, sf_case_id: null, sf_case_number: null }} onClose={() => {}} onCaseCreated={() => {}} />);

    await screen.findByText(/Operando como/i);
    fireEvent.click(screen.getByRole('button', { name: /Crear en Salesforce/i }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([url, options]) => String(url) === `${API}/cases` && options?.method === 'POST');
      expect(parseBody(createCall).ticket_id).toBe(42);
    });
  });

  it('sends local ticket_id when searching Salesforce accounts', async () => {
    const fetchMock = installSalesforceFetch();

    render(<SalesforceCaseModal ticket={{ ...TICKET, sf_case_id: null, sf_case_number: null }} onClose={() => {}} onCaseCreated={() => {}} />);

    await screen.findByText(/Operando como/i);
    fireEvent.change(screen.getByPlaceholderText(/nombre de la empresa/i), { target: { value: 'Acme' } });

    await waitFor(() => {
      const accountCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith(`${API}/accounts?`));
      expect(String(accountCall[0])).toContain('q=Acme');
      expect(String(accountCall[0])).toContain('ticket_id=42');
    });
  });
});
