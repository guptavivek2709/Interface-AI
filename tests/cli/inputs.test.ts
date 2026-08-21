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
    await expect(readInvocationInputs({ inputs: "examples/inputs/member-balance.json" })).resolves.toEqual({
      member_number: "100234",
    });
    await expect(readInvocationInputs({ inputs: "examples/inputs/funds-transfer.json" })).resolves.toEqual({
      member_number: "100234",
      from_share: "100234-S0001",
      to_share: "100234-S0070",
      amount: "1.00",
      memo: "Capability demo one-dollar transfer",
    });
  });

  it("parses repeatable name=value inputs without losing spaces or later equals signs", () => {
    expect(parseInputAssignments(["member_number=100234", "memo=Reviewed amount=1.00"])).toEqual({
      member_number: "100234",
      memo: "Reviewed amount=1.00",
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
      readInvocationInputs({ inputs: '{"member_number":"100234"}', input: ["member_number=100987"] }),
    ).rejects.toThrow(/either --inputs/u);
    expect(() => parseInputAssignments(["member_number=100234", "member_number=100987"])).toThrow(/more than once/u);
    expect(() => parseInputAssignments(["constructor=value"])).toThrow(/Reserved/u);
    expect(() => parseInputAssignments(["bad name=value"])).toThrow(/Invalid input name/u);
    await expect(readInvocationInputs({})).rejects.toThrow(/Inputs are required/u);
    await expect(readInvocationInputs({ inputs: "{}" })).rejects.toThrow(/at least one input/u);
  });

  it("turns malformed JSON into an actionable Windows-safe error", async () => {
    await expect(readInvocationInputs({ inputs: "{member_number:100234}" })).rejects.toThrow(
      /On Windows, prefer a JSON file or repeat --input/u,
    );
  });
});
