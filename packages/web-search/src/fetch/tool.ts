import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 20_000;
const WEB_ACCESS_USER_AGENT = "pi-web-access-extension/1.0";

const FETCH_CONTENT_PARAMS = Type.Object({
	url: Type.String({ description: "URL to fetch content from" }),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
	maxChars: Type.Optional(Type.Number({ minimum: 500, maximum: 200_000 })),
	prefer: Type.Optional(StringEnum(["jina", "direct"] as const)),
});

export interface ScrapeResult {
	scraper: string;
	fetchedUrl: string;
	statusCode: number;
	content: string;
}

export interface Scraper {
	readonly name: string;
	canHandle(url: URL): boolean;
	scrape(url: URL, options: ScrapeOptions): Promise<ScrapeResult>;
}

interface ScrapeOptions {
	fetchImpl: typeof fetch;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface FetchToolOptions {
	fetchImpl?: typeof fetch;
}

export function registerFetchContentTool(pi: ExtensionAPI, options: FetchToolOptions = {}): void {
	const fetchImpl = options.fetchImpl ?? fetch;
	const registry = createScraperRegistry();

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch a URL using scraper registry with Jina Reader fallback for generic web content",
		parameters: FETCH_CONTENT_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			notifyStatus(ctx, `Web fetch started: ${params.url}`, "info");
			const parsedUrl = parseUrl(params.url);
			if (!parsedUrl.ok) {
				notifyStatus(ctx, `Web fetch failed: ${parsedUrl.error}`, "warning");
				return {
					isError: true,
					content: [{ type: "text", text: parsedUrl.error }],
					details: {
						error: parsedUrl.error,
					},
				};
			}

			const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

			const attemptOrder = registry.getAttemptOrder(parsedUrl.url, params.prefer);
			const errors: string[] = [];

			for (const scraper of attemptOrder) {
				try {
					const result = await scraper.scrape(parsedUrl.url, {
						fetchImpl,
						timeoutMs,
						signal,
					});
					const trimmed = result.content.trim();
					const truncated = trimmed.length > maxChars;
					const finalContent = truncated
						? `${trimmed.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`
						: trimmed;
					notifyStatus(ctx, `Web fetch completed via ${result.scraper} (status ${result.statusCode})`, "info");
					return {
						content: [
							{
								type: "text",
								text: [
									`Fetched ${params.url} using ${result.scraper} (status ${result.statusCode})`,
									"",
									finalContent,
								].join("\n"),
							},
						],
						details: {
							url: params.url,
							scraper: result.scraper,
							fetchedUrl: result.fetchedUrl,
							statusCode: result.statusCode,
							truncated,
							attemptedScrapers: attemptOrder.map((candidate) => candidate.name),
						},
					};
				} catch (error) {
					errors.push(`${scraper.name}: ${formatError(error)}`);
				}
			}

			notifyStatus(ctx, `Web fetch failed for ${params.url}`, "warning");
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: [`Failed to fetch ${params.url}.`, ...errors.map((entry) => `- ${entry}`)].join("\n"),
					},
				],
				details: {
					url: params.url,
					attemptedScrapers: attemptOrder.map((candidate) => candidate.name),
					errors,
				},
			};
		},
	});
}

export function createScraperRegistry(scrapers: Scraper[] = defaultScrapers()): {
	getAttemptOrder(url: URL, prefer?: "jina" | "direct"): Scraper[];
} {
	const byName = new Map(scrapers.map((scraper) => [scraper.name, scraper]));
	return {
		getAttemptOrder(url: URL, prefer?: "jina" | "direct"): Scraper[] {
			const selected: Scraper[] = [];
			const preferredName = prefer === "jina" ? "jina-reader" : prefer === "direct" ? "direct-fetch" : undefined;
			if (preferredName) {
				const preferred = byName.get(preferredName);
				if (preferred?.canHandle(url)) {
					selected.push(preferred);
				}
			}

			for (const scraper of scrapers) {
				if (!scraper.canHandle(url)) {
					continue;
				}
				if (selected.includes(scraper)) {
					continue;
				}
				selected.push(scraper);
			}
			return selected;
		},
	};
}

