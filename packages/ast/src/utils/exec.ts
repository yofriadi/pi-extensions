import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface BunProcess {
	exited: Promise<number>;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
}

interface BunInterface {
	spawn: (
		command: string[],
		options: {
			cwd?: string;
			env?: Record<string, string | undefined>;
			stdout?: "pipe";
			stderr?: "pipe";
		},
	) => BunProcess;
}

export async function exec(command: string[], options: { cwd?: string } = {}): Promise<ExecResult> {
	// Add node_modules/.bin to PATH
	const env = { ...process.env };
	const cwd = options.cwd ?? process.cwd();

	// Try to find the closest node_modules/.bin
	let currentDir = cwd;
	const binPaths: string[] = [];
	while (true) {
		binPaths.push(join(currentDir, "node_modules", ".bin"));
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	const pathSeparator = process.platform === "win32" ? ";" : ":";
	env.PATH = [...binPaths, env.PATH].join(pathSeparator);

	// Try Bun first
	const bun = (globalThis as Record<string, unknown>).Bun as BunInterface | undefined;
	if (bun && typeof bun.spawn === "function") {
		return execBun(bun, command, { ...options, env });
	}

	// Fallback to Node
	return execNode(command, { ...options, env });
}

async function execBun(
	bun: BunInterface,
	command: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<ExecResult> {
	const proc = bun.spawn(command, {
		cwd: options.cwd,
		env: options.env,
		stdout: "pipe",
		stderr: "pipe",
	});

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	return { stdout, stderr, exitCode };
}

function execNode(
	command: string[],
	options: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const [cmd, ...args] = command;
		const child = spawn(cmd, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (err) => {
			reject(err);
		});

		child.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code ?? 1,
			});
		});
	});
}
