import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

export async function reserveLoopbackPort() {
  const reservation = createServer();
  reservation.unref();
  reservation.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") {
    reservation.close();
    throw new Error("Could not reserve an ephemeral loopback port.");
  }
  const port = address.port;
  reservation.close();
  await once(reservation, "close");
  return port;
}

export function createLocalServerNonce() {
  return randomBytes(24).toString("hex");
}

export function startProductionServer(root, port, nonce) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid production server port: ${port}`);
  }
  return spawn("pnpm", ["exec", "next", "start", "-H", LOOPBACK_HOST, "-p", String(port)], {
    cwd: root,
    env: { ...process.env, PORT: String(port), VH_LOCAL_SERVER_NONCE: nonce },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function collectBoundedOutput(child, limit = 16_000) {
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (output.length > limit) output = output.slice(-limit);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

export function isAddressInUseOutput(output) {
  return /\bEADDRINUSE\b|address already in use/iu.test(output);
}

export async function waitForOwnedHttpReady(url, child, nonce, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Production server exited before becoming ready (exit ${child.exitCode}, signal ${child.signalCode}).`,
      );
    }
    try {
      const challenge = randomBytes(24).toString("hex");
      const response = await fetch(`${url}/api/health`, {
        redirect: "manual",
        headers: { "x-vh-local-server-challenge": challenge },
      });
      if (response.ok) {
        const body = await response.json();
        const expectedProof = createHmac("sha256", nonce).update(challenge).digest("hex");
        if (body?.ready === true && body?.proof === expectedProof) return;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Production server did not become ready within ${timeoutMs}ms.`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function stopProductionServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 5_000);
}

export async function startOwnedProductionServer(root, options = {}) {
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error(`Invalid production server start-attempt limit: ${attempts}`);
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await reserveLoopbackPort();
    const nonce = createLocalServerNonce();
    const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
    const server = startProductionServer(root, port, nonce);
    const serverOutput = collectBoundedOutput(server);
    try {
      await waitForOwnedHttpReady(baseUrl, server, nonce, options.timeoutMs);
      return { baseUrl, nonce, port, server, serverOutput };
    } catch (error) {
      await stopProductionServer(server);
      const output = serverOutput();
      lastError = new Error(`${String(error)}\n${output}`.trim());
      if (attempt === attempts || !isAddressInUseOutput(output)) throw lastError;
    }
  }
  throw lastError ?? new Error("Production server could not be started.");
}

export async function runInherited(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: "inherit",
  });
  const [code, signal] = await once(child, "exit");
  if (signal) return 1;
  return typeof code === "number" ? code : 1;
}

export const LOCAL_PRODUCTION_HOST = LOOPBACK_HOST;
