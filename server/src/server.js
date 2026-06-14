import { createApp } from "./app.js";
import { PORT } from "./config/env.js";

export async function startServer() {
  const app = await createApp();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Phone Cloud API listening on port ${PORT}`);
  });

  // Large uploads may legitimately take longer than Node's default request timeout.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
}
