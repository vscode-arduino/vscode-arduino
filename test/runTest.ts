import * as childProcess from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { runTests } from "vscode-test";

const extractZip = require("extract-zip") as (archivePath: string, options: { dir: string }) => Promise<void>;
const download = require("download") as (url: string) => Promise<Buffer>;
const glob = require("glob");
const execFile = promisify(childProcess.execFile);

const arduinoIdeVersion = "1.8.19";
const windowsArduinoIdeHash = "c704a821089eab2588f1deae775916219b1517febd1dd574ff29958dca873945";
const linuxArduinoIdeHash = "eb68bddc1d1c0120be2fca1350a03ee34531cf37f51847b21210b6e70545bc9b";

interface ITestMode {
    name: string;
    settings: { [key: string]: string | boolean | string[] };
    environment: { [key: string]: string };
    packageStagingPath: string;
    libraryStagingPath: string;
}

interface ITestArchive {
    name: string;
    url: string;
    checksum: string;
}

async function seedIndexFiles(dataPath: string): Promise<void> {
    const fixturePath = path.resolve(__dirname, "../../test/resources/Arduino15");
    await fs.promises.mkdir(dataPath, { recursive: true });
    await Promise.all(["package_index.json", "library_index.json"].map((fileName) => {
        return fs.promises.copyFile(path.join(fixturePath, fileName), path.join(dataPath, fileName));
    }));
}

async function clearInstalledTestPackages(packagePath: string, libraryPath: string): Promise<void> {
    await Promise.all([
        fs.promises.rm(packagePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }),
        fs.promises.rm(path.dirname(libraryPath), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }),
    ]);
    await fs.promises.mkdir(path.dirname(libraryPath), { recursive: true });
}

async function getTestArchives(): Promise<ITestArchive[]> {
    const fixturePath = path.resolve(__dirname, "../../test/resources/Arduino15");
    const packageIndex = JSON.parse(await fs.promises.readFile(path.join(fixturePath, "package_index.json"), "utf8"));
    const libraryIndex = JSON.parse(await fs.promises.readFile(path.join(fixturePath, "library_index.json"), "utf8"));
    const microsoftPackage = packageIndex.packages.find((pkg) => pkg.name === "Microsoft");
    const microsoftPlatform = microsoftPackage.platforms.find((platform) => {
        return platform.architecture === "win10" && platform.version === "1.1.2";
    });
    const fastLed = libraryIndex.libraries.find((library) => library.name === "FastLED" && library.version === "3.1.3");
    if (!microsoftPlatform || !fastLed) {
        throw new Error("The test package index fixtures must contain Microsoft win10 1.1.2 and FastLED 3.1.3.");
    }

    return [microsoftPlatform, fastLed].map((entry) => ({
        name: entry.archiveFileName,
        url: entry.url,
        checksum: entry.checksum.replace(/^SHA-256:/, ""),
    }));
}

async function ensureArchive(testRoot: string, archive: ITestArchive): Promise<string> {
    const archiveRoot = path.join(testRoot, "arduino-test-archives");
    const archivePath = path.join(archiveRoot, archive.name);
    await fs.promises.mkdir(archiveRoot, { recursive: true });
    if (fs.existsSync(archivePath) && await sha256(archivePath) === archive.checksum) {
        return archivePath;
    }

    await fs.promises.rm(archivePath, { force: true });
    process.stdout.write(`Downloading test package ${archive.name}...\n`);
    const downloadedArchive = await download(archive.url);
    await fs.promises.writeFile(archivePath, downloadedArchive);
    const actualHash = await sha256(archivePath);
    if (actualHash !== archive.checksum) {
        await fs.promises.rm(archivePath, { force: true });
        throw new Error(`Test package checksum mismatch for ${archive.name}: expected ${archive.checksum}, got ${actualHash}.`);
    }
    return archivePath;
}

