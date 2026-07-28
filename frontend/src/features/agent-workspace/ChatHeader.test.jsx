// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChatHeader from "./ChatHeader";

vi.mock("../../store/useAppStore", () => ({
  useAppStore: () => ({ contactTags: {}, customNames: {} }),
}));

function renderHeader(overrides = {}) {
  const actions = {
    onSetTag: vi.fn(),
    onForceBot: vi.fn(),
    onOpenSalesforce: vi.fn(),
    onToggleDetails: vi.fn(),
    onChangeCandidateStatus: vi.fn(),
    candidateLoading: false,
    onToggleMode: vi.fn(),
    onRedirect: vi.fn(),
    onToggleSilence: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(
    <ChatHeader
      contact={{ id: "ticket-1", chatId: "57300@c.us", prioridad: "alta" }}
      headerName="Ada"
      mode="manual"
      silenced={false}
      actions={actions}
    />,
  );
  return actions;
}

describe("ChatHeader branch actions", () => {
  it("exposes and invokes the candidate branch action", async () => {
    const user = userEvent.setup();
    const actions = renderHeader();
    await user.click(screen.getByRole("button", { name: "Marcar candidato" }));
    expect(actions.onChangeCandidateStatus).toHaveBeenCalledOnce();
  });

  it("isolates redirect and destructive delete actions", async () => {
    const user = userEvent.setup();
    const actions = renderHeader();
    await user.click(screen.getByTitle("Derivar a soporte"));
    await user.click(screen.getByTitle("Eliminar registro"));
    expect(actions.onRedirect).toHaveBeenCalledOnce();
    expect(actions.onDelete).toHaveBeenCalledOnce();
  });
});
