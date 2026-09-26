const io = require("@pm2/io");
const pm2 = require("pm2");
const fs = require("fs");
const path = require("path");
var exec = require('child_process').exec

let IS_FETCHING = false; // Whether we are currently fetching the latest version for all processes.
let LAST_CHECK = false; // The last time we checked for updates.

// The shared library folder every app pulls in as require('../suite-libs/...'), so it sits beside
// their checkouts instead of being an npm dependency. pm2 has nothing useful to restart for it,
// but a change in it changes code every app has already loaded into memory, so they all have to
// come back up or the commit is on disk and doing nothing.
const SHARED_LIBS = "suite-libs";

/**
 * fetchLatestVersion()
 * Fetches the latest git version for all connected pm2 processes.
 */
async function fetchLatestVersion() {
	if (IS_FETCHING) {
		return;
	} // Already fetching, skip.

	IS_FETCHING = true;
	log("Fetching latest version for all processes..");
	LAST_CHECK = Date.now();

	try {
		//Fetch all processes.
		const allProcesses = await new Promise((resolve, reject) => {
			pm2.list((error, list) => {
				if (error) {
					return reject(error);
				}
				resolve(list);
			});
		});

		//We're a module too, and a git checkout ourselves, so we do want to be checked,
		//just not alongside everyone else, restarting mid Promise.all would take the
		//whole event loop (and everyone else's pending pulls) down with us
		const isSelf = process => process.name.includes('auto-pull');
		const others = allProcesses.filter(process => !isSelf(process));
		const self = allProcesses.filter(isSelf);

		const handled = (await Promise.all(others.map(handleProcess))).filter(Boolean);

		//Before we look at ourselves, since restarting us ends the cycle
		await handleSharedLibs(handled);

		await Promise.all(self.map(handleProcess));
	}

	catch (error) {
		console.trace("[auto-pull]: Error fetching process list!", error);
	}

	finally {
		IS_FETCHING = false;
	}
}

/**
 * handleProcess(process)
 * Works out if a single pm2 process is something we should pull, and does it if so.
 * Doesn't trust pm2's own pm2_env.versioning for this, it's only populated once at
 * process start and goes stale the moment the checkout on disk changes underneath it,
 * so we check the actual .git folder and remote ourselves instead.
 *
 * Resolves a descriptor of what it found so the caller can work out which repos are
 * checked out on this box and which of them just came back up, or null for anything
 * we skipped.
 *
 * @param {Object} process    A single process entry from pm2.list().
 */
async function handleProcess(process) {
	const name = process.name;

	//pm_cwd/cwd just reflects whatever directory pm2 start was run from, which isn't
	//always the app's own folder, pm_exec_path is the actual script pm2 runs so its
	//dirname is the one we can trust to be inside the real repo
	const execPath = process.pm2_env?.pm_exec_path;
	const cwd = (execPath && path.dirname(execPath)) || process.pm2_env?.pm_cwd || process.pm2_env?.cwd;

	//Not online, or some other pm2 module (npm-installed, not a git checkout) that isn't us?
	const isModule = process.pm2_env?.axm_options?.isModule && !name.includes('auto-pull');
	if (process.pm2_env?.status !== 'online' || isModule) {
		console.log(`[Skipping] Process not considererd: ${name}`);
		return null;
	}

	if (!cwd) {
		console.log(`[Skipping] Process has no known working directory: ${name}`);
		return null;
	}

	//Does it even have a git repo checked out where it's running from?
	const remoteUrl = await getGitRemote(cwd);
	if (!remoteUrl) {
		console.log(`[Skipping] Process has no git repo checked out: ${name} (${cwd})`);
		return null;
	}

	//Still pointed at the defunct stash instance?
	if (remoteUrl.includes('stash.usq')) {
		console.log(`[Skipping] Process using defuct repo: ${name} (${remoteUrl})`);
		return null;
	}

	const updated = await pullAndReload(name, cwd);

	return {name, cwd, updated};
}

/**
 * getGitRemote(cwd)
 * Reads the origin remote straight from git rather than relying on pm2's cached
 * versioning info, resolves null if there's no repo there at all.
 *
 * @param {String} cwd    The directory to check.
 */
function getGitRemote(cwd) {
	return new Promise(resolve => {
		if (!fs.existsSync(path.join(cwd, '.git'))) {
			return resolve(null);
		}

		exec('git config --get remote.origin.url', {cwd}, (error, stdout) => {
			resolve(error ? null : stdout.trim());
		});
	});
}

/**
 * pullRepo(label, cwd)
 * Fetches and hard-resets a repo to its remote HEAD, and resolves whether that actually
 * moved it. Doesn't care what, if anything, is running out of the folder.
 *
 * @param {String} label    What to call this repo in the logs.
 * @param {String} cwd      The repo's working directory.
 */
