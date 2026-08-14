import { startDemoServer } from "./server.js";

function configuredPort(): number {
  const raw = process.env["PORT"] ?? process.env["DEMO_PORT"] ?? "4317";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError(`PORT must be an integer between 0 and 65535; received ${raw}`);
  }
  return port;
}

const demo = await startDemoServer({
  port: configuredPort(),
  host: process.env["HOST"] ?? "127.0.0.1",
});

process.stdout.write(`Synthetic banking demo listening at ${demo.baseUrl}\n`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`Received ${signal}; closing the demo server.\n`);
  await demo.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});
