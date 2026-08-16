import Fastify from 'fastify';
import Static from '@fastify/static';
import WebsocketMiddleware from '@fastify/websocket';
import path from 'node:path';

const connectedClients: ({
  socket: WebsocketMiddleware.WebSocket,
  pairedTo: WebsocketMiddleware.WebSocket | undefined,
})[] = new Array();

const fastify = Fastify({
  logger: true
});

fastify.register(Static, {
  root: path.join(process.cwd(), 'web')
});

fastify.register(WebsocketMiddleware);

fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket) => {

    connectedClients.push({ socket, pairedTo: undefined });
    const currentClient = connectedClients.find(e => e.socket === socket)!;

    socket.on('message', data => {
      const payload = JSON.parse(data.toString());
      if (payload.ready === true) {
          const pairsAvailable = connectedClients.filter(e => !e.pairedTo && e.socket !== socket);
          const pair = pairsAvailable[Math.round(Math.random() * (pairsAvailable.length - 1))];
          
          if (pair) {
            pair.pairedTo = socket;
            currentClient.pairedTo = pair.socket;
            pair.socket.send(JSON.stringify({ role: "caller" }));
          } else {
            currentClient.socket.send(JSON.stringify({ role: "callee" }));
          }
      } else if (currentClient.pairedTo) {
        currentClient.pairedTo.send(data.toString());
      }
    });

    socket.on('close', () => {
      let toDel = connectedClients.findIndex(e => e.socket === socket);
      if (toDel > -1) connectedClients.splice(toDel, 1);

      toDel = connectedClients.findIndex(e => e.pairedTo === socket);
      if (toDel > -1) connectedClients[toDel].pairedTo = undefined;
    });

  })
});

setInterval(() => {
    const clientCountPayload = JSON.stringify({ clientCount: connectedClients.length });
    connectedClients.forEach(client => client.socket.send(clientCountPayload));
}, 3000);


fastify.listen({ host: "0.0.0.0", port: 3000 }, (err, address) => {
  if (err) throw err
})
