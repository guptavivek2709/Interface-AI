import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface RuntimeGraph {
  files: Set<string>;
  externalModules: Set<string>;
}

function runtimeImports(source: string, filePath: string): string[] {
  const modules: string[] = [];
  const declarations = source.matchAll(
    /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']\s*;/gu,
  );
  for (const declaration of declarations) modules.push(declaration[1]!);
  const sideEffects = source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']\s*;/gu);
  for (const declaration of sideEffects) modules.push(declaration[1]!);
  void filePath;
  return modules;
}

async function replayRuntimeGraph(entry: string): Promise<RuntimeGraph> {
  const graph: RuntimeGraph = { files: new Set(), externalModules: new Set() };
  const visit = async (filePath: string): Promise<void> => {
    const absolute = path.resolve(filePath);
    if (graph.files.has(absolute)) return;
    graph.files.add(absolute);
    const source = await readFile(absolute, "utf8");
    for (const moduleName of runtimeImports(source, absolute)) {
      if (!moduleName.startsWith(".")) {
        graph.externalModules.add(moduleName);
        continue;
      }
      const jsCandidate = path.resolve(path.dirname(absolute), moduleName);
      const tsCandidate = jsCandidate.replace(/\.js$/u, ".ts");
      await visit(tsCandidate);
    }
  };
  await visit(entry);
  return graph;
}

describe("deterministic replay import boundary", () => {
  it("has no runtime dependency on a planner, model SDK, or model implementation", async () => {
    const entry = path.resolve("src/replay/replayRunnerV2.ts");
    const graph = await replayRuntimeGraph(entry);
    const portableFiles = [...graph.files].map((item) => item.replaceAll("\\", "/"));

    expect(portableFiles.some((item) => item.includes("/src/model/"))).toBe(false);
    expect([...graph.externalModules]).not.toContain("@anthropic-ai/sdk");

    const replaySource = await readFile(entry, "utf8");
    expect(replaySource).not.toMatch(/from\s+["']\.\.\/model\//u);
    expect(replaySource).not.toMatch(/import\s*\(\s*["']\.\.\/model\//u);

    const cliPath = path.resolve("src/cli.ts");
    const cliSource = await readFile(cliPath, "utf8");
    const cliRuntimeModules = runtimeImports(cliSource, cliPath);
    expect(cliRuntimeModules.some((item) => item.includes("/model/"))).toBe(false);
  });
});
