#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { AlchemyContext, AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Apply from "alchemy/Apply";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import * as Cloudflare from "alchemy/Cloudflare";
import { Cli } from "alchemy/Cli/Cli";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import * as Plan from "alchemy/Plan";
import * as Stage from "alchemy/Stage";
import * as State from "alchemy/State/State";
import { TelemetryLive } from "alchemy/Telemetry/Layer";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import RelayStack from "../alchemy.run.ts";

const relayDeployOutputFields = [
  "url",
  "clientTracingUrl",
  "clientTracingDataset",
  "clientTracingToken",
] as const;

export const RelayDeployOutputField = Schema.Literals(relayDeployOutputFields);
export type RelayDeployOutputField = typeof RelayDeployOutputField.Type;

export const RelayDeployResult = Schema.Literals([
  "applied",
  "noop",
  "dry-run",
  "cancelled",
  "state",
]);
export type RelayDeployResult = typeof RelayDeployResult.Type;

export class RelayDeployError extends Schema.TaggedErrorClass<RelayDeployError>()(
  "RelayDeployError",
  {
    source: Schema.Literals(["alchemy_state", "alchemy_apply"]),
    stage: Schema.String,
    missingFields: Schema.Array(RelayDeployOutputField),
  },
) {
  override get message(): string {
    return `Relay deploy output from '${this.source}' for stage '${this.stage}' is missing required public config fields: ${this.missingFields.join(", ")}`;
  }
}

export class RelayDeployPublicConfigUnavailableError extends Schema.TaggedErrorClass<RelayDeployPublicConfigUnavailableError>()(
  "RelayDeployPublicConfigUnavailableError",
  {
    result: RelayDeployResult,
    stage: Schema.String,
    outputPath: Schema.String,
  },
) {
  override get message(): string {
    return `Relay deploy result '${this.result}' for stage '${this.stage}' did not produce public config required by GitHub environment output '${this.outputPath}'.`;
  }
}

