#!/usr/bin/env node
import { Command } from "commander";
import { registerDiscoveryV2Commands } from "./discovery/cliV2.js";

const program = new Command()
  .name("meridian-capabilities")
  .description("Discover, review, canary, approve, and publish digest-bound MERIDIAN capabilities.")
  .version("1.0.0");

registerDiscoveryV2Commands(program);

await program.parseAsync(process.argv);
