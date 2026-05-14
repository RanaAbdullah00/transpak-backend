const { start } = require("./src/server");

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err?.message || err);
  process.exit(1);
});

