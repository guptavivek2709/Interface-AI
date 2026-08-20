import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseInputAssignments,
  readInvocationInputs,
} from "../../src/cli/inputs.js";

describe("CLI invocation inputs", () => {
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("loads the checked-in UTF-8 files used by both Windows shells", async () => {
    await expect(readInvocationInputs({ inputs: "examples/inputs/discovery.json" })).resolves.toEqual({
      memberId: "MBR-1001",
      accountType: "Savings",
      nickname: "Rainy Day",
      initialDeposit: "250.00",
    });
    await expect(readInvocationInputs({ inputs: "examples/inputs/replay.json" })).resolves.toEqual({
      memberId: "MBR-1002",
      accountType: "Money market",
      nickname: "Future Fund",
      initialDeposit: "725.50",
    });
  });

  it("parses repeatable name=value inputs without losing spaces or later equals signs", () => {
    expect(parseInputAssignments(["memberId=MBR-1001", "nickname=Rainy Day=A"])).toEqual({
      memberId: "MBR-1001",
      nickname: "Rainy Day=A",
    });
  });

  it("supports a BOM and scalar JSON types while rejecting nested values", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "capability-inputs-test-"));
    const valid = path.join(scratch, "inputs with spaces.json");
    await writeFile(valid, '\uFEFF{"name":"demo","count":2,"enabled":true}', "utf8");
    await expect(readInvocationInputs({ inputs: valid })).resolves.toEqual({
      name: "demo",
      count: 2,
      enabled: true,
    });
    await expect(readInvocationInputs({ inputs: '{"nested":{"no":true}}' })).rejects.toThrow(
      /string, number, or boolean/u,
    );
  });

  it("rejects ambiguous sources, duplicates, reserved names, and missing inputs", async () => {
    await expect(
      readInvocationInputs({ inputs: '{"memberId":"one"}', input: ["memberId=two"] }),
    ).rejects.toThrow(/either --inputs/u);
    expect(() => parseInputAssignments(["memberId=one", "memberId=two"])).toThrow(/more than once/u);
    expect(() => parseInputAssignments(["constructor=value"])).toThrow(/Reserved/u);
    expect(() => parseInputAssignments(["bad name=value"])).toThrow(/Invalid input name/u);
    await expect(readInvocationInputs({})).rejects.toThrow(/Inputs are required/u);
    await expect(readInvocationInputs({ inputs: "{}" })).rejects.toThrow(/at least one input/u);
  });

  it("turns malformed JSON into an actionable Windows-safe error", async () => {
    await expect(readInvocationInputs({ inputs: "{memberId:MBR-1001}" })).rejects.toThrow(
      /On Windows, prefer a JSON file or repeat --input/u,
    );
  });
});
