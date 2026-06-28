import { chmodSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// pi-ai ships the OpenAI Codex OAuth flow but no persistent credential store,
// so we own storage: a JSON file at ~/.dwim/auth.json holding the rotating
// access/refresh tokens. The oauth module is imported lazily so the overlay's
// hot path (which only needs isLoggedIn) never pulls in node:http/crypto.
const DIR = join(Bun.env.HOME ?? ".", ".dwim");
const AUTH_PATH = join(DIR, "auth.json");
const PROVIDER = "openai-codex";

export type CodexCreds = {
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
	[key: string]: unknown;
};

async function loadCreds(): Promise<CodexCreds | null> {
	try {
		return (await Bun.file(AUTH_PATH).json()) as CodexCreds;
	} catch {
		return null;
	}
}

async function saveCreds(creds: CodexCreds) {
	await mkdir(DIR, { recursive: true });
	await Bun.write(AUTH_PATH, JSON.stringify(creds, null, 2));
	try {
		chmodSync(AUTH_PATH, 0o600);
	} catch {}
}

export async function isLoggedIn(): Promise<boolean> {
	return await Bun.file(AUTH_PATH).exists();
}

// Returns a valid access token, transparently refreshing (and re-persisting the
// rotated refresh token) when the stored one has expired. Null if not signed in.
export async function getCodexToken(): Promise<string | null> {
	const creds = await loadCreds();
	if (!creds) return null;
	const { getOAuthApiKey } = await import("@earendil-works/pi-ai/oauth");
	const result = await getOAuthApiKey(PROVIDER, { [PROVIDER]: creds });
	if (!result) return null;
	const fresh = result.newCredentials?.[PROVIDER] as CodexCreds | undefined;
	if (fresh?.access) await saveCreds(fresh);
	return result.apiKey;
}

export async function runLogin() {
	const { loginOpenAICodex } = await import("@earendil-works/pi-ai/oauth");
	console.log("dwim: signing in to OpenAI Codex…");
	try {
		const creds = (await loginOpenAICodex({
			onAuth: ({ url }: { url: string }) => {
				console.log(`\nIf your browser didn't open, visit:\n${url}\n`);
				openBrowser(url);
			},
			onPrompt: async () => {
				process.stdout.write(
					"Paste the code or redirect URL (or just wait for the browser): ",
				);
				for await (const line of console) return line.trim();
				return "";
			},
		})) as CodexCreds;
		await saveCreds(creds);
		console.log("dwim: logged in. Codex is now the default — run `dwim`.");
	} catch (error) {
		console.error(
			`dwim: login failed — ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}

export async function runLogout() {
	try {
		rmSync(AUTH_PATH, { force: true });
	} catch {}
	console.log("dwim: logged out of OpenAI Codex.");
}

function openBrowser(url: string) {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	try {
		Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
	} catch {}
}
