import { DefaultResourceLoader, SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";

export interface SelectedSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
}

export function parseSelectedSkillNames(raw: string | undefined): string[] {
	if (raw == null || raw.trim() === "") return [];
	const names = raw.split(",").map((name) => name.trim());
	if (names.some((name) => name === "")) {
		throw new Error("Invalid subagent skills: empty skill name.");
	}
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) throw new Error(`Invalid subagent skills: duplicate ${JSON.stringify(name)}.`);
		seen.add(name);
	}
	return names;
}

export async function resolveSelectedSkills(options: {
	raw: string | undefined;
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): Promise<SelectedSkill[]> {
	const names = parseSelectedSkillNames(options.raw);
	if (names.length === 0) return [];

	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: options.projectTrusted,
	});
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		// Discovery-only: never execute configured extension factories here. An
		// unbound factory evaluation must not mutate the live session runtime.
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getSkills();

	return names.map((name) => {
		const winner = loaded.skills.find((skill) => skill.name === name);
		const collision = loaded.diagnostics.find((diagnostic: any) => isSkillCollision(diagnostic, name));
		if (collision) throw new Error(`Ambiguous subagent skill ${JSON.stringify(name)}.`);
		if (!winner) throw new Error(`Unknown subagent skill ${JSON.stringify(name)}.`);
		return selectSkillFields(winner);
	});
}

function selectSkillFields(skill: Skill): SelectedSkill {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		disableModelInvocation: skill.disableModelInvocation,
	};
}

function isSkillCollision(diagnostic: any, name: string): boolean {
	if (diagnostic.type !== "collision") return false;
	const collision = diagnostic.collision;
	return collision?.resourceType === "skill" && collision.name === name;
}
