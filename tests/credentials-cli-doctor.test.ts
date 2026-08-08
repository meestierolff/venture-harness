import { describe, expect, it } from "vitest";
import {
  inspectCliPrerequisites,
  Redactor,
  type CommandInvocation,
  type CommandRunner,
} from "@/lib/credentials";

describe("CLI prerequisite doctor", () => {
  it("reports installed, missing, and failing binaries without exposing output secrets", async () => {
    const redactor = new Redactor();
    redactor.addSecret("sensitive-version-fragment");
    const runner: CommandRunner = {
      async run(invocation: CommandInvocation) {
        if (invocation.command === "missing") {
          throw Object.assign(new Error("spawn missing ENOENT"), { code: "ENOENT" });
        }
        if (invocation.command === "broken") {
          return { exitCode: 2, stdout: "", stderr: "bad" };
        }
        return {
          exitCode: 0,
          stdout: "tool sensitive-version-fragment 1.2.3\nmore output",
          stderr: "",
        };
      },
    };

    const results = await inspectCliPrerequisites(runner, {
      redactor,
      prerequisites: [
        { id: "ready", binary: "ready", args: ["--version"], purpose: "ready work" },
        { id: "missing", binary: "missing", args: ["--version"], purpose: "missing work" },
        { id: "broken", binary: "broken", args: ["--version"], purpose: "broken work" },
      ],
    });

    expect(results).toEqual([
      {
        id: "ready",
        binary: "ready",
        purpose: "ready work",
        status: "installed",
        version: "tool [REDACTED] 1.2.3",
        nextAction: null,
      },
      {
        id: "missing",
        binary: "missing",
        purpose: "missing work",
        status: "missing",
        version: null,
        nextAction: "Install missing before using missing work.",
      },
      {
        id: "broken",
        binary: "broken",
        purpose: "broken work",
        status: "unavailable",
        version: null,
        nextAction: "broken exists but its version check exited 2; repair or reinstall it.",
      },
    ]);
  });
});
