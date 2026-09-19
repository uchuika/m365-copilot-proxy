// Unit tests for scripts/ask.mjs's pure logic — no network, no M365 thread
// spent. Covers the taxonomy the /gpt-deeper redesign exists to make
// caller-branchable: parseArgs, buildPrompt, classify, renderOutcome.
import { describe, expect, it } from "vitest";
import { buildPrompt, classify, loadAttachments, parseArgs, renderOutcome } from "./ask.mjs";

const io = { stdinIsTTY: true, readStdin: () => "" };

describe("parseArgs", () => {
  it("parses a bare question", () => {
    const inv = parseArgs(["hello", "world"], io);
    expect(inv.question).toBe("hello world");
    expect(inv.attachments).toEqual([]);
    expect(inv.mode).toBe("text");
  });

  it("reads the question from stdin when none is given on argv", () => {
    const inv = parseArgs([], { stdinIsTTY: false, readStdin: () => "piped question\n" });
    expect(inv.question).toBe("piped question");
  });

  it("throws (exit 2) when there is no question and no --ping", () => {
    expect(() => parseArgs([], io)).toThrow(/no question given/);
    try { parseArgs([], io); } catch (e) { expect(e.exitCode).toBe(2); }
  });

  it("--diff \"question\" is NOT swallowed as a revision (the bug the second-opinion review caught)", () => {
    const inv = parseArgs(["--diff", "question"], io);
    expect(inv.question).toBe("question");
    expect(inv.attachments).toEqual([{ kind: "diff", rev: null }]);
  });

  it("collects --file in order, dedupes nothing at parse time (dedup is loadAttachments' job)", () => {
    const inv = parseArgs(["--file", "a.ts", "--file", "b.ts", "q"], io);
    expect(inv.attachments).toEqual([{ kind: "file", path: "a.ts" }, { kind: "file", path: "b.ts" }]);
  });

  it("--diff-rev implies a diff attachment with that revision", () => {
    const inv = parseArgs(["--diff-rev", "main", "q"], io);
    expect(inv.attachments).toEqual([{ kind: "diff", rev: "main" }]);
  });

  it("rejects combining --diff and --diff-rev", () => {
    expect(() => parseArgs(["--diff", "--diff-rev", "main", "q"], io)).toThrow(/already specified/);
  });

  it("rejects --ping combined with a question or attachments", () => {
    expect(() => parseArgs(["--ping", "hello"], io)).toThrow(/cannot be combined/);
    expect(() => parseArgs(["--ping", "--file", "a.ts"], io)).toThrow(/cannot be combined/);
  });

  it("--ping alone produces the fixed ping question", () => {
    const inv = parseArgs(["--ping"], io);
    expect(inv.question).toMatch(/pong/);
  });

  it("rejects an unknown flag instead of swallowing it into the question", () => {
    expect(() => parseArgs(["--modle", "gpt-5.6", "review"], io)).toThrow(/unknown option/);
  });

  it("rejects a value-requiring flag with a missing value", () => {
    expect(() => parseArgs(["--model"], io)).toThrow(/requires a value/);
    expect(() => parseArgs(["--file"], io)).toThrow(/requires a value/);
  });

  it("rejects a non-numeric or non-positive --timeout", () => {
    expect(() => parseArgs(["--timeout", "abc", "q"], io)).toThrow(/positive integer/);
    expect(() => parseArgs(["--timeout", "-1", "q"], io)).toThrow(/positive integer/);
    expect(() => parseArgs(["--timeout", "0", "q"], io)).toThrow(/positive integer/);
  });

  it("--raw sets text-quiet mode, --json sets json mode", () => {
    expect(parseArgs(["--raw", "q"], io).mode).toBe("text-quiet");
    expect(parseArgs(["--json", "q"], io).mode).toBe("json");
  });
});

describe("loadAttachments", () => {
  it("blocks a credential-shaped filename by default", () => {
    expect(() => loadAttachments([{ kind: "file", path: "secrets.json" }], { allowSecretFiles: false }))
      .toThrow(/refusing to attach credential-shaped file/);
  });

  it("--allow-secret-files overrides the block (still fails on the file not existing here)", () => {
    // Passes the guard, then fails on read — proves the guard itself was skipped.
    expect(() => loadAttachments([{ kind: "file", path: "secrets.json" }], { allowSecretFiles: true }))
      .toThrow(/cannot read --file/);
  });

  it("dedupes a repeated --file", () => {
    // ask.mjs itself always exists relative to repo root when tests run from there.
    const loaded = loadAttachments(
      [{ kind: "file", path: "scripts/ask.mjs" }, { kind: "file", path: "scripts/ask.mjs" }],
      { allowSecretFiles: false },
    );
    expect(loaded).toHaveLength(1);
  });
});

