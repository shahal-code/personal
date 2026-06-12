import { createApp } from "./app.js";
import { PORT } from "./config/env.js";

export async function startServer() {
  const app = await createApp();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Phone Cloud API listening on port ${PORT}`);
  });
}
