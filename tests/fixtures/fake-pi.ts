// Minimal stand-in for `pi --mode rpc`, used by tests/pi-client.test.ts.
// Echoes each command back as a response; "slow" commands emit an event
// carrying the request id first; "exit" terminates without responding.
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx: number;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const cmd = JSON.parse(buffer.slice(0, idx));
    buffer = buffer.slice(idx + 1);
    if (cmd.type === "exit") process.exit(3);
    if (cmd.type === "hang") continue;
    if (cmd.type === "bash") {
      process.stdout.write(JSON.stringify({ type: "bash_execution_update", id: cmd.id, delta: "x" }) + "\n");
    }
    process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data: { echo: cmd } }) + "\n");
  }
});