function defaultScrapers(): Scraper[] {
	return [
		createNpmRegistryScraper(),
		createPypiJsonScraper(),
		createCratesIoScraper(),
		createPkgGoDevScraper(),
		createGitHubRawScraper(),
		createJinaReaderScraper(),
		createDirectFetchScraper(),
	];
}

function createNpmRegistryScraper(): Scraper {
	return {
		name: "npm-registry",
		canHandle: (url) => parseNpmTarget(url) !== undefined,
		async scrape(url, options): Promise<ScrapeResult> {
			const target = parseNpmTarget(url);
			if (!target) {
				throw new Error("Unable to resolve npm package target");
			}

			const { response, data } = await fetchJson(target.apiUrl, options, "NPM registry request timed out");
			const payload = asRecord(data);
			if (!payload) {
				throw new Error("Unexpected npm registry payload");
			}

			const latestVersion = readNestedString(payload, ["dist-tags", "latest"]);
			const resolvedVersion = target.version ?? readString(payload, "version") ?? latestVersion;
			const manifest = selectNpmManifest(payload, resolvedVersion);
			const packageName = readString(manifest, "name") ?? readString(payload, "name") ?? target.packageName;
			const description = readString(manifest, "description") ?? readString(payload, "description");
			const repository =
				extractRepositoryUrl(manifest.repository) ??
				extractRepositoryUrl(payload.repository) ??
				readString(manifest, "homepage") ??
				readString(payload, "homepage");
			const license = formatLicense(manifest.license) ?? formatLicense(payload.license);
			const keywords = readStringArray(manifest, "keywords") ?? readStringArray(payload, "keywords");
			const readme = readString(manifest, "readme") ?? readString(payload, "readme");

			const content = renderMetadataAndReadme(
				"NPM package metadata",
				[
					["Package", packageName],
					["Version", resolvedVersion ?? "unknown"],
					["Description", description],
					["License", license],
					["Repository", repository],
					["Keywords", keywords?.join(", ")],
				],
				readme,
			);

			return {
				scraper: "npm-registry",
				fetchedUrl: target.apiUrl,
				statusCode: response.status,
				content,
			};
		},
	};
}

function createPypiJsonScraper(): Scraper {
	return {
		name: "pypi-json",
		canHandle: (url) => parsePypiTarget(url) !== undefined,
		async scrape(url, options): Promise<ScrapeResult> {
			const target = parsePypiTarget(url);
			if (!target) {
				throw new Error("Unable to resolve PyPI package target");
			}

			const { response, data } = await fetchJson(target.apiUrl, options, "PyPI request timed out");
			const payload = asRecord(data);
			const info = payload ? asRecord(payload.info) : undefined;
			if (!info) {
				throw new Error("Unexpected PyPI payload");
			}

			const projectUrls = formatProjectUrls(asRecord(info.project_urls));
			const content = renderMetadataAndReadme(
				"PyPI package metadata",
				[
					["Package", readString(info, "name") ?? target.packageName],
					["Version", target.version ?? readString(info, "version") ?? "unknown"],
					["Summary", readString(info, "summary")],
					["License", readString(info, "license")],
					["Requires-Python", readString(info, "requires_python")],
					["Homepage", readString(info, "home_page")],
					["Project URLs", projectUrls],
				],
				readString(info, "description"),
			);

			return {
				scraper: "pypi-json",
				fetchedUrl: target.apiUrl,
				statusCode: response.status,
				content,
			};
		},
	};
}