async function stageTestArchives(testRoot: string, modes: ITestMode[]): Promise<void> {
    const archives = await getTestArchives();
    for (const archive of archives) {
        const cachedPath = await ensureArchive(testRoot, archive);
        for (const mode of modes) {
            const destinationPath = archive.name.toLowerCase().includes("fastled")
                ? mode.libraryStagingPath
                : mode.packageStagingPath;
            await fs.promises.mkdir(destinationPath, { recursive: true });
            await fs.promises.copyFile(cachedPath, path.join(destinationPath, archive.name));
        }
    }
}

async function sha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const input = fs.createReadStream(filePath);
        input.on("data", (chunk) => hash.update(chunk));
        input.on("error", reject);
        input.on("end", () => resolve(hash.digest("hex")));
    });
}

function isValidArduinoIde(arduinoPath: string): boolean {
    if (!arduinoPath) {
        return false;
    }

    let executablePath: string;
    if (process.platform === "win32") {
        executablePath = path.join(arduinoPath, "arduino_debug.exe");
    } else if (process.platform === "darwin") {
        const appPath = /Arduino.*\.app$/.test(arduinoPath) ? arduinoPath : path.join(arduinoPath, "Arduino.app");
        executablePath = path.join(appPath, "Contents", "MacOS", "Arduino");
    } else {
        executablePath = path.join(arduinoPath, "arduino");
    }
    return fs.existsSync(executablePath);
}

async function downloadArduinoIde(testRoot: string): Promise<string> {
    let archiveName: string;
    let downloadUrl: string;
    let expectedHash: string;

    if (process.platform === "win32") {
        archiveName = `arduino-${arduinoIdeVersion}-windows.zip`;
        downloadUrl = `https://downloads.arduino.cc/${archiveName}`;
        expectedHash = windowsArduinoIdeHash;
    } else if (process.platform === "linux") {
        archiveName = `arduino-${arduinoIdeVersion}-linux64.tar.xz`;
        downloadUrl = `https://downloads.arduino.cc/${archiveName}`;
        expectedHash = linuxArduinoIdeHash;
    } else if (process.platform === "darwin") {
        archiveName = `arduino-${arduinoIdeVersion}-macosx.zip`;
        downloadUrl = `https://downloads.arduino.cc/${archiveName}`;
    } else {
        throw new Error(`Arduino IDE 1 integration tests are not supported on ${process.platform}.`);
    }

    const installRoot = path.join(testRoot, `arduino-ide-${arduinoIdeVersion}`);
    const archivePath = path.join(testRoot, archiveName);
    const existingApp = process.platform === "darwin"
        ? glob.sync("**/Arduino.app", { cwd: installRoot, absolute: true })[0]
        : path.join(installRoot, `arduino-${arduinoIdeVersion}`);
    if (existingApp && isValidArduinoIde(existingApp)) {
        return existingApp;
    }

    await fs.promises.rm(installRoot, { recursive: true, force: true });
    await fs.promises.mkdir(installRoot, { recursive: true });
    process.stdout.write(`Downloading Arduino IDE ${arduinoIdeVersion} for the IDE 1 integration tests...\n`);
    await execFile("curl", [
        "--fail",
        "--location",
        "--retry", "3",
        "--silent",
        "--show-error",
        "--output", archivePath,
        downloadUrl,
    ], { windowsHide: true });

    try {
        if (expectedHash) {
            const actualHash = await sha256(archivePath);
            if (actualHash !== expectedHash) {
                throw new Error(`Arduino IDE archive checksum mismatch: expected ${expectedHash}, got ${actualHash}.`);
            }
        }

        if (archiveName.endsWith(".zip")) {
            await extractZip(archivePath, { dir: installRoot });
        } else {
            await execFile("tar", ["-xf", archivePath, "-C", installRoot], { windowsHide: true });
        }
    } finally {
        await fs.promises.rm(archivePath, { force: true });
    }

    const arduinoPath = process.platform === "darwin"
        ? glob.sync("**/Arduino.app", { cwd: installRoot, absolute: true })[0]
        : path.join(installRoot, `arduino-${arduinoIdeVersion}`);
    if (!isValidArduinoIde(arduinoPath)) {
        throw new Error(`Arduino IDE ${arduinoIdeVersion} was downloaded, but its executable was not found under ${installRoot}.`);
    }

    return arduinoPath;
}