export class RelayDeployEnvFilePathError extends Schema.TaggedErrorClass<RelayDeployEnvFilePathError>()(
  "RelayDeployEnvFilePathError",
  {
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Relay env file path must stay within the relay root and use a safe relative file name: '${this.path}'.`;
  }
}

export interface RelayDeployOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly envFile: Option.Option<string>;
  readonly stage: Option.Option<string>;
  readonly yes: boolean;
  readonly adopt: boolean;
  readonly githubOutput: boolean;
  readonly githubEnvFile: Option.Option<string>;
  readonly readState: boolean;
}

export interface RelayPublicConfig {
  readonly relayUrl: string;
  readonly clientTracingUrl: string;
  readonly clientTracingDataset: string;
  readonly clientTracingToken: string;
}

const assertSingleLineEnvironmentValue = (value: string, errorMessage: string) => {
  if (/[\r\n]/u.test(value)) {
    throw new Error(errorMessage);
  }
};

const publicConfigEnvEntries = (config: RelayPublicConfig) =>
  ({
    T4CODE_RELAY_URL: config.relayUrl,
    T4CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.clientTracingUrl,
    T4CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.clientTracingDataset,
    T4CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.clientTracingToken,
  }) as const;

export function reconcileRootEnvPublicConfig(contents: string, config: RelayPublicConfig): string {
  const entries = Object.entries(publicConfigEnvEntries(config));
  for (const [, value] of entries) {
    assertSingleLineEnvironmentValue(
      value,
      "Relay deployment environment values cannot contain line breaks.",
    );
  }
  const values = new Map(entries);
  const assignment = new RegExp(
    `^\\s*(?:export\\s+)?(${entries.map(([name]) => name).join("|")})\\s*(?:=|:)`,
    "u",
  );
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/u);
  if (/\r?\n$/u.test(contents)) {
    lines.pop();
  }
  const seen = new Set<string>();
  const next: Array<string> = [];
  for (const line of lines) {
    const match = assignment.exec(line);
    if (match === null) {
      next.push(line);
      continue;
    }
    const name = match[1]!;
    if (!seen.has(name)) {
      next.push(`${name}=${values.get(name)}`);
      seen.add(name);
    }
  }
  for (const [name, value] of entries) {
    if (!seen.has(name)) {
      next.push(`${name}=${value}`);
    }
  }
  return `${next.join("\n")}\n`;
}

export function reconcileRootEnvRelayUrl(contents: string, relayUrl: string): string {
  return reconcileRootEnvPublicConfig(contents, {
    relayUrl,
    clientTracingUrl: "",
    clientTracingDataset: "",
    clientTracingToken: "",
  })
    .split("\n")
    .filter((line) => !line.startsWith("T4CODE_RELAY_CLIENT_OTLP_TRACES_"))
    .join("\n");
}

export function hasDeployChanges(plan: Plan.Plan): boolean {
  return (
    Object.keys(plan.deletions).length > 0 ||
    Object.values(plan.resources).some(
      (node) =>
        node.action !== "noop" || node.bindings.some((binding) => binding.action !== "noop"),
    )
  );
}

export interface RelayDeployOutcome {
  readonly result: RelayDeployResult;
  readonly changed: boolean;
  readonly publicConfig: Option.Option<RelayPublicConfig>;
}

export interface RelayProvisioningRequirements {
  readonly adopt: boolean;
  readonly configProvider: ConfigProvider.ConfigProvider;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly stage: string;
  readonly yes: boolean;
}

export class RelayDeployOperations extends Context.Service<
  RelayDeployOperations,
  {
    readonly apply: typeof Apply.apply;
    readonly cli: Effect.Effect<Cli["Service"], never, Cli>;
    readonly confirm: typeof Prompt.confirm;
    readonly makePlan: typeof Plan.make;
    readonly runPrompt: typeof Prompt.run;
    readonly stack: (requirements: RelayProvisioningRequirements) => typeof RelayStack;
    readonly state: typeof Cloudflare.state;
  }
>()("t4code-relay/scripts/deploy/RelayDeployOperations") {}

export function serializeGithubOutput(entries: Readonly<Record<string, string | boolean>>): string {
  return Object.entries(entries)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error("GitHub output keys must be portable environment identifiers.");
      }
      assertSingleLineEnvironmentValue(
        String(value),
        "GitHub output values cannot contain line breaks.",
      );
      return `${key}=${value}\n`;
    })
    .join("");
}

export function serializeRelayClientTracingEnvironment(config: RelayPublicConfig): string {
  return serializeGithubOutput({
    T4CODE_RELAY_CLIENT_OTLP_TRACES_URL: config.clientTracingUrl,
    T4CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: config.clientTracingDataset,
    T4CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.clientTracingToken,
  });
}

const relayRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const repoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const loadDeployConfigProvider = Effect.fn("relay.deploy.loadConfigProvider")(function* (
  envFileOverride: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* relayRoot;

  if (Option.isSome(envFileOverride)) {
    const envFile = envFileOverride.value;
    const segments = envFile.split(/[\\/]/u);
    const hasUnsafeSyntax =
      envFile.length === 0 ||
      envFile.includes("\0") ||
      envFile.includes(":") ||
      path.isAbsolute(envFile) ||
      /^[\\/]/u.test(envFile) ||
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          /[. ]$/u.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
      );
    if (hasUnsafeSyntax) {
      return yield* new RelayDeployEnvFilePathError({ path: envFile });
    }
    const canonicalRoot = yield* fs.realPath(root);
    const canonicalEnvFile = yield* fs.realPath(path.resolve(root, envFile));
    const relative = path.relative(canonicalRoot, canonicalEnvFile);
    if (
      relative === "" ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`)
    ) {
      return yield* new RelayDeployEnvFilePathError({ path: envFile });
    }
    return yield* ConfigProvider.fromDotEnv({ path: canonicalEnvFile });
  }

  return yield* ConfigProvider.fromDotEnv({ path: path.join(root, ".env") }).pipe(
    Effect.catchIf(
      (error) => error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound",
      () => Effect.succeed(ConfigProvider.fromEnv()),
    ),
  );
});

const relayDeployStage = Config.nonEmptyString("stage").pipe(
  Config.option,
  Config.map(
    Option.getOrElse(() => `dev_${process.env.USER ?? process.env.USERNAME ?? "unknown"}`),
  ),
);

interface ReplaceFileMutation {
  readonly _tag: "Replace";
  readonly contents: string;
  readonly original: Option.Option<string>;
  readonly path: string;
}

const readOptionalFile = Effect.fn("relay.deploy.readOptionalFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(path)) ? Option.some(yield* fs.readFileString(path)) : Option.none();
});

