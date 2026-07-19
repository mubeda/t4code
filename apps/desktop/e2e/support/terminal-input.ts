export async function sendTerminalText(text: string): Promise<void> {
  const terminalInput = browser.$(".xterm-helper-textarea");
  await terminalInput.waitForExist();
  await terminalInput.addValue(text);
}

export async function sendTerminalCommand(command: string): Promise<void> {
  await sendTerminalText(command);
  await browser.keys("Enter");
}
