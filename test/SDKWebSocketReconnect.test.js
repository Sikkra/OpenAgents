const { expect } = require("chai");

require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    target: "es2020",
    ignoreDeprecations: "6.0",
  },
});

const { WebSocketProvider } = require("../sdk/src/providers/websocket");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  open() {
    this.onopen?.();
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("WebSocketProvider reconnect behavior", function () {
  let originalWebSocket;

  beforeEach(function () {
    originalWebSocket = global.WebSocket;
    MockWebSocket.instances = [];
    global.WebSocket = MockWebSocket;
  });

  afterEach(function () {
    global.WebSocket = originalWebSocket;
  });

  it("queues disconnected sends and flushes them in FIFO order", async function () {
    const provider = new WebSocketProvider({
      url: "ws://openagents.test",
      heartbeatIntervalMs: 0,
    });
    const first = provider.send("eth_blockNumber");
    const second = provider.send("eth_chainId");
    const connected = provider.connect();
    const socket = MockWebSocket.instances[0];

    socket.open();
    await connected;

    expect(socket.sent.map((request) => request.method)).to.deep.equal([
      "eth_blockNumber",
      "eth_chainId",
    ]);

    socket.message({ jsonrpc: "2.0", id: 1, result: "0x1" });
    socket.message({ jsonrpc: "2.0", id: 2, result: "0x2" });
    expect(await first).to.equal("0x1");
    expect(await second).to.equal("0x2");
    provider.disconnect();
  });

  it("enforces the max 100 queued message limit", async function () {
    const provider = new WebSocketProvider({
      url: "ws://openagents.test",
      heartbeatIntervalMs: 0,
    });

    for (let i = 0; i < 100; i++) {
      void provider.send("eth_call", [i]);
    }

    try {
      await provider.send("eth_call", [100]);
      throw new Error("expected queue limit failure");
    } catch (error) {
      expect(error.message).to.equal("WebSocket message queue is full");
    }
  });

  it("resubscribes active subscriptions with their original event names", async function () {
    const provider = new WebSocketProvider({
      url: "ws://openagents.test",
      reconnectIntervalMs: 0,
      heartbeatIntervalMs: 0,
    });
    const received = [];
    const connected = provider.connect();
    const firstSocket = MockWebSocket.instances[0];

    firstSocket.open();
    await connected;

    const subscribePromise = provider.subscribe("logs", (payload) => {
      received.push(payload);
    });
    expect(firstSocket.sent[0].method).to.equal("eth_subscribe");
    expect(firstSocket.sent[0].params).to.deep.equal(["logs"]);
    firstSocket.message({ jsonrpc: "2.0", id: 1, result: "sub-old" });
    expect(await subscribePromise).to.equal("sub-old");

    firstSocket.close();
    await delay(5);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.open();
    await delay(5);

    expect(secondSocket.sent[0].method).to.equal("eth_subscribe");
    expect(secondSocket.sent[0].params).to.deep.equal(["logs"]);
    secondSocket.message({ jsonrpc: "2.0", id: 2, result: "sub-new" });
    await delay(5);
    secondSocket.message({
      jsonrpc: "2.0",
      method: "eth_subscription",
      params: { subscription: "sub-new", result: { block: "0xabc" } },
    });

    expect(received).to.deep.equal([{ block: "0xabc" }]);
    provider.disconnect();
  });

  it("detects heartbeat timeouts and closes stale sockets", async function () {
    const provider = new WebSocketProvider({
      url: "ws://openagents.test",
      reconnectIntervalMs: 1000,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 5,
    });
    let timeouts = 0;
    provider.on("heartbeatTimeout", () => {
      timeouts++;
    });

    const connected = provider.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;
    await delay(20);

    expect(timeouts).to.equal(1);
    expect(socket.closed).to.equal(true);
    provider.disconnect();
  });
});
