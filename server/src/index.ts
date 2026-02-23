import { createApp, resolveDataRoot } from "./app.js";
import { logger } from "./utils/logger.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const dataRoot = resolveDataRoot();
const app = createApp({ dataRoot });

process.on("uncaughtException", (error) => {
  logger.error(`[server] Uncaught Exception: ${error}`);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error(`[server] Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

app.listen(port, host, () => {
  logger.info(`[server] listening on http://${host}:${port}`);
  logger.info(`[server] data root: ${dataRoot}`);
});