function createCratesIoScraper(): Scraper {
	return {
		name: "crates-io-api",
		canHandle: (url) => parseCratesTarget(url) !== undefined,
		async scrape(url, options): Promise<ScrapeResult> {
			const target = parseCratesTarget(url);
			if (!target) {
				throw new Error("Unable to resolve crates.io target");
			}

			const { response, data } = await fetchJson(target.metadataUrl, options, "crates.io API request timed out");
			const payload = asRecord(data);
			if (!payload) {
				throw new Error("Unexpected crates.io payload");
			}

			const crateInfo = asRecord(payload.crate);
			const versionInfo = asRecord(payload.version);
			const crateName = readString(crateInfo, "id") ?? readString(versionInfo, "crate") ?? target.crateName;
			const resolvedVersion =
				target.version ??
				readString(versionInfo, "num") ??
				readString(crateInfo, "max_stable_version") ??
				readString(crateInfo, "max_version");
			const readme = resolvedVersion ? await fetchOptionalCratesReadme(crateName, resolvedVersion, options) : undefined;
			const content = renderMetadataAndReadme(
				"crates.io package metadata",
				[
					["Crate", crateName],
					["Version", resolvedVersion ?? "unknown"],
					["Description", readString(versionInfo, "description") ?? readString(crateInfo, "description")],
					["License", readString(versionInfo, "license") ?? readString(crateInfo, "license")],
					["Repository", readString(versionInfo, "repository") ?? readString(crateInfo, "repository")],
					["Homepage", readString(versionInfo, "homepage") ?? readString(crateInfo, "homepage")],
					["Documentation", readString(versionInfo, "documentation") ?? readString(crateInfo, "documentation")],
					["Downloads", formatNumber(readNumber(crateInfo, "downloads"))],
				],
				readme,
			);

			return {
				scraper: "crates-io-api",
				fetchedUrl: target.metadataUrl,
				statusCode: response.status,
				content,
			};
		},
	};
}

function createPkgGoDevScraper(): Scraper {
	return {
		name: "pkg-go-dev-redirect",
		canHandle: (url) => url.hostname.toLowerCase() === "pkg.go.dev",
		async scrape(url, options): Promise<ScrapeResult> {
			const response = await withTimeout(
				options.fetchImpl(url.toString(), {
					headers: {
						"user-agent": WEB_ACCESS_USER_AGENT,
						accept: "text/html;q=0.9, */*;q=0.8",
					},
					signal: options.signal,
				}),
				options.timeoutMs,
				options.signal,
				"pkg.go.dev request timed out",
			);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const html = await response.text();
			const repositoryUrl = extractPkgGoRepositoryUrl(html);
			if (!repositoryUrl) {
				throw new Error("Unable to extract repository URL from pkg.go.dev page");
			}

			const readme = await fetchOptionalGitHubReadme(repositoryUrl, options);
			const modulePath = extractPkgGoModulePath(url);
			const synopsis = extractMetaDescription(html);
			const content = renderMetadataAndReadme(
				"pkg.go.dev module metadata",
				[
					["Module", modulePath],
					["Repository", repositoryUrl],
					["Synopsis", synopsis],
				],
				readme,
			);

			return {
				scraper: "pkg-go-dev-redirect",
				fetchedUrl: repositoryUrl,
				statusCode: response.status,
				content,
			};
		},
	};
}

function createGitHubRawScraper(): Scraper {
	return {
		name: "github-raw-transform",
		canHandle: (url) => toGitHubRawUrl(url) !== undefined,
		async scrape(url, options): Promise<ScrapeResult> {
			const rawUrl = toGitHubRawUrl(url);
			if (!rawUrl) {
				throw new Error("Unable to transform GitHub URL to raw content URL");
			}

			const response = await withTimeout(
				options.fetchImpl(rawUrl, {
					headers: {
						"user-agent": WEB_ACCESS_USER_AGENT,
						accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
					},
					signal: options.signal,
				}),
				options.timeoutMs,
				options.signal,
				"GitHub raw request timed out",
			);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const content = await response.text();
			if (!content.trim()) {
				throw new Error("No content returned by GitHub raw endpoint");
			}

			return {
				scraper: "github-raw-transform",
				fetchedUrl: rawUrl,
				statusCode: response.status,
				content,
			};
		},
	};
}