const prepareRootEnv = Effect.fn("relay.deploy.prepareRootEnv")(function* (
  config: RelayPublicConfig,
) {
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const rootEnvPath = path.join(root, ".env");
  const original = yield* readOptionalFile(rootEnvPath);
  return {
    _tag: "Replace",
    contents: reconcileRootEnvPublicConfig(
      Option.getOrElse(original, () => ""),
      config,
    ),
    original,
    path: rootEnvPath,
  } satisfies ReplaceFileMutation;
});

const prepareGithubOutput = Effect.fn("relay.deploy.prepareGithubOutput")(function* (
  outcome: RelayDeployOutcome,
) {
  const githubOutputPath = yield* Config.nonEmptyString("GITHUB_OUTPUT");
  const original = yield* readOptionalFile(githubOutputPath);
  const existing = Option.getOrElse(original, () => "");
  const separator = existing.length > 0 && !/\r?\n$/u.test(existing) ? "\n" : "";
  return {
    _tag: "Replace",
    contents: `${existing}${separator}${serializeGithubOutput({
      changed: outcome.changed,
      result: outcome.result,
      ...(Option.isSome(outcome.publicConfig)
        ? {
            relay_url: outcome.publicConfig.value.relayUrl,
          }
        : {}),
    })}`,
    original,
    path: githubOutputPath,
  } satisfies ReplaceFileMutation;
});

const prepareGithubEnvFile = Effect.fn("relay.deploy.prepareGithubEnvFile")(function* (
  outcome: RelayDeployOutcome,
  outputPath: string,
  stage: string,
) {
  if (Option.isNone(outcome.publicConfig)) {
    return yield* new RelayDeployPublicConfigUnavailableError({
      result: outcome.result,
      stage,
      outputPath,
    });
  }
  return {
    _tag: "Replace",
    contents: serializeRelayClientTracingEnvironment(outcome.publicConfig.value),
    original: yield* readOptionalFile(outputPath),
    path: outputPath,
  } satisfies ReplaceFileMutation;
});

interface StagedFileMutation {
  readonly backupPath: Option.Option<string>;
  readonly mutation: ReplaceFileMutation;
  readonly stagedPath: string;
}

const commitFileTransaction = Effect.fn("relay.deploy.commitFileTransaction")(function* (
  mutations: ReadonlyArray<ReplaceFileMutation>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryPaths: Array<string> = [];
  const staged: Array<StagedFileMutation> = [];
  const committed: Array<StagedFileMutation> = [];
  const cleanup = Effect.forEach(
    temporaryPaths,
    (temporaryPath) => fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
    { discard: true },
  );

  const transaction = Effect.gen(function* () {
    for (const mutation of mutations) {
      const stagedPath = yield* fs.makeTempFile({
        directory: path.dirname(mutation.path),
        prefix: `.${path.basename(mutation.path)}.relay-deploy-`,
      });
      temporaryPaths.push(stagedPath);
      yield* fs.writeFileString(stagedPath, mutation.contents);
      let backupPath = Option.none<string>();
      if (Option.isSome(mutation.original)) {
        const backup = yield* fs.makeTempFile({
          directory: path.dirname(mutation.path),
          prefix: `.${path.basename(mutation.path)}.relay-backup-`,
        });
        temporaryPaths.push(backup);
        yield* fs.writeFileString(backup, mutation.original.value);
        backupPath = Option.some(backup);
      }
      staged.push({ backupPath, mutation, stagedPath });
    }

    const commit = Effect.gen(function* () {
      for (const entry of staged) {
        committed.push(entry);
        yield* fs.rename(entry.stagedPath, entry.mutation.path);
      }
    });

    const commitExit = yield* Effect.exit(Effect.uninterruptible(commit));
    if (Exit.isFailure(commitExit)) {
      for (const entry of committed.toReversed()) {
        if (Option.isSome(entry.backupPath)) {
          yield* fs.rename(entry.backupPath.value, entry.mutation.path);
        } else {
          yield* fs.remove(entry.mutation.path, { force: true });
        }
      }
      return yield* Effect.failCause(commitExit.cause);
    }
  });

  yield* transaction.pipe(Effect.ensuring(cleanup));
});