async function resolveArduinoIde(testRoot: string): Promise<string> {
    const installRoot = path.join(testRoot, `arduino-ide-${arduinoIdeVersion}`);
    const cachedPath = process.platform === "darwin"
        ? glob.sync("**/Arduino.app", { cwd: installRoot, absolute: true })[0]
        : path.join(installRoot, `arduino-${arduinoIdeVersion}`);
    if (cachedPath && isValidArduinoIde(cachedPath)) {
        process.stdout.write(`Using cached Arduino IDE ${arduinoIdeVersion} at ${cachedPath}.\n`);
        return cachedPath;
    }
    return downloadArduinoIde(testRoot);
}

async function writeUserSettings(userDataDir: string, settings: { [key: string]: string | boolean | string[] }): Promise<void> {
    const userSettingsDir = path.join(userDataDir, "User");
    await fs.promises.mkdir(userSettingsDir, { recursive: true });
    await fs.promises.writeFile(
        path.join(userSettingsDir, "settings.json"),
        JSON.stringify(settings, null, 2),
        "utf8",
    );
}

async function createCliTestMode(testRoot: string): Promise<ITestMode> {
    const cliRoot = path.join(testRoot, "arduino-cli-test");
    const homeDir = path.join(cliRoot, "home");
    const isWindows = process.platform === "win32";
    const directories = {
        data: isWindows ? path.join(cliRoot, "data") : process.platform === "darwin"
            ? path.join(homeDir, "Library", "Arduino15")
            : path.join(homeDir, ".arduino15"),
        user: isWindows ? path.join(cliRoot, "user") : process.platform === "darwin"
            ? path.join(homeDir, "Documents", "Arduino")
            : path.join(homeDir, "Arduino"),
        downloads: path.join(cliRoot, "downloads"),
    };
    await Promise.all(Object.keys(directories).map((key) => fs.promises.mkdir(directories[key], { recursive: true })));
    await fs.promises.mkdir(path.join(directories.user, "libraries"), { recursive: true });
    await seedIndexFiles(directories.data);
    await clearInstalledTestPackages(
        path.join(directories.data, "packages", "Microsoft"),
        path.join(directories.user, "libraries", "FastLED"),
    );

    const sketchbookPath = path.resolve(directories.user).replace(/\\/g, "/");
    await fs.promises.writeFile(
        path.join(directories.data, "preferences.txt"),
        `sketchbook.path=${sketchbookPath}${os.EOL}boardsmanager.additional.urls=${os.EOL}`,
        "utf8",
    );

    const configFile = path.join(cliRoot, "arduino-cli.yaml");
    await fs.promises.writeFile(configFile, JSON.stringify({ directories }, null, 2), "utf8");

    return {
        name: "Arduino CLI",
        settings: {
            "arduino.useArduinoCli": true,
            "arduino.useLocalArduinoCliConfigFile": false,
            "arduino.path": "",
            "arduino.commandPath": "",
        },
        environment: {
            ARDUINO_CONFIG_FILE: configFile,
            ARDUINO_DIRECTORIES_DATA: directories.data,
            ARDUINO_DIRECTORIES_USER: directories.user,
            ARDUINO_DIRECTORIES_DOWNLOADS: directories.downloads,
            ...(!isWindows ? { HOME: homeDir } : {}),
        },
        packageStagingPath: path.join(directories.downloads, "packages"),
        libraryStagingPath: path.join(directories.downloads, "libraries"),
    };
}