interface NpmTarget {
	packageName: string;
	version?: string;
	apiUrl: string;
}

function parseNpmTarget(url: URL): NpmTarget | undefined {
	const host = url.hostname.toLowerCase();
	const segments = splitPath(url.pathname);
	if (host === "npmjs.com" || host === "www.npmjs.com") {
		if (segments[0] !== "package") {
			return undefined;
		}
		const packageName = parseScopedPackageFromPath(segments.slice(1));
		if (!packageName) {
			return undefined;
		}
		let version: string | undefined;
		const versionMarker = segments[1 + packageName.consumedSegments];
		const versionValue = segments[2 + packageName.consumedSegments];
		if (versionMarker === "v" && versionValue) {
			version = decodeUriComponentSafe(versionValue);
		}
		return {
			packageName: packageName.name,
			version,
			apiUrl: toNpmApiUrl(packageName.name, version),
		};
	}

	if (host === "registry.npmjs.org") {
		const packageName = parseScopedPackageFromPath(segments);
		if (!packageName) {
			return undefined;
		}
		const rawVersion = segments[packageName.consumedSegments];
		const version = rawVersion && rawVersion !== "latest" ? decodeUriComponentSafe(rawVersion) : undefined;
		return {
			packageName: packageName.name,
			version,
			apiUrl: toNpmApiUrl(packageName.name, version),
		};
	}

	return undefined;
}

interface ScopedPackagePath {
	name: string;
	consumedSegments: number;
}

function parseScopedPackageFromPath(segments: string[]): ScopedPackagePath | undefined {
	if (segments.length === 0 || !segments[0]) {
		return undefined;
	}

	const first = decodeUriComponentSafe(segments[0]);
	if (first.startsWith("@")) {
		if (first.includes("/")) {
			return { name: first, consumedSegments: 1 };
		}
		const secondRaw = segments[1];
		if (!secondRaw) {
			return undefined;
		}
		const second = decodeUriComponentSafe(secondRaw);
		return { name: `${first}/${second}`, consumedSegments: 2 };
	}
	return { name: first, consumedSegments: 1 };
}

function toNpmApiUrl(packageName: string, version?: string): string {
	const encodedPackage = encodeURIComponent(packageName);
	const encodedVersion = version ? `/${encodeURIComponent(version)}` : "";
	return `https://registry.npmjs.org/${encodedPackage}${encodedVersion}`;
}

function selectNpmManifest(payload: Record<string, unknown>, version: string | undefined): Record<string, unknown> {
	if (!version) {
		return payload;
	}
	const versions = asRecord(payload.versions);
	if (!versions) {
		return payload;
	}
	const versionPayload = asRecord(versions[version]);
	return versionPayload ?? payload;
}

interface PypiTarget {
	packageName: string;
	version?: string;
	apiUrl: string;
}

function parsePypiTarget(url: URL): PypiTarget | undefined {
	const host = url.hostname.toLowerCase();
	if (host !== "pypi.org" && host !== "www.pypi.org") {
		return undefined;
	}

	const segments = splitPath(url.pathname);
	if (segments[0] === "project" && segments[1]) {
		const packageName = decodeUriComponentSafe(segments[1]);
		const version = segments[2] ? decodeUriComponentSafe(segments[2]) : undefined;
		return {
			packageName,
			version,
			apiUrl: toPypiApiUrl(packageName, version),
		};
	}

	if (segments[0] === "pypi" && segments[1]) {
		const packageName = decodeUriComponentSafe(segments[1]);
		const versionSegment = segments[2];
		const version = versionSegment && versionSegment !== "json" ? decodeUriComponentSafe(versionSegment) : undefined;
		return {
			packageName,
			version,
			apiUrl: toPypiApiUrl(packageName, version),
		};
	}

	return undefined;
}

