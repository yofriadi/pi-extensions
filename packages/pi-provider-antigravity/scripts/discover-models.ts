import { discoverAntigravityModels } from "../src/model-discovery.ts";
import { loadLiveAntigravityCredentials } from "../src/stored-credentials.ts";

const { accessToken } = await loadLiveAntigravityCredentials();
const catalog = await discoverAntigravityModels({
	accessToken,
	signal: AbortSignal.timeout(30_000),
});
process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