async function createLegacyTestMode(testRoot: string, arduinoPath: string): Promise<ITestMode> {
    const legacyRoot = path.join(testRoot, "arduino-ide-1-test");
    const homeDir = path.join(legacyRoot, "home");
    const isWindows = process.platform === "win32";
    const dataPath = isWindows ? path.join(arduinoPath, "portable") : process.platform === "darwin"
        ? path.join(homeDir, "Library", "Arduino15")
        : path.join(homeDir, ".arduino15");
    const sketchbookPath = isWindows ? path.join(dataPath, "sketchbook") : path.join(legacyRoot, "sketchbook");
    const environment: { [key: string]: string } = {};

    if (isWindows) {
        // Arduino IDE 1 uses its portable folder instead of LOCALAPPDATA for test isolation.
        environment.ARDUINO_DIRECTORIES_DATA = "";
    }

    await Promise.all([
        fs.promises.mkdir(dataPath, { recursive: true }),
        fs.promises.mkdir(path.join(sketchbookPath, "libraries"), { recursive: true }),
    ]);
    await seedIndexFiles(dataPath);
    await clearInstalledTestPackages(
        path.join(dataPath, "packages", "Microsoft"),
        path.join(sketchbookPath, "libraries", "FastLED"),
    );
    const configuredSketchbookPath = isWindows ? "sketchbook" : path.resolve(sketchbookPath).replace(/\\/g, "/");
    await fs.promises.writeFile(
        path.join(dataPath, "preferences.txt"),
        `sketchbook.path=${configuredSketchbookPath}${os.EOL}boardsmanager.additional.urls=${os.EOL}`,
        "utf8",
    );

    return {
        name: "Arduino IDE 1",
        settings: {
            "arduino.useArduinoCli": false,
            "arduino.path": arduinoPath,
            "arduino.commandPath": "",
        },
        environment: {
            ...environment,
            ...(process.platform === "linux" || process.platform === "darwin" ? {
                HOME: homeDir,
                JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, `-Duser.home=${homeDir}`].filter(Boolean).join(" "),
            } : {}),
        },
        packageStagingPath: path.join(dataPath, "staging", "packages"),
        libraryStagingPath: path.join(dataPath, "staging", "libraries"),
    };
}

async function runTestMode(
    mode: ITestMode,
    extensionDevelopmentPath: string,
    extensionTestsPath: string,
    testWorkspace: string,
    testExtensionsDir: string,
    testRoot: string,
): Promise<void> {
    const userDataDir = path.join(testRoot, "user-data", mode.name === "Arduino CLI" ? "cli" : "ide1");
    await writeUserSettings(userDataDir, mode.settings);
    process.stdout.write(`Running extension tests with ${mode.name}...\n`);

    const platform = process.platform === "win32" && process.arch === "x64" ? "win32-x64-archive" : undefined;
    const exitCode = await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        platform,
        version: "1.63.2",
        extensionTestsEnv: mode.environment,
        launchArgs: [
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${testExtensionsDir}`,
            testWorkspace,
        ],
    });
    if (exitCode !== 0) {
        throw new Error(`${mode.name} integration tests exited with code ${exitCode}.`);
    }
}

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./index");
    const testWorkspace = path.resolve(__dirname, "../../test/resources/blink");
    const testRoot = path.join(extensionDevelopmentPath, ".vscode-test");
    const testExtensionsDir = path.join(testRoot, "extensions");
    const failures: string[] = [];

    try {
        await fs.promises.mkdir(testRoot, { recursive: true });
        const cliMode = await createCliTestMode(testRoot);
        let ide1Mode: ITestMode;
        if (process.platform === "darwin") {
            process.stdout.write("Skipping Arduino IDE 1 integration tests on macOS; Arduino CLI integration tests will still run.\n");
        } else {
            try {
                const arduinoPath = await resolveArduinoIde(testRoot);
                ide1Mode = await createLegacyTestMode(testRoot, arduinoPath);
            } catch (error) {
                failures.push(`Arduino IDE 1 setup failed: ${error}`);
            }
        }

        const modes = [cliMode];
        if (ide1Mode) {
            modes.push(ide1Mode);
        }

        try {
            await stageTestArchives(testRoot, modes);
        } catch (error) {
            failures.push(`Test package setup failed: ${error}`);
        }

        for (const mode of modes) {
            try {
                await runTestMode(
                    mode,
                    extensionDevelopmentPath,
                    extensionTestsPath,
                    testWorkspace,
                    testExtensionsDir,
                    testRoot,
                );
            } catch (error) {
                failures.push(`${mode.name} tests failed: ${error}`);
            }
        }

        if (failures.length) {
            throw new Error(failures.join(os.EOL));
        }
    } catch (err) {
        process.stderr.write(`Failed to run tests: ${err}\n`);
        process.exit(1);
    }
}

main();
