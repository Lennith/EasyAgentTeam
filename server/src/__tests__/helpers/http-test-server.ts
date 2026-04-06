import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestHttpServerHandle {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

// Keep test URLs compatible with Fetch/Undici blocked-port policy.
const FETCH_BLOCKED_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080
]);

function resolveListeningPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve test server address");
  }
  const port = (address as AddressInfo).port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`failed to resolve valid test server port: ${String(port)}`);
  }
  return port;
}

async function closeServerQuietly(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
}

export async function startTestHttpServer(app: RequestListener, host = "127.0.0.1"): Promise<TestHttpServerHandle> {
  const maxAttempts = 10;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const server = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, host);
      });

      const port = resolveListeningPort(server);
      if (FETCH_BLOCKED_PORTS.has(port)) {
        lastError = new Error(`test server picked fetch-blocked port ${port}`);
        await closeServerQuietly(server);
        continue;
      }
      const baseUrl = new URL("/", `http://${host}:${port}`).origin;
      return {
        server,
        baseUrl,
        close: async () => {
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
      };
    } catch (error) {
      lastError = error;
      await closeServerQuietly(server);
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("failed to start test http server");
}