function toPypiApiUrl(packageName: string, version?: string): string {
	const encodedPackage = encodeURIComponent(packageName);
	const encodedVersion = version ? `/${encodeURIComponent(version)}` : "";
	return `https://pypi.org/pypi/${encodedPackage}${encodedVersion}/json`;
}

interface CratesTarget {
	crateName: string;
	version?: string;
	metadataUrl: string;
}

function parseCratesTarget(url: URL): CratesTarget | undefined {
	const host = url.hostname.toLowerCase();
	if (host !== "crates.io" && host !== "www.crates.io") {
		return undefined;
	}

	const segments = splitPath(url.pathname);
	let crateName: string | undefined;
	let version: string | undefined;

	if (segments[0] === "crates" && segments[1]) {
		crateName = decodeUriComponentSafe(segments[1]);
		version = segments[2] ? decodeUriComponentSafe(segments[2]) : undefined;
	} else if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "crates" && segments[3]) {
		crateName = decodeUriComponentSafe(segments[3]);
		const rawVersion = segments[4];
		if (rawVersion && rawVersion !== "readme") {
			version = decodeUriComponentSafe(rawVersion);
		}
	}

	if (!crateName) {
		return undefined;
	}

	return {
		crateName,
		version,
		metadataUrl: toCratesMetadataUrl(crateName, version),
	};
}

function toCratesMetadataUrl(crateName: string, version?: string): string {
	const encodedCrate = encodeURIComponent(crateName);
	const encodedVersion = version ? `/${encodeURIComponent(version)}` : "";
	return `https://crates.io/api/v1/crates/${encodedCrate}${encodedVersion}`;
}

