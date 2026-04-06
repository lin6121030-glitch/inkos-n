import { describe, expect, it } from "vitest";
import { renderTuiFrame } from "../tui/app.js";

describe("tui layout", () => {
  it("renders a project-scoped idle workspace frame", () => {
    const frame = renderTuiFrame({
      projectName: "inkos-demo",
      activeBookTitle: undefined,
      automationMode: "semi",
      status: "idle",
    });

    expect(frame).toContain("Project: inkos-demo");
    expect(frame).toContain("Book: none");
    expect(frame).toContain("Mode: semi");
    expect(frame).toContain("Stage: idle");
    expect(frame).toContain(">");
  });

  it("renders an active book and stage when one is bound", () => {
    const frame = renderTuiFrame({
      projectName: "inkos-demo",
      activeBookTitle: "Night Harbor Echo",
      automationMode: "auto",
      status: "writing",
    });

    expect(frame).toContain("Book: Night Harbor Echo");
    expect(frame).toContain("Mode: auto");
    expect(frame).toContain("Stage: writing");
  });
});
