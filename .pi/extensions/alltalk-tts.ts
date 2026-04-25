import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
	speakMethod: "POST" | "PUT";
	stopPath?: string;
	stopMethod: "POST" | "PUT";
	requestEncoding: "json" | "form";
	responseMode: "json_url" | "binary";
	binaryFileExtension: string;
	textField: string;
	voiceField?: string;
	defaultVoice?: string;
	extraBody?: Record<string, unknown>;
	stopBody?: Record<string, unknown>;
	headers?: Record<string, string>;
	charLimit: number;
	dedupeWindowMs: number;
	autoPlay: boolean;
	playerCommand: string;
	playerArgs: string[];
}

interface SpeakResult {
	queued: boolean;
	message: string;
	text?: string;
	kind?: SpeakKind;
	deduped?: boolean;
	endpoint?: string;
	playbackSource?: string;
}

interface AllTalkGenerateResponse {
	status?: string;
	output_file_path?: string;
	output_file_url?: string;
	output_cache_url?: string;
}

interface VoiceListResponse {
	voices?: string[];
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
		speakMethod: process.env.ALLTALK_TTS_SPEAK_METHOD as "POST" | "PUT" | undefined,
		stopPath: process.env.ALLTALK_TTS_STOP_PATH,
		stopMethod: process.env.ALLTALK_TTS_STOP_METHOD as "POST" | "PUT" | undefined,
		requestEncoding: process.env.ALLTALK_TTS_REQUEST_ENCODING as "json" | "form" | undefined,
		responseMode: process.env.ALLTALK_TTS_RESPONSE_MODE as "json_url" | "binary" | undefined,
		binaryFileExtension: process.env.ALLTALK_TTS_BINARY_FILE_EXTENSION,
		textField: process.env.ALLTALK_TTS_TEXT_FIELD,
		voiceField: process.env.ALLTALK_TTS_VOICE_FIELD,
		defaultVoice: process.env.ALLTALK_TTS_DEFAULT_VOICE,
		extraBody: parseJsonEnv<Record<string, unknown>>("ALLTALK_TTS_EXTRA_BODY_JSON"),
		stopBody: parseJsonEnv<Record<string, unknown>>("ALLTALK_TTS_STOP_BODY_JSON"),
		headers: parseJsonEnv<Record<string, string>>("ALLTALK_TTS_HEADERS_JSON"),
		charLimit: process.env.ALLTALK_TTS_CHAR_LIMIT ? Number(process.env.ALLTALK_TTS_CHAR_LIMIT) : undefined,
		dedupeWindowMs: process.env.ALLTALK_TTS_DEDUPE_WINDOW_MS ? Number(process.env.ALLTALK_TTS_DEDUPE_WINDOW_MS) : undefined,
		autoPlay: process.env.ALLTALK_TTS_AUTO_PLAY ? process.env.ALLTALK_TTS_AUTO_PLAY === "true" : undefined,
		playerCommand: process.env.ALLTALK_TTS_PLAYER_COMMAND,
		playerArgs: parseJsonEnv<string[]>("ALLTALK_TTS_PLAYER_ARGS_JSON"),
	};

	const merged = {
		baseUrl: "http://localhost:7851",
		speakPath: "/api/tts-generate",
		speakMethod: "POST",
		stopPath: "/api/stop-generation",
		stopMethod: "PUT",
		requestEncoding: "form",
		responseMode: "json_url",
		binaryFileExtension: "wav",
		textField: "text_input",
		voiceField: "narrator_voice_gen",
		defaultVoice: DEFAULT_VOICE,
		extraBody: {},
		stopBody: {},
		headers: {},
		charLimit: 200,
		dedupeWindowMs: 10_000,
		autoPlay: true,
		playerCommand: "ffplay",
		playerArgs: ["-nodisp", "-autoexit", "-loglevel", "error"],
		...fileConfig,
		...Object.fromEntries(Object.entries(envConfig).filter(([, value]) => value !== undefined)),
	} satisfies AllTalkConfig;

	return {
		...merged,
		speakPath: normalizePath(merged.speakPath, "/api/tts-generate"),
		stopPath: merged.stopPath ? normalizePath(merged.stopPath, "/api/stop-generation") : undefined,
		speakMethod: merged.speakMethod === "PUT" ? "PUT" : "POST",
		stopMethod: merged.stopMethod === "POST" ? "POST" : "PUT",
		requestEncoding: merged.requestEncoding === "json" ? "json" : "form",
		responseMode: merged.responseMode === "binary" ? "binary" : "json_url",
		binaryFileExtension: merged.binaryFileExtension?.trim() || "wav",
		textField: merged.textField?.trim() || "text_input",
		voiceField: merged.voiceField?.trim() || undefined,
		charLimit: Number.isFinite(merged.charLimit) && merged.charLimit > 0 ? merged.charLimit : 200,
		dedupeWindowMs: Number.isFinite(merged.dedupeWindowMs) && merged.dedupeWindowMs >= 0 ? merged.dedupeWindowMs : 10_000,
		autoPlay: merged.autoPlay !== false,
		playerCommand: merged.playerCommand?.trim() || "ffplay",
		playerArgs: Array.isArray(merged.playerArgs) ? merged.playerArgs.map(String) : ["-nodisp", "-autoexit", "-loglevel", "error"],
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
	let playerPid: number | undefined;

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

	function encodeFormBody(body: Record<string, unknown>): URLSearchParams {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(body)) {
			if (value === undefined || value === null) continue;
			params.set(key, String(value));
		}
		return params;
	}

	function buildRequestInit(body: Record<string, unknown>, method: "POST" | "PUT"): RequestInit {
		if (config.requestEncoding === "json") {
			return {
				method,
				headers: {
					"content-type": "application/json",
					...(config.headers ?? {}),
				},
				body: JSON.stringify(body),
			};
		}

		return {
			method,
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...(config.headers ?? {}),
			},
			body: encodeFormBody(body),
		};
	}

	function notifyAsyncFailure(ctx: ExtensionContext, message: string) {
		if (ctx.hasUI) {
			ctx.ui.notify(message, "error");
		} else {
			console.error(`[alltalk-tts] ${message}`);
		}
	}

	function stopLocalPlayer() {
		if (!playerPid) return;
		try {
			process.kill(playerPid, "SIGTERM");
		} catch {
			// ignore stale pid
		}
		playerPid = undefined;
	}

	function resolvePlaybackSource(payload: AllTalkGenerateResponse): string | undefined {
		const remotePath = payload.output_file_url ?? payload.output_cache_url;
		if (typeof remotePath === "string" && remotePath.trim()) {
			if (/^https?:\/\//.test(remotePath)) return remotePath;
			return joinUrl(config.baseUrl, remotePath);
		}
		if (typeof payload.output_file_path === "string" && payload.output_file_path.trim()) {
			return payload.output_file_path;
		}
		return undefined;
	}

	async function fetchAvailableVoices(): Promise<string[]> {
		const response = await fetch(joinUrl(config.baseUrl, "/v1/audio/voices"), {
			headers: { ...(config.headers ?? {}) },
		});
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300).trim();
			throw new Error(`Voice list failed (${response.status}${detail ? `: ${detail}` : ""})`);
		}
		const payload = (await response.json()) as VoiceListResponse;
		return Array.isArray(payload.voices) ? payload.voices.map(String).sort() : [];
	}

	function createTempAudioFile(data: Uint8Array): string {
		const ext = config.binaryFileExtension.replace(/^\./, "") || "wav";
		const filePath = join(tmpdir(), `pi-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
		writeFileSync(filePath, data);
		return filePath;
	}

	function startLocalPlayback(ctx: ExtensionContext, source: string) {
		if (!config.autoPlay) return;
		stopLocalPlayer();
		try {
			const child = spawn(config.playerCommand, [...config.playerArgs, source], {
				detached: true,
				stdio: "ignore",
			});
			playerPid = child.pid;
			child.unref();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifyAsyncFailure(ctx, `AllTalk playback failed: ${message}`);
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

		void fetch(url, buildRequestInit(body, config.speakMethod))
			.then(async (response) => {
				if (!response.ok) {
					const detail = (await response.text()).slice(0, 300).trim();
					notifyAsyncFailure(
						ctx,
						`TTS speak failed (${response.status}${detail ? `: ${detail}` : ""})`,
					);
					return;
				}

				if (config.responseMode === "binary") {
					const bytes = new Uint8Array(await response.arrayBuffer());
					if (bytes.byteLength === 0) return;
					startLocalPlayback(ctx, createTempAudioFile(bytes));
					return;
				}

				let payload: AllTalkGenerateResponse | undefined;
				try {
					payload = (await response.json()) as AllTalkGenerateResponse;
				} catch {
					return;
				}

				const playbackSource = resolvePlaybackSource(payload);
				if (playbackSource) {
					startLocalPlayback(ctx, playbackSource);
				}
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				notifyAsyncFailure(ctx, `TTS speak failed: ${message}`);
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
		stopLocalPlayer();
		if (!config.stopPath) {
			return "Stopped local playback.";
		}

		const url = joinUrl(config.baseUrl, config.stopPath);
		const response = await fetch(url, {
			...buildRequestInit(config.stopBody ?? {}, config.stopMethod),
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
		description: "Play brief spoken narration through a configured TTS API. Use only for short summaries, warnings, status updates, or next steps. Never send code, logs, stack traces, or reasoning.",
		promptSnippet: "Play short spoken narration that complements the written response via the configured TTS API",
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
		description: "Control TTS: /tts on|off|mode <auto|manual|off>|test|stop|status|reload",
		handler: async (args, ctx) => {
			const [commandRaw, valueRaw] = args.trim().split(/\s+/, 2);
			const command = (commandRaw || "status").toLowerCase();
			const value = valueRaw?.toLowerCase();

			switch (command) {
				case "on": {
					state.mode = "auto";
					persistState();
					applyState(ctx);
					ctx.ui.notify("TTS enabled (auto).", "info");
					return;
				}
				case "off": {
					state.mode = "off";
					persistState();
					applyState(ctx);
					ctx.ui.notify("TTS disabled.", "info");
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
					ctx.ui.notify(`TTS mode: ${mode}`, "info");
					return;
				}
				case "voice": {
					const voice = valueRaw?.trim();
					state.voice = voice ? voice : undefined;
					persistState();
					applyState(ctx);
					ctx.ui.notify(state.voice ? `TTS voice: ${state.voice}` : "Cleared TTS voice override.", "info");
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
					ctx.ui.notify(`Reloaded TTS config from ${join(ctx.cwd, ".pi", "alltalk-tts.json")}`, "info");
					return;
				}
				case "status":
				default: {
					refreshConfig(ctx);
					const summary = [
						`mode=${state.mode}`,
						`voice=${state.voice ?? config.defaultVoice ?? "default"}`,
						`baseUrl=${config.baseUrl}`,
						`speakPath=${config.speakMethod} ${config.speakPath}`,
						`stopPath=${config.stopPath ? `${config.stopMethod} ${config.stopPath}` : "(none)"}`,
						`encoding=${config.requestEncoding}`,
						`responseMode=${config.responseMode}`,
					].join(" | ");
					ctx.ui.notify(summary, "info");
					return;
				}
			}
		},
	});

	pi.registerCommand("say", {
		description: "Speak text immediately via TTS: /say <text>",
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

	pi.registerCommand("tts-voices", {
		description: "List voices from the configured TTS backend",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);
			const voices = await fetchAvailableVoices();
			if (voices.length === 0) {
				ctx.ui.notify("No voices returned by the TTS backend.", "warning");
				return;
			}
			ctx.ui.setEditorText(voices.join("\n"));
			ctx.ui.notify(`Loaded ${voices.length} voices into the editor.`, "info");
		},
	});

	pi.registerCommand("tts-audition", {
		description: "Audition voices: /tts-audition voice1,voice2 [optional test phrase]",
		handler: async (args, ctx) => {
			refreshConfig(ctx);
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /tts-audition voice1,voice2 [optional test phrase]", "warning");
				return;
			}

			const [voicePart, ...phraseParts] = trimmed.split(/\s+/);
			const voices = voicePart
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean);
			if (voices.length === 0) {
				ctx.ui.notify("Provide at least one voice name.", "warning");
				return;
			}

			const phrase = phraseParts.join(" ").trim() || "Done. See the written response for details.";
			const previousVoice = state.voice;
			for (const voice of voices) {
				state.voice = voice;
				setStatus(ctx, state);
				const result = queueSpeech(ctx, phrase, "status", true);
				ctx.ui.notify(`${voice}: ${result.message}`, "info");
				await new Promise((resolve) => setTimeout(resolve, 2500));
			}
			state.voice = previousVoice;
			setStatus(ctx, state);
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
