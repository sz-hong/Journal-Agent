import { describe, it, expect } from "vitest";
import { buildChatMessages } from "../src/prompt";
import type { RetrievedContext, ChatMessage } from "../src/types";

const contexts: RetrievedContext[] = [
  { title: "Lynch (2024)", page: 10, text: "The EU AI Act regulates live FRT.", sourceFile: "laws.pdf", score: 0.7 },
  { title: "Qiang et al. (2022)", page: 5, text: "Cushing accuracy 95.93%.", sourceFile: "bio.pdf", score: 0.6 },
];

describe("buildChatMessages", () => {
  it("starts with a system message enforcing grounding + citation + no fabrication", () => {
    const msgs = buildChatMessages("What does the EU AI Act say?", contexts);
    expect(msgs[0].role).toBe("system");
    const sys = msgs[0].content.toLowerCase();
    expect(sys).toContain("context");
    expect(sys).toContain("cite");
    // must instruct to admit when the answer is not in the context
    expect(sys.includes("don't know") || sys.includes("not") || sys.includes("unknown")).toBe(true);
  });

  it("ends with a user message containing the question and all context text + sources", () => {
    const msgs = buildChatMessages("What does the EU AI Act say?", contexts);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("What does the EU AI Act say?");
    expect(last.content).toContain("The EU AI Act regulates live FRT.");
    expect(last.content).toContain("Cushing accuracy 95.93%.");
    expect(last.content).toContain("Lynch (2024)");
    expect(last.content).toContain("10"); // page number surfaced for citation
  });

  it("instructs the model to answer in plain text without Markdown", () => {
    const msgs = buildChatMessages("q", contexts);
    const sys = msgs[0].content.toLowerCase();
    expect(sys).toContain("plain text");
    expect(sys).toContain("markdown");
  });

  it("threads prior history between the system and the new user message", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const msgs = buildChatMessages("next question", contexts, history);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
    expect(msgs[2]).toEqual({ role: "assistant", content: "hello" });
    expect(msgs[msgs.length - 1].content).toContain("next question");
  });
});
