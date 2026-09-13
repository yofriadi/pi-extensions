import { randomUUID } from "crypto";
import {
	lstat,
	mkdir,
	open,
	readlink,
	realpath,
	rename,
	stat,
	writeFile,
} from "fs/promises";
import { dirname, join, parse, resolve, sep } from "path";

export async function resolveMutationTargetPath(path: string): Promise<string> {
	const absolutePath = resolve(path);
	const { root } = parse(absolutePath);
	const parts = absolutePath
		.slice(root.length)
		.split(sep)
		.filter((part) => part.length > 0);
	// Symlinks on the currently-expanding chain, keyed by canonical identity
	// (realpath). A path string may legally reappear without a cycle when a
	// symlink target resolves back through an already-expanded prefix alias
	// (macOS: /var -> /private/var, tmpdir under /var), so the raw string is
	// not a safe key; membership is also scoped to the active expansion, not
	// global. Real symlink cycles are caught by realpath's system ELOOP before
	// this check can matter.
	const activeSymlinks = new Set<string>();

	async function resolveFromParts(
		currentPath: string,
		remainingParts: string[],
	): Promise<string> {
		if (remainingParts.length === 0) {
			return currentPath;
		}

		const nextPart = remainingParts[0];
		if (nextPart === undefined) {
			return currentPath;
		}
		const tail = remainingParts.slice(1);
		const candidatePath = join(currentPath, nextPart);

		try {
			const candidateStats = await lstat(candidatePath);
			if (!candidateStats.isSymbolicLink()) {
				return resolveFromParts(candidatePath, tail);
			}

			// Canonical identity for cycle tracking; realpath itself raises the
			// system ELOOP for true cycles. Dangling links have no identity, so
			// fall back to the raw path.
			let identity: string;
			try {
				identity = await realpath(candidatePath);
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					throw error;
				}
				identity = candidatePath;
			}

			if (activeSymlinks.has(identity)) {
				const error = new Error(
					`Too many symbolic links while resolving ${path}`,
				) as NodeJS.ErrnoException;
				error.code = "ELOOP";
				throw error;
			}
			activeSymlinks.add(identity);

			try {
				const linkTargetPath = resolve(
					dirname(candidatePath),
					await readlink(candidatePath),
				);
				const targetParts = linkTargetPath
					.slice(parse(linkTargetPath).root.length)
					.split(sep)
					.filter((part) => part.length > 0);
				return resolveFromParts(parse(linkTargetPath).root, [
					...targetParts,
					...tail,
				]);
			} finally {
				activeSymlinks.delete(identity);
			}
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				return join(candidatePath, ...tail);
			}
			throw error;
		}
	}

	return resolveFromParts(root, parts);
}

export async function writeFileAtomically(
	path: string,
	content: string,
	options?: { alreadyResolved?: true },
): Promise<void> {
	const targetPath = options?.alreadyResolved
		? path
		: await resolveMutationTargetPath(path);

	let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
	try {
		existingStats = await stat(targetPath);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			throw error;
		}
	}

	if (existingStats && existingStats.nlink > 1) {
		// Hard-linked files cannot be atomically replaced without breaking inode
		// sharing, so preserve links by updating existing inode in place.
		await writeFile(targetPath, content, "utf-8");
		return;
	}

	const dir = dirname(targetPath);
	const tempPath = join(dir, `.tmp-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	const tempHandle = await open(tempPath, "wx", 0o600);
	try {
		await tempHandle.writeFile(content, "utf-8");
		if (existingStats) {
			await tempHandle.chmod(existingStats.mode & 0o7777);
		}
	} finally {
		await tempHandle.close();
	}

	await rename(tempPath, targetPath);
}