const deployBaseServices = Layer.mergeAll(
  Layer.succeed(AuthProviders, {}),
  Layer.provideMerge(AlchemyContextLive, PlatformServices),
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
  FetchHttpClient.layer,
  TelemetryLive,
  LoggingCli,
);
function relayPublicConfigValues(
  output: unknown,
): Readonly<Record<RelayDeployOutputField, string | undefined>> {
  if (typeof output !== "object" || output === null) {
    return {
      url: undefined,
      clientTracingUrl: undefined,
      clientTracingDataset: undefined,
      clientTracingToken: undefined,
    };
  }
  const value = output as Record<string, unknown>;
  const text = (name: string) => {
    const candidate = value[name];
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  };
  const secret = (name: string): string | undefined => {
    const candidate = value[name];
    if (!Redacted.isRedacted(candidate)) {
      return text(name);
    }
    const redacted = Redacted.value(candidate);
    return typeof redacted === "string" && redacted.length > 0 ? redacted : undefined;
  };
  return {
    url: text("url"),
    clientTracingUrl: text("clientTracingUrl"),
    clientTracingDataset: text("clientTracingDataset"),
    clientTracingToken: secret("clientTracingToken"),
  };
}

export function missingRelayPublicConfigFields(
  output: unknown,
): ReadonlyArray<RelayDeployOutputField> {
  const values = relayPublicConfigValues(output);
  return relayDeployOutputFields.filter((field) => values[field] === undefined);
}

function hasCompleteRelayPublicConfigValues(
  values: Readonly<Record<RelayDeployOutputField, string | undefined>>,
): values is Readonly<Record<RelayDeployOutputField, string>> {
  return relayDeployOutputFields.every((field) => values[field] !== undefined);
}

export function publicConfigFromOutput(output: unknown): RelayPublicConfig | null {
  const values = relayPublicConfigValues(output);
  if (!hasCompleteRelayPublicConfigValues(values)) {
    return null;
  }
  return {
    relayUrl: values.url,
    clientTracingUrl: values.clientTracingUrl,
    clientTracingDataset: values.clientTracingDataset,
    clientTracingToken: values.clientTracingToken,
  };
}

const readRelayPublicConfig = Effect.fn("relay.deploy.readState")(function* (stage: string) {
  const state = yield* State.State;
  const service = yield* state;
  const output = yield* service.getOutput({ stack: "T4CodeRelay", stage });
  const publicConfig = publicConfigFromOutput(output);
  if (publicConfig === null) {
    return yield* new RelayDeployError({
      source: "alchemy_state",
      stage,
      missingFields: missingRelayPublicConfigFields(output),
    });
  }
  return {
    result: "state",
    changed: false,
    publicConfig: Option.some(publicConfig),
  } satisfies RelayDeployOutcome;
});

const runRelayDeploy = Effect.fn("relay.deploy.run")(
  function* (
    options: RelayDeployOptions,
    configProvider: ConfigProvider.ConfigProvider,
    stage: string,
    operations: RelayDeployOperations["Service"],
  ) {
    const stack = yield* operations.stack({
      adopt: options.adopt,
      configProvider,
      dryRun: options.dryRun,
      force: options.force,
      stage,
      yes: options.yes,
    });
    const cli = yield* operations.cli;
    const plan = yield* operations
      .makePlan(stack, { force: options.force })
      .pipe(Effect.provide(stack.services));
    const changed = hasDeployChanges(plan);
    if (options.dryRun) {
      yield* cli.displayPlan(plan);
      return {
        result: "dry-run",
        changed,
        publicConfig: Option.none<RelayPublicConfig>(),
      } satisfies RelayDeployOutcome;
    }
    if (!options.yes && changed) {
      yield* cli.displayPlan(plan);
      const approved = yield* operations.runPrompt(
        operations.confirm({
          message: "Apply this relay deployment?",
        }),
      );
      if (!approved) {
        return {
          result: "cancelled",
          changed,
          publicConfig: Option.none<RelayPublicConfig>(),
        } satisfies RelayDeployOutcome;
      }
    }
    const output = yield* operations.apply(plan).pipe(Effect.provide(stack.services));
    const publicConfig = publicConfigFromOutput(output);
    if (publicConfig === null) {
      return yield* new RelayDeployError({
        source: "alchemy_apply",
        stage,
        missingFields: missingRelayPublicConfigFields(output),
      });
    }
    return {
      result: changed ? "applied" : "noop",
      changed,
      publicConfig: Option.some(publicConfig),
    } satisfies RelayDeployOutcome;
  },
  (effect, options, configProvider, stage, _operations) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.effect(
            AlchemyContext,
            AlchemyContext.pipe(Effect.map((context) => ({ ...context, adopt: options.adopt }))),
          ),
          Layer.succeed(AdoptPolicy, options.adopt),
          Layer.succeed(AuthProviders, {}),
          ConfigProvider.layer(configProvider),
          Layer.succeed(Stage.Stage, stage),
        ),
      ),
      provideFreshArtifactStore,
    ),
);

