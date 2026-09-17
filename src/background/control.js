import net from "node:net";

const MAX_MESSAGE_BYTES = 8 * 1024;

function writeResponse(socket, value, onFlushed) {
  socket.end(`${JSON.stringify(value)}\n`, onFlushed);
}

export function startControlServer({ endpoint, token, status, onPause, onResume, onStop, afterStop }) {
  const sockets = new Set();
  let stoppingPromise;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      handled = true;
      socket.setTimeout(0);
      let request;
      try {
        request = JSON.parse(input.slice(0, input.indexOf("\n")));
      } catch {
        writeResponse(socket, { ok: false, error: "invalid_request" });
        return;
      }
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        writeResponse(socket, { ok: false, error: "invalid_request" });
        return;
      }
      if (request.token !== token) {
        writeResponse(socket, { ok: false, error: "unauthorized" });
        return;
      }
      if (request.action === "status") {
        writeResponse(socket, { ok: true, status: status() });
        return;
      }
      if (request.action === "stop") {
        stoppingPromise ??= Promise.resolve().then(onStop);
        stoppingPromise.then(
          () => writeResponse(socket, { ok: true, stopped: true }, () => setImmediate(afterStop ?? (() => {}))),
          (error) => writeResponse(socket, { ok: false, error: error.message || "stop_failed" }),
        );
        return;
      }
      const controlAction = request.action === "pause" ? onPause : request.action === "resume" ? onResume : null;
      if (controlAction) {
        Promise.resolve(controlAction()).then(
          () => writeResponse(socket, { ok: true, status: status() }),
          (error) => writeResponse(socket, { ok: false, error: error.message || "control_failed" }),
        );
        return;
      }
      writeResponse(socket, { ok: false, error: "unknown_action" });
    });
  });
  server.closeOwnedConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export function sendControl(endpoint, request, { timeout = 1_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let output = "";
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => fail(new Error("控制通道响应超时")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_MESSAGE_BYTES) fail(new Error("控制通道响应过大"));
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        reject(new Error("控制通道响应无效"));
      }
    });
  });
}
