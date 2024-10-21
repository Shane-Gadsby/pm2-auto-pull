const io = require("@pm2/io");
const pm2 = require("pm2");
const fs = require("fs");
const async = require("async");
var exec = require('child_process').exec

let IS_FETCHING = false; // Whether we are currently fetching the latest version for all processes.
let LAST_CHECK = false; // The last time we checked for updates.

/**
 * fetchLatestVersion()
 * Fetches the latest git version for all connected pm2 processes.
 */
async function fetchLatestVersion() {
    if (IS_FETCHING) return; // Already fetching, skip.

    log("Fetching latest version for all processes..");
    LAST_CHECK = Date.now();

    return new Promise(async (resolve, reject) => {

        console.log(pm2.reload)
        // Fetch all processes.
        pm2.list((error, allProcesses) => {

            //Interate over them all
            allProcesses.forEach(async process => {

                //Are they up, have a git repo, not a module, and not using stash?
                if (process.pm2_env.status === 'online' && process.pm2_env.versioning && !process.pm2_env.axm_options?.isModule && process.pm2_env.versioning.url.indexOf('stash.usq') === -1 && process.name.indexOf('auto-pull') === -1) {

                    //Pull and reload them process
                    pm2.pullAndReload(process.name, (error, metadata) => {


                        //Got an error that wasn't that it was already up tom date?
                        if (!!error && error?.msg !== "Already up to date") {

                            //Log it
                            console.trace(`Error fetching updates for process: ${process.name}`, error);
                        }

                        //No errors, or the error was just that it was up to date already
                        else {

                            //Was it not to date?
                            if (error?.msg !== "Already up to date") {

                                //Log it
                                console.log(`Updates fetched for: ${process.name}`);
                                exec('npm install', (error, stdout, stderr) => {
                                    pm2.restart(process.name, () => {});
                                }, {cwd: process.pm2_env.versioning.repo_path});
                            }

                            //Was it up to date?
                            else {

                                //Log it
                                console.log(`Already up to date: ${process.name}`);
                            }
                        }

                    });

                }

                //Didn't match the above, but WAS a stash url?
                else if (process.pm2_env?.versioning?.url.indexOf('stash.usq') > -1) {

                    //Log that we're skipping it
                    console.log(`[Skipping] Process using defuct repo: ${process.name} (${process.pm2_env.versioning.url})`);
                }

                //Catch the rest
                else {

                    //Log that we're skipping it
                    console.log(`[Skipping] Process not considererd: ${process.name}`);
                }
            })

        });
    });
}

/**
 * log(message, [force = false])
 * Logs a message to the console as this module.
 *
 * @param {String}    message    The message to log.
 * @param {Boolean} force        Whether to force log the message regardless of logging setting.
 */
function log(message, force = false) {
    if (!force && !io.getConfig()?.logging) return;
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
    if (error) return console.error("[auto-pull]: Failed to initialize module!", error);

    // Parse interval value.
    let FETCH_INTERVAL = parseInt(io.getConfig()?.interval); // How often to check for updates (in ms)
    if (!FETCH_INTERVAL || FETCH_INTERVAL < 1000) FETCH_INTERVAL = 15000; // Fallback to default if invalid value provided.

    pm2.connect(() => {
        setInterval(fetchLatestVersion, FETCH_INTERVAL); // Start fetching latest version every interval.
        log(`Connected to pm2 instance and now updating git every ${FETCH_INTERVAL}ms!`, true);
    });
});
