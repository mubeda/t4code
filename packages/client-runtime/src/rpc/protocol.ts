import { WsRpcGroup } from "@t4code/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/unstable/rpc";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";

let nextRequestId = 0n;

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup, {
  generateRequestId: () => RpcMessage.RequestId(String(nextRequestId++)),
});
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
