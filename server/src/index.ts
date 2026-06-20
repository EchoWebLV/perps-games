import { env } from "./env.js";
import { buildServer } from "./http/server.js";

const server = buildServer();
server
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((addr) => console.log(`server listening on ${addr}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
