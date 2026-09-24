// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.openmausbot) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { stripAmbientAppEnv } from "./ambient-env.ts";
import { removeTempDir } from "./cleanup.ts";

// Test modules may capture these values at import time, and spawned fake
// processes inherit process.env. Drop ambient app configuration, but keep the
// explicit test controls used by optional browser and provider e2e runs.
// Tests can still set the app variables they intentionally exercise after
// setup. This also prevents OMB_DATA_DIR from pointing outside the throwaway
// home below.
stripAmbientAppEnv(process.env);

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// The companion keeps its paired devices in its own directory, and resolves
// it from homedir() the same way — so the redirect above already covers it.
// Named explicitly all the same: the device tests delete this directory
// wholesale, and "it is safe because of a line in another file" is not the
// footing that delete should stand on.
process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");

// Product code follows navigator.language, which makes English assertions
// depend on the developer or CI host locale. Keep the shared default stable;
// dedicated i18n tests explicitly select every translated pack they exercise.
Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
