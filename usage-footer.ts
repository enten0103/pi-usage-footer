/**
 * Usage footer — a pi extension.
 *
 * Shows the active provider's quota/balance inline in the footer stats line
 * (same line as token/context stats), only while a supported model is selected:
 *
 *   kimi-coding  ->  Kimi 5h 0% · 7d 99%
 *   deepseek     ->  DeepSeek ¥110.00
 *
 * Credentials come from pi's own logins via `ctx.modelRegistry.getProviderAuth(id)`,
 * which resolves API keys / refreshes OAuth tokens under pi's credential lock. The
 * extension never reads or writes `auth.json` and needs no `crossusage-cli`.
 *
 * Refresh policy: every 2 minutes, immediately on model change / session start, and
 * once an agent settles (end of a conversation) via `agent_settled`.
 *
 * Why a custom footer? `ctx.ui.setStatus()` always renders extension statuses on
 * their own line below the default footer. To show usage on the same line as the
 * token/context stats, the extension replaces the footer via `ctx.ui.setFooter()`
 * and re-renders the built-in layout with the usage segment inserted. On unsupported
 * models the default footer is restored.
 *
 * Usage: drop in `~/.pi/agent/extensions/usage-footer.ts` (auto-discovered).
 * Optional command: `/usage` to refresh and show details (Kimi reset times / balances).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const KIMI_PROVIDER = "kimi-coding";
const DEEPSEEK_PROVIDER = "deepseek";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const STATUS_KEY = "usage-footer";
const POLL_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

type Segment = { text: string; color: "error" | "warning" | "text"; detail?: string };

type ProviderSpec = {
	id: string;
	label: string;
	matches: (model: { provider?: string; id?: string } | undefined) => boolean;
	load: (ctx: ExtensionContext) => Promise<Segment>;
};

let pollTimer: ReturnType<typeof setInterval> | undefined;
let activeCtx: ExtensionContext | undefined;
let activeSpec: ProviderSpec | undefined;
let segment: Segment | undefined;
let lastError: string | undefined;
let inFlight = false;
let requestSeq = 0;
let footerInstalled = false;
let footerTui: { requestRender(immediate?: boolean): void } | undefined;

// ---------------------------------------------------------------- shared helpers

function num(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function providerMatches(model: { provider?: string } | undefined, id: string): boolean {
	return String(model?.provider ?? "").toLowerCase() === id;
}

function authHeaders(resolved: { auth?: { apiKey?: string; headers?: unknown } } | undefined): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "pi-usage-footer" };
	const extra = resolved?.auth?.headers as Record<string, unknown> | undefined;
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (typeof value === "string") headers[key] = value;
		}
	}
	if (!headers.Authorization && resolved?.auth?.apiKey) {
		headers.Authorization = `Bearer ${resolved.auth.apiKey}`;
	}
	return headers;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	if (!headers.Authorization) throw new Error("not logged in");
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

// ------------------------------------------------------------------- Kimi quota

type Quota = {
	label: string;
	percent: number;
	used: number;
	limit: number;
	remaining: number;
	resetsAt?: string;
};

function windowSeconds(window: unknown): number | null {
	const w = window as { duration?: unknown; timeUnit?: unknown } | undefined;
	const duration = num(w?.duration);
	if (duration === null || duration <= 0) return null;
	const unit = String(w?.timeUnit ?? "").toUpperCase();
	if (unit.includes("MINUTE")) return duration * 60;
	if (unit.includes("HOUR")) return duration * 3600;
	if (unit.includes("DAY")) return duration * 86400;
	if (unit.includes("SECOND")) return duration;
	return null;
}

function windowLabel(seconds: number | null): string {
	if (seconds === null) return "Session";
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function makeQuota(label: string, limit: unknown, remaining: unknown, resetsAt: unknown): Quota | null {
	const max = num(limit);
	const left = num(remaining);
	if (max === null || left === null || max <= 0) return null;
	const used = Math.max(0, max - left);
	return {
		label,
		percent: (used / max) * 100,
		used,
		limit: max,
		remaining: Math.max(0, left),
		resetsAt: typeof resetsAt === "string" && resetsAt ? resetsAt : undefined,
	};
}

function parseKimiUsage(data: unknown): Quota[] {
	const payload = (data ?? {}) as {
		usage?: { limit?: unknown; remaining?: unknown; resetTime?: unknown; reset_at?: unknown };
		limits?: Array<{ window?: unknown; detail?: Record<string, unknown> }>;
	};

	const quotas: Quota[] = [];
	const windows: Array<{ seconds: number | null; quota: Quota }> = [];

	for (const item of Array.isArray(payload.limits) ? payload.limits : []) {
		const detail = item?.detail && typeof item.detail === "object" ? item.detail : (item as Record<string, unknown>);
		const seconds = windowSeconds(item?.window);
		const quota = makeQuota(windowLabel(seconds), detail?.limit, detail?.remaining, detail?.resetTime ?? detail?.reset_at);
		if (quota) windows.push({ seconds, quota });
	}

	// Session = the shortest window.
	let session: { seconds: number | null; quota: Quota } | undefined;
	for (const candidate of windows) {
		if (!session || (candidate.seconds !== null && (session.seconds === null || candidate.seconds < session.seconds))) {
			session = candidate;
		}
	}
	if (session) quotas.push(session.quota);

	// Weekly = top-level `usage`; fall back to the longest non-session window.
	const usage = payload.usage;
	let weekly = usage ? makeQuota("7d", usage.limit, usage.remaining, usage.resetTime ?? usage.reset_at) : null;
	if (!weekly) {
		let longest: { seconds: number | null; quota: Quota } | undefined;
		for (const candidate of windows) {
			if (candidate === session) continue;
			const a = candidate.seconds ?? -1;
			const b = longest?.seconds ?? -1;
			if (!longest || a > b) longest = candidate;
		}
		if (longest) weekly = longest.quota;
	}
	if (weekly && !(session && sameWindow(session.quota, weekly))) quotas.push(weekly);

	return quotas;
}

function sameWindow(a: Quota, b: Quota): boolean {
	return a.used === b.used && a.limit === b.limit && (a.resetsAt ?? "") === (b.resetsAt ?? "");
}

function resetText(iso: string | undefined): string {
	if (!iso) return "";
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const diff = at - Date.now();
	if (diff <= 0) return "resets now";
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
	return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function percentColor(percent: number): "error" | "warning" | "text" {
	if (percent >= 90) return "error";
	if (percent >= 75) return "warning";
	return "text";
}

async function loadKimi(ctx: ExtensionContext): Promise<Segment> {
	const resolved = await ctx.modelRegistry.getProviderAuth(KIMI_PROVIDER);
	const headers = authHeaders(resolved);
	if (!headers.Authorization) throw new Error("not logged in — /login kimi-coding");
	const quotas = parseKimiUsage(await getJson(KIMI_USAGE_URL, headers));
	if (quotas.length === 0) throw new Error("no quota windows in response");
	const body = quotas.map((quota) => `${quota.label} ${Math.round(quota.percent)}%`).join(" · ");
	const worst = quotas.reduce((max, quota) => Math.max(max, quota.percent), 0);
	const detail = quotas
		.map((quota) => {
			const reset = resetText(quota.resetsAt);
			const left = `${Math.round(quota.remaining)}/${Math.round(quota.limit)} left`;
			return `Kimi ${quota.label}: ${Math.round(quota.percent)}% used (${left})${reset ? ` · ${reset}` : ""}`;
		})
		.join("\n");
	return { text: `Kimi ${body}`, color: percentColor(worst), detail };
}

// --------------------------------------------------------------- DeepSeek balance

function pickBalance(infos: unknown): { currency: string; total: number; granted?: number; toppedUp?: number } | null {
	if (!Array.isArray(infos)) return null;
	let fallback: { currency: string; total: number; granted?: number; toppedUp?: number } | null = null;
	let cny: { currency: string; total: number; granted?: number; toppedUp?: number } | null = null;
	for (const raw of infos) {
		const info = raw as { currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown };
		const total = num(info?.total_balance);
		if (total === null) continue;
		const currency = typeof info?.currency === "string" && info.currency ? info.currency : "USD";
		const entry = {
			currency,
			total,
			granted: num(info?.granted_balance) ?? undefined,
			toppedUp: num(info?.topped_up_balance) ?? undefined,
		};
		if (!fallback) fallback = entry;
		if (currency === "USD") return entry;
		if (currency === "CNY") cny = entry;
	}
	return cny ?? fallback;
}

function currencySymbol(currency: string): string {
	if (currency === "USD") return "$";
	if (currency === "CNY") return "¥";
	if (currency === "EUR") return "€";
	return `${currency} `;
}

async function loadDeepSeek(ctx: ExtensionContext): Promise<Segment> {
	const resolved = await ctx.modelRegistry.getProviderAuth(DEEPSEEK_PROVIDER);
	const headers = authHeaders(resolved);
	if (!headers.Authorization) throw new Error("no API key — /login deepseek");
	const data = (await getJson(DEEPSEEK_BALANCE_URL, headers)) as { is_available?: unknown; balance_infos?: unknown };
	const balance = pickBalance(data?.balance_infos);
	if (!balance) throw new Error("no balance in response");
	const available = data?.is_available !== false && balance.total > 0;
	const symbol = currencySymbol(balance.currency);
	const parts: string[] = [];
	if (typeof balance.granted === "number") parts.push(`granted ${symbol}${balance.granted.toFixed(2)}`);
	if (typeof balance.toppedUp === "number") parts.push(`topped up ${symbol}${balance.toppedUp.toFixed(2)}`);
	return {
		text: `DeepSeek ${symbol}${balance.total.toFixed(2)}`,
		color: available ? "text" : "error",
		detail: `DeepSeek balance: ${symbol}${balance.total.toFixed(2)}${parts.length > 0 ? ` (${parts.join(" · ")})` : ""}`,
	};
}

// --------------------------------------------------------------------- registry

const PROVIDERS: ProviderSpec[] = [
	{
		id: KIMI_PROVIDER,
		label: "Kimi",
		matches: (model) => providerMatches(model, KIMI_PROVIDER),
		load: loadKimi,
	},
	{
		id: DEEPSEEK_PROVIDER,
		label: "DeepSeek",
		matches: (model) => providerMatches(model, DEEPSEEK_PROVIDER),
		load: loadDeepSeek,
	},
];

function specFor(model: { provider?: string; id?: string } | undefined): ProviderSpec | undefined {
	return PROVIDERS.find((spec) => spec.matches(model));
}

// --------------------------------------------------- footer (built-in layout + usage inline)

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

function addUsage(totals: Totals, usage: unknown): void {
	const u = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } } | undefined;
	if (!u) return;
	totals.input += num(u.input) ?? 0;
	totals.output += num(u.output) ?? 0;
	totals.cacheRead += num(u.cacheRead) ?? 0;
	totals.cacheWrite += num(u.cacheWrite) ?? 0;
	totals.cost += num(u.cost?.total) ?? 0;
}

function formatTokens(count: number): string {
	if (count < 1e3) return String(count);
	if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
	if (count < 1e6) return `${Math.round(count / 1e3)}k`;
	if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
	return `${Math.round(count / 1e6)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	if (rel === "") return "~";
	if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return `~${sep}${rel}`;
	return cwd;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function usageSegment(theme: { fg(color: string, text: string): string }): string | null {
	if (!activeSpec) return null;
	if (lastError) return theme.fg("warning", `${activeSpec.label} ${lastError}`);
	if (!segment) return theme.fg("dim", `${activeSpec.label} …`);
	return theme.fg(segment.color, segment.text);
}

function renderFooter(
	ctx: ExtensionContext,
	width: number,
	theme: { fg(color: string, text: string): string },
	footerData: {
		getGitBranch(): string | null;
		getAvailableProviderCount(): number;
		getExtensionStatuses(): ReadonlyMap<string, string>;
	},
): string[] {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const usage = (entry.message as { usage?: Record<string, unknown> }).usage;
			addUsage(totals, usage);
			const promptTokens = (num(usage?.input) ?? 0) + (num(usage?.cacheRead) ?? 0) + (num(usage?.cacheWrite) ?? 0);
			latestCacheHitRate = promptTokens > 0 ? ((num(usage?.cacheRead) ?? 0) / promptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.usage) {
			addUsage(totals, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && (entry as { usage?: unknown }).usage) {
			addUsage(totals, (entry as { usage?: unknown }).usage);
		}
	}

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

	let cwdLine = formatCwdForFooter(ctx.cwd, process.env.HOME || process.env.USERPROFILE);
	const branch = footerData.getGitBranch();
	if (branch) cwdLine += ` (${branch})`;
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) cwdLine += ` • ${sessionName}`;

	const parts: string[] = [];
	if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
		parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	const usingSubscription = ctx.model?.provider === KIMI_PROVIDER;
	if (totals.cost > 0 || usingSubscription) {
		parts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}
	const contextDisplay = contextPercent === "?" ? `?/${formatTokens(contextWindow)}` : `${contextPercent}%/${formatTokens(contextWindow)}`;
	parts.push(
		contextPercentValue > 90
			? theme.fg("error", contextDisplay)
			: contextPercentValue > 70
				? theme.fg("warning", contextDisplay)
				: contextDisplay,
	);
	const usage = usageSegment(theme);
	if (usage) parts.push(usage);

	const statsLeft = parts.join(" ");
	const statsLeftWidth = visibleWidth(statsLeft);
	const modelName = ctx.model?.id || "no-model";
	let rightSideWithoutProvider = modelName;
	if (ctx.model?.reasoning) {
		const level = ctx.thinkingLevel || "off";
		rightSideWithoutProvider = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
	}
	let rightSide = rightSideWithoutProvider;
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const withProvider = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
		if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
	}

	const rightSideWidth = visibleWidth(rightSide);
	const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
	let statsLine: string;
	if (totalNeeded <= width) {
		statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - 2;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
		} else {
			statsLine = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));
		}
	}

	const lines = [
		truncateToWidth(theme.fg("dim", cwdLine), width, theme.fg("dim", "...")),
		theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
	];

	const statuses = footerData.getExtensionStatuses();
	if (statuses.size > 0) {
		const statusLine = [...statuses.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
	}
	return lines;
}

// ---------------------------------------------------------------- footer lifecycle

function applyFooter(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (!specFor(ctx.model)) {
		if (footerInstalled) {
			ctx.ui.setFooter(undefined);
			footerInstalled = false;
			footerTui = undefined;
		}
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	if (!footerInstalled) {
		footerInstalled = true;
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerTui = tui;
			const unsubscribe = footerData.onBranchChange(() => footerTui?.requestRender());
			return {
				dispose: () => {
					unsubscribe();
					footerTui = undefined;
				},
				invalidate() {},
				render: (width: number) => renderFooter(ctx, width, theme, footerData),
			};
		});
	}
	footerTui?.requestRender();
}

// ---------------------------------------------------------------- data fetching

async function refresh(ctx: ExtensionContext): Promise<void> {
	const spec = specFor(ctx.model);
	if (!spec) return;
	if (inFlight) return;
	const seq = ++requestSeq;
	inFlight = true;
	try {
		const result = await spec.load(ctx);
		if (seq !== requestSeq) return;
		segment = result;
		lastError = undefined;
	} catch (error) {
		if (seq !== requestSeq) return;
		segment = undefined;
		lastError = error instanceof Error ? error.message : String(error);
	} finally {
		if (seq === requestSeq) inFlight = false;
		footerTui?.requestRender();
	}
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
}

function startFor(ctx: ExtensionContext): void {
	activeCtx = ctx;
	stopPolling();
	const spec = specFor(ctx.model);
	if (!spec) {
		activeSpec = undefined;
		segment = undefined;
		lastError = undefined;
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		footerInstalled = false;
		footerTui = undefined;
		return;
	}
	activeSpec = spec;
	footerInstalled = false; // re-install with the current ctx
	segment = undefined;
	lastError = undefined;
	requestSeq++;
	inFlight = false;
	applyFooter(ctx);
	void refresh(ctx);
	pollTimer = setInterval(() => {
		if (activeCtx) void refresh(activeCtx);
	}, POLL_MS);
	// Do not keep pi alive just for the poller.
	(pollTimer as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------- extension entry

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		startFor(ctx);
	});

	// Fires on /model, Ctrl+P cycling and session restore.
	pi.on("model_select", async (_event, ctx) => {
		startFor(ctx);
	});

	// Refresh once the conversation has fully settled (no retry/compaction/queued follow-up left).
	pi.on("agent_settled", async (_event, ctx) => {
		void refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		activeCtx = undefined;
		activeSpec = undefined;
		footerInstalled = false;
		footerTui = undefined;
	});

	pi.registerCommand("usage", {
		description: "Refresh and show the active provider's quota/balance",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			const spec = specFor(ctx.model);
			if (!spec) {
				ctx.ui.notify("No usage source for the active model", "warning");
				return;
			}
			if (lastError) {
				ctx.ui.notify(`${spec.label}: ${lastError}`, "warning");
				return;
			}
			if (!segment) {
				ctx.ui.notify(`${spec.label} usage unavailable`, "warning");
				return;
			}
			ctx.ui.notify(segment.detail ?? segment.text, "info");
		},
	});
}
