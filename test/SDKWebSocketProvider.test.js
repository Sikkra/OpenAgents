const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "CommonJS",
    moduleResolution: "node",
    ignoreDeprecations: "6.0",
  },
});

const { WebSocketProvider } = require("../sdk/src/providers/websocket.ts");

class FakeSocket {
  constructor(listenerCount = 1) {
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.removed = 0;
    this.listenerCountValue = listenerCount;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.onclose?.();
  }

  removeAllListeners() {
    this.removed++;
  }

  listenerCount(event) {
    return event === "message" ? this.listenerCountValue : 0;
  }

  open() {
    this.onopen?.();
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

async function connect(provider, sockets) {
  const promise = provider.connect();
  const socket = sockets[sockets.length - 1];
  socket.open();
  await promise;
  return socket;
}

describe("WebSocketProvider reconnect listener lifecycle", function () {
  it("cleans old handlers across repeated reconnects and handles each message once", async function () {
    const sockets = [];
    const provider = new WebSocketProvider({
      url: "ws://example",
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    for (let i = 0; i < 10; i++) {
      await connect(provider, sockets);
    }

    expect(sockets.slice(0, 9).every((socket) => socket.removed === 1)).to.equal(true);
    expect(sockets.slice(0, 9).every((socket) => socket.onmessage === null)).to.equal(true);

    const response = provider.send("eth_blockNumber");
    const current = sockets[9];
    expect(current.sent).to.have.length(1);
    current.message({ jsonrpc: "2.0", id: current.sent[0].id, result: "0x10" });

    expect(await response).to.equal("0x10");
  });

  it("warns when an adapter exposes too many message listeners", async function () {
    const originalWarn = console.warn;
    const warnings = [];
    const socket = new FakeSocket(11);
    console.warn = (message) => warnings.push(message);

    try {
      const provider = new WebSocketProvider({
        url: "ws://example",
        listenerWarningThreshold: 10,
        webSocketFactory: () => socket,
      });
      await connect(provider, [socket]);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).to.deep.equal([
      "WebSocket message listener count 11 exceeds 10",
    ]);
  });
});
