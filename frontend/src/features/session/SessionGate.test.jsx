// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import SessionGate from "./SessionGate";

function session(overrides = {}) {
  return {
    authenticated: false,
    unavailable: false,
    pending: false,
    error: "",
    headingRef: createRef(),
    tokenInputRef: createRef(),
    statusRef: createRef(),
    login: vi.fn(),
    restore: vi.fn(),
    ...overrides,
  };
}

function expectOfficialLogo() {
  expect(
    screen.getByRole("img", { name: "Magneto 365 AI" }),
  ).toBeInTheDocument();
}

describe("SessionGate brand and status states", () => {
  it("shows the accessible official logo on login", () => {
    render(<SessionGate session={session()}>Authenticated</SessionGate>);
    expectOfficialLogo();
    expect(screen.getByRole("heading", { name: "NEXO" })).toBeInTheDocument();
  });

  it("shows the official logo and accessible restoring status", () => {
    render(
      <SessionGate session={session({ authenticated: null })}>
        Authenticated
      </SessionGate>,
    );
    expectOfficialLogo();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Restaurando sesión segura",
    );
  });

  it("shows the official logo and retry action when session recovery is unavailable", () => {
    const restore = vi.fn();
    render(
      <SessionGate session={session({ unavailable: true, restore })}>
        Authenticated
      </SessionGate>,
    );
    expectOfficialLogo();
    screen.getByRole("button", { name: "Reintentar" }).click();
    expect(restore).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveAccessibleName(
      "No pudimos verificar tu sesión",
    );
  });
});
