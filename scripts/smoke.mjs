import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const args = process.argv.slice(2);
const arg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};

if (args.includes("--help")) {
  console.log(`Wishly smoke test

Usage:
  npm run smoke -- [--url https://wishlyme.netlify.app] [--name "Your name"] [--send-reminder]

Without --name, the test prompts for the account name. The password is always hidden.
--send-reminder sends a real test email/push to the signed-in account.`);
  process.exit(0);
}

const base = new URL(arg("--url") || process.env.WISHLY_URL || "https://wishlyme.netlify.app");
if (!/^https?:$/.test(base.protocol) || base.search || base.hash) {
  throw new Error("Use a site URL such as https://wishlyme.netlify.app");
}
base.pathname = base.pathname.replace(/\/$/, "") || "/";

async function promptName() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return (await rl.question("Wishly account name: ")).trim(); }
  finally { rl.close(); }
}

function promptPassword() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Set WISHLY_TEST_PASSWORD in the environment when running non-interactively.");
  }
  return new Promise((resolve, reject) => {
    let password = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(password);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") return finish(new Error("Cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1);
        else password += character;
      }
    };
    stdout.write("Wishly password (hidden): ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

async function requireOk(path, options) {
  const result = await request(path, options);
  if (!result.response.ok || !result.data) {
    throw new Error(result.data?.error || `${path} returned HTTP ${result.response.status}`);
  }
  return result.data;
}

const checks = [];
const pass = (label, detail = "") => {
  checks.push(true);
  console.log(`PASS ${label}${detail ? `: ${detail}` : ""}`);
};

try {
  const name = arg("--name") || process.env.WISHLY_TEST_NAME || await promptName();
  const password = process.env.WISHLY_TEST_PASSWORD || await promptPassword();
  if (!name || !password) throw new Error("Account name and password are required.");

  const home = await fetch(base, { signal: AbortSignal.timeout(15000) });
  const html = await home.text();
  if (!home.ok || !html.includes("Wishly")) throw new Error(`Website check failed (HTTP ${home.status}).`);
  pass("Website loads", base.origin);

  const anonymous = await request("/api/me");
  if (anonymous.response.status !== 401) {
    throw new Error(`Unauthenticated API check expected HTTP 401, got ${anonymous.response.status}.`);
  }
  pass("API rejects unauthenticated requests");

  const login = await requireOk("/api/login", {
    method: "POST",
    body: { name, password, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
  if (!login.token) throw new Error("Login response did not include a session token.");
  pass("Account login accepted");

  const me = await requireOk("/api/me", { token: login.token });
  if (!Array.isArray(me.events)) throw new Error("Account data response did not include a dates list.");
  pass("Signed-in account data loads", `${me.events.length} existing date(s)`);

  const id = `smoke-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const testEvent = {
    id, type: "birthday", title: "Wishly smoke test", date: "2099-12-31",
    yearUnknown: true, time: "", repeat: "once", remind: [], notes: "Temporary automated smoke test",
  };
  let cleanupNeeded = false;
  try {
    cleanupNeeded = true;
    await requireOk("/api/events", { method: "PUT", token: login.token, body: { events: [...me.events, testEvent] } });
    const verified = await requireOk("/api/me", { token: login.token });
    if (!verified.events.some((event) => event.id === id)) throw new Error("Temporary date was not returned after saving.");
    pass("Per-user date save and read-back");
  } finally {
    if (cleanupNeeded) {
      const current = await requireOk("/api/me", { token: login.token });
      const remaining = current.events.filter((event) => event.id !== id);
      if (remaining.length !== current.events.length) {
        await requireOk("/api/events", { method: "PUT", token: login.token, body: { events: remaining } });
      }
    }
  }
  pass("Temporary test date cleaned up");

  console.log(`INFO Email service: ${me.mail ? "configured" : "not configured"}; account email: ${me.user?.email ? "set" : "not set"}`);
  console.log(`INFO Push service: ${me.push && me.vapidKey ? "configured" : "not configured"}; registered devices: ${me.user?.devices || 0}`);

  if (args.includes("--send-reminder")) {
    const result = await requireOk("/api/test-reminder", { method: "POST", token: login.token, body: {} });
    const channels = [["email", result.email], ["push", result.push]].filter(([, channel]) => channel);
    if (!channels.some(([, channel]) => channel.ok)) throw new Error("Test reminder did not succeed on any configured channel.");
    pass("Real test reminder accepted", channels.map(([name, channel]) => `${name} ${channel.ok ? "ok" : "failed"}`).join(", "));
  } else {
    console.log("INFO No real email or push was sent. Add --send-reminder to test delivery.");
  }

  console.log("\nSmoke test passed. This verifies the current Wishly password-login and API flow, not Firebase/Google sign-in.");
} catch (error) {
  console.error(`\nFAIL ${error.message}`);
  console.error("No password or token is printed. Review the message above, fix the configuration, then rerun the smoke test.");
  process.exitCode = 1;
}