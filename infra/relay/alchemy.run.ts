// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Planetscale from "alchemy/Planetscale";

import * as RelayDb from "./src/db.ts";
import { RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import ApiLive, { Api } from "./src/worker.ts";

export default Alchemy.Stack(
  "T4CodeRelay",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const relayApiZone = yield* RelayApiZone;
    const observability = yield* RelayObservability;
    const api = yield* Api;

    return {
      databaseName: db.database.name,
      databaseBranchName: db.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      clientTracingUrl: observability.traces.otelTracesEndpoint,
      clientTracingDataset: observability.traces.name,
      clientTracingToken: observability.clientIngestToken.token,
    };
  }).pipe(Effect.provide(ApiLive)),
);
