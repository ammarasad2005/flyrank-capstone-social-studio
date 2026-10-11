// Load `.env` (when present) into process.env before anything reads configuration.
//
// Imported first by every entrypoint (server / worker / seed), so `cp .env.example .env`
// actually configures the app — the README's run steps depend on it. Real environment
// variables keep precedence over the file (Node semantics), so CI, Docker and Render are
// unaffected. Tests never import this module, so the suite stays hermetic.
import { existsSync } from 'node:fs';

const envPath = process.env.ENV_FILE || '.env';

if (existsSync(envPath)) {
  process.loadEnvFile(envPath); // Node >= 20.12
}
