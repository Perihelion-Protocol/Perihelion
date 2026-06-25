import { MempoolServer } from "./index.js";

const port = parseInt(process.env.PORT ?? "3000", 10);
const server = new MempoolServer({ port });

await server.start();
