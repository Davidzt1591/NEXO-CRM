// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ConnectionDialog from "./ConnectionDialog";

describe("ConnectionDialog", () => {
  it("supports keyboard tabs and sends only a normalized pairing action payload", async () => {
    const user = userEvent.setup();
    const requestPairing = vi.fn();
    render(
      <ConnectionDialog
        open
        onClose={vi.fn()}
        qrCountdown={0}
        pairingLoading={false}
        onRequestQr={vi.fn()}
        onRequestPairing={requestPairing}
        onResetPairing={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Magneto 365 AI" }),
    ).toBeInTheDocument();
    const qr = screen.getByRole("tab", { name: "Código QR" });
    qr.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Código numérico" }),
      ).toHaveFocus(),
    );
    const phone = screen.getByLabelText(/Número de WhatsApp/i);
    fireEvent.change(phone, { target: { value: "573001234567" } });
    await user.click(screen.getByRole("button", { name: "Obtener código" }));
    expect(requestPairing).toHaveBeenCalledWith("573001234567");
  });
  it("keeps pairing disabled until the phone is usable and exposes backend errors", async () => {
    const user = userEvent.setup();
    const view = render(
      <ConnectionDialog
        open
        onClose={vi.fn()}
        qrCountdown={0}
        pairingLoading={false}
        pairingError="No disponible"
        onRequestQr={vi.fn()}
        onRequestPairing={vi.fn()}
        onResetPairing={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Código numérico" }));
    expect(
      screen.getByRole("button", { name: "Obtener código" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("No disponible");
    view.rerender(
      <ConnectionDialog
        open={false}
        onClose={vi.fn()}
        qrCountdown={0}
        pairingLoading={false}
        onRequestQr={vi.fn()}
        onRequestPairing={vi.fn()}
        onResetPairing={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
