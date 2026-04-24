import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type TtsMode = "off" | "auto" | "manual";
type SpeakKind = "summary" | "warning" | "next_step" | "status";

interface TtsState {
	mode: TtsMode;
	voice?: string;
}

interface AllTalkConfig {
	baseUrl: string;
	speakPath: string;
	stopPath?: string;
	textField: string;
	voiceField?: string;
	defaultVoice?: string;
	extraBody?: Record<string, unknown>;
	stopBody?: Record<string, unknown>;
	headers?: Record<string, string>;
	charLimit: number;
	dedupeWindowMs: number;
}

interface SpeakResult {
	queued: boolean;
	message: string;
	text?: string;
	kind?: SpeakKind;
	deduped?: boolean;
	endpoint?: string;
}

const TOOL_NAME = "speak";
const STATE_TYPE = "alltalk-tts-config";
const DEFAULT_MODE: TtsMode = "off";
const DEFAULT_VOICE = undefined;

function parseJsonEnv<T>(name: string): T | undefined {
	const value = process.env[name];
	if (!value) return undefined;
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		console.error(`[alltalk-tts] Failed to parse ${name}:`, error);
		return undefined;
	}
}

function normalizePath(path: string | undefined, fallback: string): string {
	const value = (path ?? fallback).trim();
	if (!value) return fallback;
	return value.startsWith("/") ? value : `/${value}`;
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/$/, "")}${normalizePath(path, "/")}`;
}

function loadConfig(cwd: string): AllTalkConfig {
	const configPath = join(cwd, ".pi", "alltalk-tts.json");
	let fileConfig: Partial<AllTalkConfig> = {};

	if (existsSync(configPath)) {
		try {
			fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as Partial<AllTalkConfig>;
		} catch (error) {
			console.error(`[alltalk-tts] Failed to parse ${configPath}:`, error);
		}
	}

	const envConfig: Partial<AllTalkConfig> = {
		baseUrl: process.env.ALLTALK_TTS_BASE_URL,
		speakPath: process.env.ALLTALK_TTS_SPEAK_PATH,
		stopPath: process.env.ALLTALK_TTS_STOP_PATH,
		textField: process.env.ALLTALK_TTS_TEXT_FIELD,
		voiceField: process.env.ALLTALK_TTS_VOICE_FIELD,
		defaultVoice: process.env.ALLTALK_TTS_DEFAULT_VOICE,
		extraBody: parseJsonEnv<Record<string, unknown>>("ALLTALK_TTS_EXTRA_BODY_JSON"),
		stopBody: parseJsonEnv<Record<string, unknown>>("ALLTALK_TTS_STOP_BODY_JSON"),
		headers: parseJsonEnv<Record<string, string>>("ALLTALK_TTS_HEADERS_JSON"),
		charLimit: process.env.ALLTALK_TTS_CHAR_LIMIT ? Number(process.env.ALLTALK_TTS_CHAR_LIMIT) : undefined,
		dedupeWindowMs: process.env.ALLTALK_TTS_DEDUPE_WINDOW_MS ? Number(process.env.ALLTALK_TTS_DEDUPE_WINDOW_MS) : undefined,
	};

	const merged = {
		baseUrl: "http://localhost:7851",
		speakPath: "/api/tts-generate",
		stopPath: "/api/stop-generation",
		textField: "text",
		voiceField: "voice",
		defaultVoice: DEFAULT_VOICE,
		extraBody: {},
		stopBody: {},
		headers: {},
		charLimit: 200,
		dedupeWindowMs: 10_000,
		...fileConfig,
		...Object.fromEntries(Object.entries(envConfig).filter(([, value]) => value !== undefined)),
	} satisfies AllTalkConfig;

	return {
		...merged,
		speakPath: normalizePath(merged.speakPath, "/api/tts-generate"),
		stopPath: merged.stopPath ? normalizePath(merged.stopPath, "/api/stop-generation") : undefined,
		textField: merged.textField?.trim() || "text",
		voiceField: merged.voiceField?.trim() || undefined,
		charLimit: Number.isFinite(merged.charLimit) && merged.charLimit > 0 ? merged.charLimit : 200,
		dedupeWindowMs: Number.isFinite(merged.dedupeWindowMs) && merged.dedupeWindowMs >= 0 ? merged.dedupeWindowMs : 10_000,
	};
}

function sanitizeSpokenText(text: string, charLimit: number): string {
	const cleaned = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (!cleaned) return "";
	if (cleaned.length <= charLimit) return cleaned;
	return `${cleaned.slice(0, Math.max(0, charLimit - 1)).trimEnd()}…`;
}

function parseMode(value: string | undefined): TtsMode | undefined {
	if (!value) return undefined;
	if (value === "on") return "auto";
	if (value === "off" || value === "auto" || value === "manual") return value;
	return undefined;
}

function readLatestState(ctx: ExtensionContext): TtsState {
	let restored: TtsState = { mode: DEFAULT_MODE, voice: DEFAULT_VOICE };

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STATE_TYPE) {
			const data = entry.data as Partial<TtsState> | undefined;
			const mode = parseMode(data?.mode);
			restored = {
				mode: mode ?? DEFAULT_MODE,
				voice: typeof data?.voice === "string" && data.voice.trim() ? data.voice.trim() : undefined,
			};
		}
	}

	return restored;
}

function setStatus(ctx: ExtensionContext, state: TtsState) {
	const suffix = state.voice ? ` (${state.voice})` : "";
	ctx.ui.setStatus("alltalk-tts", `TTS: ${state.mode}${suffix}`);
}

export default function alltalkTtsExtension(pi: ExtensionAPI) {
	let state: TtsState = { mode: DEFAULT_MODE, voice: DEFAULT_VOICE };
	let config: AllTalkConfig = loadConfig(process.cwd());
	let lastSpoken = { text: "", at: 0 };

	function refreshConfig(ctx?: ExtensionContext) {
		config = loadConfig(ctx?.cwd ?? process.cwd());
	}

	function persistState() {
		pi.appendEntry<TtsState>(STATE_TYPE, { ...state });
	}

	function syncToolActivation() {
		const activeTools = new Set(pi.getActiveTools());
		if (state.mode === "auto") {
			activeTools.add(TOOL_NAME);
		} else {
			activeTools.delete(TOOL_NAME);
		}
		pi.setActiveTools(Array.from(activeTools));
	}

	function applyState(ctx: ExtensionContext) {
		refreshConfig(ctx);
		syncToolActivation();
		setStatus(ctx, state);
	}

	function buildSpeakBody(text: string) {
		const body: Record<string, unknown> = {
			...(config.extraBody ?? {}),
			[config.textField]: text,
		};

		const voice = state.voice ?? config.defaultVoice;
		if (voice && config.voiceField) {
			body[config.voiceField] = voice;
		}

		return body;
	}

	function notifyAsyncFailure(ctx: ExtensionContext, message: string) {
		if (ctx.hasUI) {
			ctx.ui.notify(message, "error");
		} else {
			console.error(`[alltalk-tts] ${message}`);
		}
	}

	function shouldDedupe(text: string): boolean {
		if (!text) return false;
		if (config.dedupeWindowMs <= 0) return false;
		return text === lastSpoken.text && Date.now() - lastSpoken.at < config.dedupeWindowMs;
	}

	function remember(text: string) {
		lastSpoken = { text, at: Date.now() };
	}

	function queueSpeech(ctx: ExtensionContext, text: string, kind: SpeakKind, force = false): SpeakResult {
		refreshConfig(ctx);

		if (!config.baseUrl?.trim()) {
			throw new Error("AllTalk TTS is not configured: missing baseUrl");
		}

		const spokenText = sanitizeSpokenText(text, config.charLimit);
		if (!spokenText) {
			return {
				queued: false,
				message: "Skipped speech: text was empty after sanitization.",
			};
		}

		if (!force && state.mode !== "auto") {
			return {
				queued: false,
				message: `Skipped speech: TTS mode is ${state.mode}.`,
				text: spokenText,
				kind,
			};
		}

		if (shouldDedupe(spokenText)) {
			return {
				queued: false,
				message: "Skipped duplicate speech.",
				text: spokenText,
				kind,
				deduped: true,
			};
		}

		const url = joinUrl(config.baseUrl, config.speakPath);
		const body = buildSpeakBody(spokenText);
		remember(spokenText);

		void fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(config.headers ?? {}),
			},
			body: JSON.stringify(body),
		})
			.then(async (response) => {
				if (response.ok) return;
				const detail = (await response.text()).slice(0, 300).trim();
				notifyAsyncFailure(
					ctx,
					`AllTalk speak failed (${response.status}${detail ? `: ${detail}` : ""})`,
				);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				notifyAsyncFailure(ctx, `AllTalk speak failed: ${message}`);
			});

		return {
			queued: true,
			message: `Queued speech (${kind}).`,
			text: spokenText,
			kind,
			endpoint: url,
		};
	}

	async function stopSpeech(ctx: ExtensionContext): Promise<string> {
		refreshConfig(ctx);
		if (!config.stopPath) {
			return "No stop endpoint configured.";
		}

		const url = joinUrl(config.baseUrl, config.stopPath);
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(config.headers ?? {}),
			},
			body: JSON.stringify(config.stopBody ?? {}),
			signal: ctx.signal,
		});

		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300).trim();
			throw new Error(`Stop failed (${response.status}${detail ? `: ${detail}` : ""})`);
		}

		return "Requested TTS stop.";
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Speak",
		description: "Play brief spoken narration through AllTalk TTS. Use only for short summaries, warnings, status updates, or next steps. Never send code, logs, stack traces, or reasoning.",
		promptSnippet: "Play short spoken narration that complements the written response via AllTalk TTS",
		promptGuidelines: [
			"Use speak only for brief spoken narration that complements the written response.",
			"Use speak for meaningful conclusions, warnings, status updates, or next steps, not for code, stack traces, raw logs, long lists, or chain-of-thought.",
			"When using speak, keep the text to 1-2 sentences, avoid markdown/code formatting, and point the user back to the written response for exact details.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "Brief spoken narration for the user. Keep it short and user-facing." }),
			kind: Type.Optional(StringEnum(["summary", "warning", "next_step", "status"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = queueSpeech(ctx, params.text, params.kind ?? "summary");
			return {
				content: [{ type: "text", text: result.message }],
				details: result,
			};
		},
	});

	pi.registerCommand("tts", {
		description: "Control AllTalk TTS: /tts on|off|mode <auto|manual|off>|test|stop|status|reload",
		handler: async (args, ctx) => {
			const [commandRaw, valueRaw] = args.trim().split(/\s+/, 2);
			const command = (commandRaw || "status").toLowerCase();
			const value = valueRaw?.toLowerCase();

			switch (command) {
				case "on": {
					state.mode = "auto";
					persistState();
					applyState(ctx);
					ctx.ui.notify("AllTalk TTS enabled (auto).", "info");
					return;
				}
				case "off": {
					state.mode = "off";
					persistState();
					applyState(ctx);
					ctx.ui.notify("AllTalk TTS disabled.", "info");
					return;
				}
				case "mode": {
					const mode = parseMode(value);
					if (!mode) {
						ctx.ui.notify("Usage: /tts mode <auto|manual|off>", "warning");
						return;
					}
					state.mode = mode;
					persistState();
					applyState(ctx);
					ctx.ui.notify(`AllTalk TTS mode: ${mode}`, "info");
					return;
				}
				case "voice": {
					const voice = valueRaw?.trim();
					state.voice = voice ? voice : undefined;
					persistState();
					applyState(ctx);
					ctx.ui.notify(state.voice ? `AllTalk TTS voice: ${state.voice}` : "Cleared TTS voice override.", "info");
					return;
				}
				case "test": {
					const result = queueSpeech(
						ctx,
						"Audio test. I have written the detailed response in text above.",
						"status",
						true,
					);
					ctx.ui.notify(result.message, "info");
					return;
				}
				case "stop": {
					const message = await stopSpeech(ctx);
					ctx.ui.notify(message, "info");
					return;
				}
				case "reload": {
					refreshConfig(ctx);
					applyState(ctx);
					ctx.ui.notify(`Reloaded AllTalk config from ${join(ctx.cwd, ".pi", "alltalk-tts.json")}`, "info");
					return;
				}
				case "status":
				default: {
					refreshConfig(ctx);
					const summary = [
						`mode=${state.mode}`,
						`voice=${state.voice ?? config.defaultVoice ?? "default"}`,
						`baseUrl=${config.baseUrl}`,
						`speakPath=${config.speakPath}`,
						`stopPath=${config.stopPath ?? "(none)"}`,
					].join(" | ");
					ctx.ui.notify(summary, "info");
					return;
				}
			}
		},
	});

	pi.registerCommand("say", {
		description: "Speak text immediately via AllTalk TTS: /say <text>",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /say <text>", "warning");
				return;
			}

			const result = queueSpeech(ctx, text, "summary", true);
			ctx.ui.notify(result.message, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state = readLatestState(ctx);
		applyState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		state = readLatestState(ctx);
		applyState(ctx);
	});
}