function pullRepo(label, cwd) {
	return new Promise(resolve => {
		exec('git rev-parse HEAD', {cwd}, (error, beforeRev) => {
			exec('git fetch origin', {cwd}, (fetchError) => {

				//Got an error that wasn't that it was already up to date?
				if (!!fetchError) {
					console.trace(`Error fetching updates for process: ${label}`, fetchError);
					return resolve(false);
				}

				exec('git reset --hard @{u}', {cwd}, (resetError) => {
					if (!!resetError) {
						console.trace(`Error resetting process: ${label}`, resetError);
						return resolve(false);
					}

					exec('git rev-parse HEAD', {cwd}, (error2, afterRev) => {

						//Was it up to date already?
						if (beforeRev?.trim() === afterRev?.trim()) {
							console.log(`Already up to date: ${label}`);
							return resolve(false);
						}

						console.log(`Updates fetched for: ${label}`);
						resolve(true);
					});
				});
			});
		});
	});
}

/**
 * installAndFix(label, cwd)
 * npm installs a freshly pulled repo and fixes its permissions up, so they're in place
 * before anything using it comes back up.
 *
 * @param {String} label    What to call this repo in the logs.
 * @param {String} cwd      The repo's working directory.
 */
function installAndFix(label, cwd) {
	return new Promise(resolve => {
		exec('npm install', {cwd}, (npmError) => {
			if (!!npmError) {
				console.trace(`Error running npm install for process: ${label}`, npmError);
			}

			exec(`chmod -R 777 "${cwd}"`, {cwd}, () => resolve());
		});
	});
}

/**
 * pullAndReload(name, cwd)
 * Pulls a process's own repo and, if that changed anything, npm installs and restarts it.
 * Resolves whether it restarted.
 *
 * @param {String} name    The pm2 process name.
 * @param {String} cwd     The repo's working directory.
 */
async function pullAndReload(name, cwd) {
	if (!await pullRepo(name, cwd)) {
		return false;
	}

	await installAndFix(name, cwd);
	await new Promise(resolve => pm2.restart(name, () => resolve()));

	return true;
}

/**
 * handleSharedLibs(handled)
 * Pulls the shared libs folder and, if it moved, restarts everything else on the box.
 *
 * Nothing here can be driven off pm2's process list: the shared libs folder is required by
 * relative path rather than being a dependency of anyone, and not every box runs a process
 * out of it at all, so pm2 either never hands it to us or hands it to us as one placeholder
 * process whose restart fixes nothing. Its sibling position next to the app checkouts is the
 * only reliable way to find it.
 *
 * @param {Array} handled    The descriptors handleProcess resolved for this cycle.
 */
async function handleSharedLibs(handled) {

	//Anything already back up on the new code, so we don't bounce it twice
	const restarted = new Set(handled.filter(entry => entry.updated).map(entry => entry.name));

	//Whoever owns the folder as their own checkout, if anyone does, has pulled it for us already
	const pulled = handled.filter(entry => path.basename(entry.cwd) === SHARED_LIBS);
	let changed = pulled.some(entry => entry.updated);

	if (!pulled.length) {
		const siblings = new Set(handled.map(entry => path.join(path.dirname(entry.cwd), SHARED_LIBS)));

		for (const cwd of siblings) {
			if (!fs.existsSync(path.join(cwd, '.git'))) {
				continue;
			}

			if (await pullRepo(SHARED_LIBS, cwd)) {
				await installAndFix(SHARED_LIBS, cwd);
				changed = true;
			}
		}
	}

	if (!changed) {
		return;
	}

	//One at a time, so a box full of apps doesn't all go down at the same moment
	log(`${SHARED_LIBS} changed, restarting everything that requires it`, true);

	for (const entry of handled) {
		if (restarted.has(entry.name)) {
			continue;
		}

		await new Promise(resolve => pm2.restart(entry.name, () => resolve()));
		log(`Restarted for ${SHARED_LIBS}: ${entry.name}`, true);
	}
}

/**
 * log(message, [force = false])
 * Logs a message to the console as this module.
 *
 * @param {String}    message    The message to log.
 * @param {Boolean} force        Whether to force log the message regardless of logging setting.
 */
function log(message, force = false) {
	if (!force && !io.getConfig()?.logging) {
		return;
	}
	return console.log("[auto-pull]:", message);
}

// pm2 module configuration and initialization.
io.init({
	human_info: [
		["Update Check Interval", `${io.getConfig()?.interval || 15000}ms`],
		["Last Check", (LAST_CHECK ? new Date(LAST_CHECK).toLocaleString() : "Never")],
		["Verbose Logging", io.getConfig()?.logging ? "Enabled" : "Disabled"]
	]
}).initModule({}, (error) => {
	if (error) {
		return console.error("[auto-pull]: Failed to initialize module!", error);
	}

	// Parse interval value.
	let FETCH_INTERVAL = parseInt(io.getConfig()?.interval); // How often to check for updates (in ms)
	if (!FETCH_INTERVAL || FETCH_INTERVAL < 1000) {
		FETCH_INTERVAL = 15000;
	} // Fallback to default if invalid value provided.

	pm2.connect(() => {
		setInterval(fetchLatestVersion, FETCH_INTERVAL); // Start fetching latest version every interval.
		log(`Connected to pm2 instance and now updating git every ${FETCH_INTERVAL}ms!`, true);
	});
});