async function fetchOptionalCratesReadme(
	crateName: string,
	version: string,
	options: ScrapeOptions,
): Promise<string | undefined> {
	const readmeUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}/${encodeURIComponent(version)}/readme`;
	const response = await withTimeout(
		options.fetchImpl(readmeUrl, {
			headers: {
				"user-agent": WEB_ACCESS_USER_AGENT,
				accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
			},
			signal: options.signal,
		}),
		options.timeoutMs,
		options.signal,
		"crates.io readme request timed out",
	);

	if (response.status === 404) {
		return undefined;
	}
	if (!response.ok) {
		throw new Error(`Readme request failed: HTTP ${response.status} ${response.statusText}`);
	}

	const readme = (await response.text()).trim();
	return readme.length > 0 ? readme : undefined;
}

function extractPkgGoRepositoryUrl(html: string): string | undefined {
	const match = html.match(/<div class="UnitMeta-repo">[\s\S]*?<a href="([^"]+)"/i);
	if (!match?.[1]) {
		return undefined;
	}
	return decodeHtmlEntities(match[1].trim());
}

function extractMetaDescription(html: string): string | undefined {
	const match = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
	if (!match?.[1]) {
		return undefined;
	}
	return decodeHtmlEntities(match[1]).trim();
}

function extractPkgGoModulePath(url: URL): string {
	const rawPath = decodeUriComponentSafe(url.pathname.replace(/^\/+/, ""));
	if (!rawPath) {
		return "unknown";
	}
	return rawPath.split("@")[0] ?? rawPath;
}

async function fetchOptionalGitHubReadme(repositoryUrl: string, options: ScrapeOptions): Promise<string | undefined> {
	const parsed = parseUrl(repositoryUrl);
	if (!parsed.ok) {
		return undefined;
	}
	if (parsed.url.hostname.toLowerCase() !== "github.com") {
		return undefined;
	}

	const candidates = toGitHubReadmeCandidates(parsed.url);
	for (const candidate of candidates) {
		const response = await withTimeout(
			options.fetchImpl(candidate, {
				headers: {
					"user-agent": WEB_ACCESS_USER_AGENT,
					accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
				},
				signal: options.signal,
			}),
			options.timeoutMs,
			options.signal,
			"GitHub readme request timed out",
		);
		if (response.status === 404) {
			continue;
		}
		if (!response.ok) {
			continue;
		}
		const text = (await response.text()).trim();
		if (text.length > 0) {
			return text;
		}
	}
	return undefined;
}

function toGitHubReadmeCandidates(repositoryUrl: URL): string[] {
	const segments = splitPath(repositoryUrl.pathname);
	if (segments.length < 2) {
		return [];
	}

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");
	if (!owner || !repo) {
		return [];
	}

	const preferredRef = segments[2] === "tree" && segments[3] ? segments[3] : undefined;
	const refs = dedupeStrings([preferredRef, "main", "master"]);
	const fileNames = ["README.md", "README", "README.rst", "readme.md"];
	const candidates: string[] = [];

	for (const ref of refs) {
		for (const fileName of fileNames) {
			const encodedFile = encodeURIComponent(fileName).replace(/%2F/g, "/");
			candidates.push(
				`https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedFile}`,
			);
		}
	}
	return candidates;
}

function toGitHubRawUrl(url: URL): string | undefined {
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") {
		return undefined;
	}

	const segments = splitPath(url.pathname);
	if (segments.length < 5) {
		return undefined;
	}
	if (segments[2] !== "blob" && segments[2] !== "raw") {
		return undefined;
	}

	const owner = segments[0];
	const repo = segments[1];
	const ref = segments[3];
	const filePath = segments.slice(4);
	if (!owner || !repo || !ref || filePath.length === 0) {
		return undefined;
	}

	const encodedPath = filePath.map((segment) => encodeURIComponent(segment)).join("/");
	return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;
}

async function fetchJson(
	url: string,
	options: ScrapeOptions,
	timeoutMessage: string,
): Promise<{ response: Response; data: unknown }> {
	const response = await withTimeout(
		options.fetchImpl(url, {
			headers: {
				"user-agent": WEB_ACCESS_USER_AGENT,
				accept: "application/json, text/plain;q=0.9, */*;q=0.8",
			},
			signal: options.signal,
		}),
		options.timeoutMs,
		options.signal,
		timeoutMessage,
	);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch (error) {
		throw new Error(`Invalid JSON response: ${formatError(error)}`);
	}

	return { response, data };
}

function renderMetadataAndReadme(
	title: string,
	metadata: Array<[label: string, value: string | undefined]>,
	readme: string | undefined,
): string {
	const lines = [title];
	for (const [label, value] of metadata) {
		if (!value) {
			continue;
		}
		const cleaned = sanitizeInline(value);
		if (!cleaned) {
			continue;
		}
		lines.push(`${label}: ${cleaned}`);
	}

	const cleanedReadme = sanitizeMultiline(readme);
	if (cleanedReadme) {
		lines.push("", "Readme:", cleanedReadme);
	}
	return lines.join("\n");
}

function sanitizeInline(value: string): string | undefined {
	const cleaned = value.replace(/\s+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeMultiline(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	const cleaned = value.trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

function formatProjectUrls(projectUrls: Record<string, unknown> | undefined): string | undefined {
	if (!projectUrls) {
		return undefined;
	}
	const entries: string[] = [];
	for (const [key, value] of Object.entries(projectUrls)) {
		if (typeof value !== "string") {
			continue;
		}
		const cleanedValue = sanitizeInline(value);
		if (!cleanedValue) {
			continue;
		}
		entries.push(`${key}: ${cleanedValue}`);
	}
	return entries.length > 0 ? entries.join(", ") : undefined;
}

function formatLicense(value: unknown): string | undefined {
	if (typeof value === "string") {
		return sanitizeInline(value);
	}
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const fromType = readString(record, "type");
	if (fromType) {
		return fromType;
	}
	return readString(record, "name");
}

function extractRepositoryUrl(value: unknown): string | undefined {
	if (typeof value === "string") {
		return normalizeRepositoryUrl(value);
	}
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const url = readString(record, "url");
	return url ? normalizeRepositoryUrl(url) : undefined;
}

function normalizeRepositoryUrl(value: string): string {
	return value.replace(/^git\+/, "").replace(/\.git$/, "");
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	if (!record) {
		return undefined;
	}
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | undefined {
	let current: unknown = record;
	for (const segment of path) {
		const currentRecord = asRecord(current);
		if (!currentRecord) {
			return undefined;
		}
		current = currentRecord[segment];
	}
	return typeof current === "string" ? current : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
	const value = record[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((entry): entry is string => typeof entry === "string");
	return strings.length > 0 ? strings : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
	if (!record) {
		return undefined;
	}
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function formatNumber(value: number | undefined): string | undefined {
	return typeof value === "number" ? value.toLocaleString("en-US") : undefined;
}

function splitPath(pathname: string): string[] {
	return pathname.split("/").filter((segment) => segment.length > 0);
}

function decodeUriComponentSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function dedupeStrings(values: Array<string | undefined>): string[] {
	const result: string[] = [];
	for (const value of values) {
		if (!value || result.includes(value)) {
			continue;
		}
		result.push(value);
	}
	return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function createJinaReaderScraper(): Scraper {
	return {
		name: "jina-reader",
		canHandle: (url) => url.protocol === "http:" || url.protocol === "https:",
		async scrape(url, options): Promise<ScrapeResult> {
			const readerUrl = `https://r.jina.ai/${url.toString()}`;
			const response = await withTimeout(
				options.fetchImpl(readerUrl, {
					headers: {
						"user-agent": WEB_ACCESS_USER_AGENT,
						accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
					},
					signal: options.signal,
				}),
				options.timeoutMs,
				options.signal,
				"Jina Reader request timed out",
			);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const content = await response.text();
			if (!content.trim()) {
				throw new Error("No content returned by Jina Reader");
			}

			return {
				scraper: "jina-reader",
				fetchedUrl: readerUrl,
				statusCode: response.status,
				content,
			};
		},
	};
}

