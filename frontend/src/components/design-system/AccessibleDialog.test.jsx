// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import AccessibleDialog from './AccessibleDialog';
import { readFileSync } from 'node:fs';
const dialogCss = readFileSync('src/features/conversations/conversations.css', 'utf8');

afterEach(cleanup);
function Fixture({ onClose = vi.fn() }) { return <><button>Origen</button><AccessibleDialog title="Confirmar" onClose={onClose} footer={<button>Último</button>}><button>Primero</button></AccessibleDialog></>; }
describe('AccessibleDialog', () => {
  it('traps Tab in both directions, hides background, and handles Escape', () => {
    const onClose = vi.fn(); render(<Fixture onClose={onClose} />);
    const first = screen.getByRole('button', { name: 'Cerrar diálogo' }); const last = screen.getByRole('button', { name: 'Último' });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Confirmar');
    expect(first).toHaveFocus(); expect(screen.getByText('Origen').closest('button')).toHaveAttribute('aria-hidden', 'true');
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' }); expect(onClose).toHaveBeenCalled();
  });

  it('supports non-destructive backdrop dismissal', () => {
    const onClose = vi.fn(); render(<Fixture onClose={onClose} />);
    fireEvent.mouseDown(document.querySelector('.nx-dialog-backdrop')); expect(onClose).toHaveBeenCalled();
  });

  it('restores focus to the opener after dismissal', async () => {
    function Stateful() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>Abrir</button>{open ? <AccessibleDialog title="Confirmar" onClose={() => setOpen(false)} footer={<button>Confirmar</button>}>Contenido</AccessibleDialog> : null}</>; }
    render(<Stateful />); const opener = screen.getByRole('button', { name: 'Abrir' }); opener.focus(); fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await new Promise(resolve => window.setTimeout(resolve, 1)); expect(opener).toHaveFocus();
  });

  it('keeps dialog content scrollable within desktop and mobile viewports', () => {
    expect(dialogCss).toMatch(/max-height:calc\(100dvh/);
    expect(dialogCss).toMatch(/\.nx-dialog__body\{[^}]*overflow-y:auto/);
    expect(dialogCss).toMatch(/@media\(max-width:600px\)/);
  });

  it('keeps focus and background inert while an open dialog rerenders with a new inline close callback', () => {
    function Stateful() {
      const [value, setValue] = useState('');
      return <><button>Opener</button><AccessibleDialog title="Editar" onClose={() => setValue('closed')}><label htmlFor="stable-input">Valor</label><input id="stable-input" value={value} onChange={event => setValue(event.target.value)} /></AccessibleDialog></>;
    }
    render(<Stateful />);
    const input = screen.getByLabelText('Valor'); input.focus(); fireEvent.change(input, { target: { value: 'typed' } });
    expect(input).toHaveFocus(); expect(input).toHaveValue('typed');
    expect(screen.getByText('Opener').closest('button')).toHaveAttribute('aria-hidden', 'true');
  });
});
