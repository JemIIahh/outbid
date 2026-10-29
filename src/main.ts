import { createApp } from "./app.js";
import { createServer } from "./server/app.js";

const port = Number(process.env.PORT ?? 8787);

console.log("Starting a local Celo fork (no real money)...");
const app = await createApp();
console.log(`Agents run in ${app.mode} mode${process.env.OUTBID_ADVERSARY === "1" ? ", with two cheating sellers (Sly, Fakir)" : ""}.`);

const server = createServer({
  bus: app.bus,
  state: () => app.state(),
  startRound: (req) => app.startRound(req),
  revoke: () => app.revoke(),
  fastForward: app.fastForward,
});

server.listen(port, "127.0.0.1", () => console.log(`Outbid is running at http://127.0.0.1:${port}`));

async function shutdown(): Promise<void> {
  server.close();
  server.closeAllConnections();
  await app.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