describe("buildPrompt", () => {
  it("omits the untrusted-content preamble when there are no attachments (the bug the review caught)", () => {
    const prompt = buildPrompt({ question: "hi" }, []);
    expect(prompt).toBe("hi");
    expect(prompt).not.toMatch(/untrusted/i);
  });

  it("includes the preamble and tagged blocks when attachments are present", () => {
    const prompt = buildPrompt({ question: "hi" }, [{ tag: "file", path: "a.ts", text: "const x = 1;" }]);
    expect(prompt).toMatch(/untrusted/i);
    expect(prompt).toContain('<file path="a.ts">');
    expect(prompt).toContain("const x = 1;");
    expect(prompt.endsWith("hi")).toBe(true);
  });

  it("wraps a git diff in <git_diff>", () => {
    const prompt = buildPrompt({ question: "hi" }, [{ tag: "git_diff", rev: null, text: "diff --git a b" }]);
    expect(prompt).toContain("<git_diff>\ndiff --git a b\n</git_diff>");
  });

  it("refuses a prompt over the size guard rather than gambling a thread on it", () => {
    const huge = { tag: "file", path: "big.txt", text: "x".repeat(2_100_000) };
    expect(() => buildPrompt({ question: "hi" }, [huge])).toThrow(/over the .*-char guard/);
  });
});

describe("classify", () => {
  const base = { elapsedMs: 100, promptChars: 42, model: "gpt-5.6-think-deeper" };

  it("classifies a clean 200 as answer, with truncated=false on finish_reason=stop", () => {
    const outcome = classify({ ...base, httpStatus: 200, body: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: {} } });
    expect(outcome).toMatchObject({ status: "answer", text: "hi", truncated: false });
  });

  it("marks truncated=true on finish_reason=length (F9: concludes early rather than truncating)", () => {
    const outcome = classify({ ...base, httpStatus: 200, body: { choices: [{ message: { content: "hi" }, finish_reason: "length" }], usage: {} } });
    expect(outcome.truncated).toBe(true);
  });

  it("surfaces dea_score and conversation quota from usage when present", () => {
    const outcome = classify({
      ...base, httpStatus: 200,
      body: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { x_m365_dea_score: 1.2e-6, x_m365_conversation_messages: 3, x_m365_conversation_max: 600 } },
    });
    expect(outcome.diagnostics).toMatchObject({ deaScore: 1.2e-6, conversationMessages: 3, conversationMax: 600 });
  });

  it("classifies error.type disengaged as disengaged, not throttled", () => {
    const outcome = classify({ ...base, httpStatus: 502, body: { error: { type: "disengaged", message: "blocked" } } });
    expect(outcome.status).toBe("disengaged");
  });

  it("classifies any other non-200 as throttled (F13: no Disengaged marker => throttle)", () => {
    const outcome = classify({ ...base, httpStatus: 502, body: { error: { message: "empty reply" } } });
    expect(outcome.status).toBe("throttled");
  });

  it("preserves the real error.type in the message without changing the exit-relevant status (all three map to throttled, same caller action)", () => {
    for (const type of ["upstream_empty_response", "rate_limit_error", "upstream_error"]) {
      const outcome = classify({ ...base, httpStatus: 502, body: { error: { type, message: "detail" } } });
      expect(outcome.status).toBe("throttled");
      expect(outcome.message).toContain(type);
    }
  });

  it("classifies a 200 with missing content as malformed, not answer", () => {
    const outcome = classify({ ...base, httpStatus: 200, body: { choices: [{ message: {} }] } });
    expect(outcome.status).toBe("malformed");
  });
});

describe("renderOutcome", () => {
  const answer = { status: "answer", text: "hi", truncated: false, diagnostics: { model: "m", elapsedMs: 1000, promptChars: 10, deaScore: null, conversationMessages: null, conversationMax: null, finishReason: "stop" } };
  const throttled = { status: "throttled", message: "HTTP 502", diagnostics: { model: "m", elapsedMs: 1000, promptChars: 10 } };

  it("maps each status to its exit code", () => {
    expect(renderOutcome(answer, "text").exitCode).toBe(0);
    expect(renderOutcome({ ...throttled, status: "disengaged" }, "text").exitCode).toBe(10);
    expect(renderOutcome(throttled, "text").exitCode).toBe(11);
    expect(renderOutcome({ ...throttled, status: "malformed" }, "text").exitCode).toBe(12);
    expect(renderOutcome({ ...throttled, status: "timeout" }, "text").exitCode).toBe(13);
  });

  it("throws on an unmodeled status instead of silently picking a wrong exit code", () => {
    expect(() => renderOutcome({ status: "made-up" }, "text")).toThrow(/unhandled AskOutcome.status/);
  });

  it("text mode: answer on stdout, diagnostics footer on stderr", () => {
    const r = renderOutcome(answer, "text");
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).toMatch(/status=answer exit=0/);
  });

  it("text-quiet mode: suppresses the diagnostics footer on success", () => {
    const r = renderOutcome(answer, "text-quiet");
    expect(r.stdout).toBe("hi\n");
    expect(r.stderr).toBe("");
  });

  it("json mode: exactly one JSON object on stdout, nothing on stderr, schemaVersion present", () => {
    const r = renderOutcome(answer, "json");
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ schemaVersion: 1, status: "answer", text: "hi" });
  });

  it("failure outcomes never write to stdout, so a caller can't mistake a footer for an answer", () => {
    const r = renderOutcome(throttled, "text");
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/do not resend/i);
  });
});
