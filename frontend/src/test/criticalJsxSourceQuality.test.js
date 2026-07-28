import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const criticalFiles = [
  "../features/agent-workspace/AgentWorkspaceShell.jsx",
  "../features/agent-workspace/ChatWorkspace.jsx",
  "../features/admin-sla/SlaAdministration.jsx",
  "../features/admin-sla/SlaEditors.jsx",
  "../features/connection/ConnectionDialog.jsx",
  "../features/conversations/ConversationBoard.jsx",
  "../features/session/SessionGate.jsx",
];

describe("critical JSX source quality", () => {
  it.each(criticalFiles)("%s stays reviewable", (relativePath) => {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const longest = Math.max(...lines.map((line) => line.length));

    expect(
      lines.length,
      `${relativePath} exceeds 300 physical lines`,
    ).toBeLessThanOrEqual(300);
    expect(
      longest,
      `${relativePath} contains a line over 300 characters`,
    ).toBeLessThanOrEqual(300);
  });
});
