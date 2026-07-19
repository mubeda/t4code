export type TauriCommandArguments = Record<string, unknown> | undefined;
export type TauriCommandInvoker = (
  command: string,
  args: TauriCommandArguments,
) => Promise<unknown>;
export type TauriCommandMock = (args: TauriCommandArguments) => unknown;

export interface InvokeTauriCommandInput {
  readonly command: string;
  readonly args?: TauriCommandArguments;
  readonly e2eMock?: TauriCommandMock;
  readonly globalInvoke?: TauriCommandInvoker;
  readonly importedInvoke: TauriCommandInvoker;
}

export async function invokeTauriCommand<T>(input: InvokeTauriCommandInput): Promise<T> {
  if (input.e2eMock) {
    return (await input.e2eMock(input.args)) as T;
  }
  const invoke = input.globalInvoke ?? input.importedInvoke;
  return (await invoke(input.command, input.args)) as T;
}