function createDirectFetchScraper(): Scraper {
	return {
		name: "direct-fetch",
		canHandle: (url) => url.protocol === "http:" || url.protocol === "https:",
		async scrape(url, options): Promise<ScrapeResult> {
			const response = await withTimeout(
				options.fetchImpl(url.toString(), {
					headers: {
						"user-agent": WEB_ACCESS_USER_AGENT,
						accept: "text/plain, text/html;q=0.9, application/json;q=0.8, */*;q=0.5",
					},
					signal: options.signal,
				}),
				options.timeoutMs,
				options.signal,
				"Direct fetch request timed out",
			);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const body = await response.text();
			if (!body.trim()) {
				throw new Error("No content returned by origin");
			}

			const content = contentType.includes("text/html") ? stripHtml(body) : body;
			return {
				scraper: "direct-fetch",
				fetchedUrl: url.toString(),
				statusCode: response.status,
				content,
			};
		},
	};
}

function notifyStatus(
	ctx: { ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void } } | undefined,
	message: string,
	level: "info" | "warning" | "error",
): void {
	ctx?.ui?.notify?.(message, level);
}

function parseUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return {
				ok: false,
				error: `Unsupported URL protocol: ${parsed.protocol}. Only http:// and https:// are supported.`,
			};
		}
		return { ok: true, url: parsed };
	} catch {
		return {
			ok: false,
			error: `Invalid URL: ${raw}`,
		};
	}
}

function stripHtml(html: string): string {
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
		.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	message: string,
): Promise<T> {
	if (signal?.aborted) {
		throw new Error("Request aborted");
	}

	const controller = new AbortController();
	const abortListener = () => controller.abort();
	if (signal) {
		signal.addEventListener("abort", abortListener, { once: true });
	}

	const timeout = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => {
						reject(new Error(message));
					},
					{ once: true },
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
		if (signal) {
			signal.removeEventListener("abort", abortListener);
		}
	}
}
