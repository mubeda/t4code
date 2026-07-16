// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { WS_METHODS } from "@t4code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient } from "../src/rpc/protocol.ts";

const socketUrl = process.argv[2];
if (!socketUrl) {
  throw new Error("Expected the Rust fixture server WebSocket URL.");
}

const webSocketConstructor = Layer.succeed(
  Socket.WebSocketConstructor,
  (url: string, protocols?: string | ReadonlyArray<string>) =>
    new NodeSocket.NodeWS.WebSocket(
      url,
      typeof protocols === "string" ? protocols : protocols ? [...protocols] : undefined,
    ) as unknown as globalThis.WebSocket,
);
const protocolLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(socketUrl).pipe(Layer.provide(webSocketConstructor))),
  Layer.provide(RpcSerialization.layerJson),
);

const result = await makeWsRpcProtocolClient.pipe(
  Effect.flatMap((client) =>
    client[WS_METHODS.filesystemBrowse]({
      partialPath: ".",
    }),
  ),
  Effect.provide(protocolLayer),
  Effect.scoped,
  Effect.runPromise,
);

NodeAssert.deepStrictEqual(result, {
  parentPath: "C:\\fixture",
  entries: [],
});
