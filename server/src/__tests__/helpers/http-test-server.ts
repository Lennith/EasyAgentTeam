import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestHttpServerHandle {
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

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

export async function startTestHttpServer(app: RequestListener, host = "127.0.0.1"): Promise<TestHttpServerHandle> {
  const maxAttempts = 3;
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
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("failed to start test http server");
}