const relayDeployOperationsLive = Layer.succeed(
  RelayDeployOperations,
  RelayDeployOperations.of({
    apply: Apply.apply,
    cli: Cli,
    confirm: Prompt.confirm,
    makePlan: Plan.make,
    runPrompt: Prompt.run,
    stack: constant(RelayStack),
    state: Cloudflare.state,
  }),
);

const deployServices = Layer.merge(deployBaseServices, relayDeployOperationsLive);

export const deploy = Effect.fn("relay.deploy")(function* (options: RelayDeployOptions) {
  const configProvider = yield* loadDeployConfigProvider(options.envFile);
  const configuredStage = yield* relayDeployStage.pipe(
    Effect.provide(ConfigProvider.layer(configProvider)),
  );
  const stage = Option.getOrElse(options.stage, () => configuredStage);
  const operations = yield* RelayDeployOperations;
  const outcome = options.readState
    ? yield* readRelayPublicConfig(stage).pipe(
        Effect.provide(
          operations.state().pipe(Layer.provideMerge(ConfigProvider.layer(configProvider))),
        ),
      )
    : yield* runRelayDeploy(options, configProvider, stage, operations);
  if (outcome.result === "cancelled") {
    yield* Console.log("Deployment cancelled.");
  }
  const mutations: Array<ReplaceFileMutation> = [];
  let githubEnvMutation = Option.none<ReplaceFileMutation>();
  if (Option.isSome(options.githubEnvFile)) {
    const mutation = yield* prepareGithubEnvFile(outcome, options.githubEnvFile.value, stage);
    githubEnvMutation = Option.some(mutation);
    mutations.push(mutation);
  }
  let rootMutation = Option.none<ReplaceFileMutation>();
  if (Option.isSome(outcome.publicConfig)) {
    const mutation = yield* prepareRootEnv(outcome.publicConfig.value);
    rootMutation = Option.some(mutation);
    mutations.push(mutation);
  }
  if (options.githubOutput) {
    mutations.push(yield* prepareGithubOutput(outcome));
  }
  yield* commitFileTransaction(mutations);
  if (Option.isSome(rootMutation)) {
    yield* Console.log(`Updated ${rootMutation.value.path} with relay public client configuration`);
  }
  if (Option.isSome(githubEnvMutation) && Option.isSome(outcome.publicConfig)) {
    yield* Console.log(`::add-mask::${outcome.publicConfig.value.clientTracingToken}`);
  }
});

export const relayDeployCommand = Command.make(
  "relay-deploy",
  {
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Dry run the deployment without applying changes."),
      Flag.withDefault(false),
    ),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Force updates for resources that would otherwise no-op."),
      Flag.withDefault(false),
    ),
    envFile: Flag.string("env-file").pipe(
      Flag.withDescription(
        "Environment file to load. Defaults to infra/relay/.env with process env fallback.",
      ),
      Flag.optional,
    ),
    stage: Flag.string("stage").pipe(
      Flag.withDescription("Stage to deploy. Defaults to dev_${USER}."),
      Flag.optional,
    ),
    yes: Flag.boolean("yes").pipe(
      Flag.withDescription("Skip the deployment confirmation prompt."),
      Flag.withDefault(false),
    ),
    adopt: Flag.boolean("adopt").pipe(
      Flag.withDescription("Adopt pre-existing cloud resources that conflict with this stack."),
      Flag.withDefault(false),
    ),
    githubOutput: Flag.boolean("github-output").pipe(
      Flag.withDescription("Append relay deployment metadata to GITHUB_OUTPUT."),
      Flag.withDefault(false),
    ),
    githubEnvFile: Flag.string("github-env-file").pipe(
      Flag.withDescription(
        "Write relay client tracing variables to a file suitable for GITHUB_ENV.",
      ),
      Flag.optional,
    ),
    readState: Flag.boolean("read-state").pipe(
      Flag.withDescription("Read the deployed stack output without planning or applying changes."),
      Flag.withDefault(false),
    ),
  },
  deploy,
).pipe(Command.withDescription("Deploy the T4Code relay through Alchemy."));

if (import.meta.main) {
  Command.run(relayDeployCommand, { version: "0.0.0" }).pipe(
    Effect.provide(deployServices),
    Effect.scoped,
    NodeRuntime.runMain,
  );
}
