import { createServer, getServerPort } from '@devvit/web/server';
import { handleRequest } from './http.ts';

const server = createServer(handleRequest);
server.on('error', (err) => console.error(`server error: ${err.stack}`));
server.listen(getServerPort());
