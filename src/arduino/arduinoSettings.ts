// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as childProcess from "child_process";
import { constants as fsconstants, promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as WinReg from "winreg";
import * as util from "../common/util";
import { ArduinoWorkspace } from "../common/workspace";

import { messages } from "../common/constants";
import { resolveArduinoPath } from "../common/platform";

import * as Logger from "../logger/logger";
import { VscodeSettings } from "./vscodeSettings";

export interface IArduinoSettings {
    arduinoPath: string;
    commandPath: string;
    defaultExamplePath: string;
    packagePath: string;
    defaultPackagePath: string;
    defaultLibPath: string;
    sketchbookPath: string;
    preferencePath: string;
    preferences: Map<string, string>;
    useArduinoCli: boolean;
    useLocalArduinoCliConfigFile: boolean;
    usingBundledArduinoCli: boolean;
    analyzeOnSettingChange: boolean;
    reloadPreferences(): void;
}

export function parseCliDirectoriesConfig(output: string): { data?: string; user?: string } {
    try {
        const parsed = JSON.parse(output);
        const config = parsed.config || parsed;
        const directories = config.directories || config.Directories || {};
        const valid = (value: any): string | undefined => {
            return typeof value === "string" && value.trim() && value.indexOf("\0") < 0 ? value.trim() : undefined;
        };
        return {
            data: valid(directories.data || directories.Data),
            user: valid(directories.user || directories.User),
        };
    } catch {
        return {};
    }
}

export class ArduinoSettings implements IArduinoSettings {
    private _arduinoPath: string;

    private _commandPath: string;

    private _packagePath: string;

    private _sketchbookPath: string;

    private _preferences: Map<string, string>;

    private _useArduinoCli: boolean;

    private _useLocalArduinoCliConfigFile: boolean;

    private _usingBundledArduinoCli: boolean = false;

    private readonly bundledArduinoCliName: { [platform: string]: string } = {
        "darwin-arm64": "arduino-cli.app",
        "darwin-x64": "arduino-cli.app",
        "linux-arm64": "arduino-cli.app",
        "linux-armhf": "arduino-cli.app",
        "linux-x64": "arduino-cli.app",
        "win32-ia32": "arduino-cli.exe",
        "win32-x64": "arduino-cli.exe",
    };

    public constructor(private readonly _context: vscode.ExtensionContext) {
    }

    public async initialize() {
        const platform = os.platform();
        this._commandPath = VscodeSettings.getInstance().commandPath;
        this._useArduinoCli = VscodeSettings.getInstance().useArduinoCli;
        this._useLocalArduinoCliConfigFile = VscodeSettings.getInstance().useLocalArduinoCliConfigFile;
        await this.tryResolveArduinoPath();
        if (platform === "win32") {
            await this.updateWindowsPath();
            if (this._commandPath === "") {
                this._useArduinoCli ? this._commandPath = "arduino-cli.exe" : this._commandPath = "arduino_debug.exe";
            }
        } else if (platform === "linux") {
            if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
                this._packagePath = path.join(this._arduinoPath, "portable");
            } else {
                this._packagePath = path.join(process.env.HOME, ".arduino15");
            }

            if (this.preferences.get("sketchbook.path")) {
                if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
                    this._sketchbookPath = path.join(this._arduinoPath, "portable", this.preferences.get("sketchbook.path"));
                } else {
                    this._sketchbookPath = this.preferences.get("sketchbook.path");
                }
            } else {
                this._sketchbookPath = path.join(process.env.HOME, "Arduino");
            }

            if (this._commandPath === "" && !this._useArduinoCli) {
                this._commandPath = "arduino";
            }
        } else if (platform === "darwin") {
            if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
                this._packagePath = path.join(this._arduinoPath, "portable");
            } else {
                this._packagePath = path.join(process.env.HOME, "Library/Arduino15");
            }

            if (this.preferences.get("sketchbook.path")) {
                if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
                    this._sketchbookPath = path.join(this._arduinoPath, "portable", this.preferences.get("sketchbook.path"));
                } else {
                    this._sketchbookPath = this.preferences.get("sketchbook.path");
                }
            } else {
                this._sketchbookPath = path.join(process.env.HOME, "Documents/Arduino");
            }

            if (this._commandPath === "" && !this._useArduinoCli) {
                this._commandPath = "/Contents/MacOS/Arduino";
            }
        }

        // Ask the selected CLI to resolve its own configuration. This honors its
        // config file discovery and environment overrides without parsing YAML.
        if (this._useArduinoCli) {
            await this.updateCliDirectories();
        }
    }

    public get arduinoPath(): string {
        return this._arduinoPath;
    }

    public get defaultExamplePath(): string {
        if (os.platform() === "darwin") {
            return path.join(util.resolveMacArduinoAppPath(this._arduinoPath, this._useArduinoCli), "/Contents/Java/examples");
        } else {
            return path.join(this._arduinoPath, "examples");
        }
    }

    public get packagePath(): string {
        return this._packagePath;
    }

    public get defaultPackagePath(): string {
        if (os.platform() === "darwin") {
            return path.join(util.resolveMacArduinoAppPath(this._arduinoPath, this._useArduinoCli), "/Contents/Java/hardware");
        } else { // linux and win32.
            return path.join(this._arduinoPath, "hardware");
        }
    }

    public get defaultLibPath(): string {
        if (os.platform() === "darwin") {
            return path.join(util.resolveMacArduinoAppPath(this._arduinoPath, this._useArduinoCli), "/Contents/Java/libraries");
        } else { // linux and win32
            return path.join(this._arduinoPath, "libraries");
        }
    }

    public get commandPath(): string {
        const platform = os.platform();
        if (platform === "darwin" && !this._usingBundledArduinoCli) {
            return path.join(util.resolveMacArduinoAppPath(this._arduinoPath, this._useArduinoCli), path.normalize(this._commandPath));
        } else {
            return path.join(this._arduinoPath, path.normalize(this._commandPath));
        }
    }

    public get sketchbookPath() {
        return this._sketchbookPath;
    }

    public get preferencePath() {
        return path.join(this.packagePath, "preferences.txt");
    }

    public get preferences() {
        if (!this._preferences) {
            this._preferences = util.parseConfigFile(this.preferencePath);
        }
        return this._preferences;
    }

    public get useArduinoCli() {
        return this._useArduinoCli;
    }

    get useLocalArduinoCliConfigFile() {
        return this._useLocalArduinoCliConfigFile;
    }

    public get usingBundledArduinoCli() {
        return this._usingBundledArduinoCli;
    }
    public get analyzeOnSettingChange(): boolean {
        return VscodeSettings.getInstance().analyzeOnSettingChange;
    }

    public reloadPreferences() {
        this._preferences = util.parseConfigFile(this.preferencePath);
        if (this.preferences.get("sketchbook.path")) {
            if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
                this._sketchbookPath = path.join(this._arduinoPath, "portable", this.preferences.get("sketchbook.path"));
            } else {
                this._sketchbookPath = this.preferences.get("sketchbook.path");
            }
        }
    }

    /**
     * For Windows platform, there are two situations here:
     *  - User change the location of the default *Documents* folder.
     *  - Use the windows store Arduino app.
     */
    private async updateWindowsPath(): Promise<void> {
        let folder;
        try {
            folder = await util.getRegistryValues(WinReg.HKCU,
                "\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
                "Personal");
        } catch (ex) {
        }
        if (!folder) {
            folder = path.join(process.env.USERPROFILE, "Documents");
        }
        // For some case, docFolder parsed from win32 registry looks like "%USERPROFILE%\Documents,
        // Should replace the environment variables with actual value.
        folder = folder.replace(/%([^%]+)%/g, (match, p1) => {
            return process.env[p1];
        });
        if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
            this._packagePath = path.join(this._arduinoPath, "portable");
        } else if (util.fileExistsSync(path.join(this._arduinoPath, "AppxManifest.xml"))) {
            this._packagePath = path.join(folder, "ArduinoData");
        } else if (process.env.hasOwnProperty("ARDUINO_DIRECTORIES_DATA")) {
            this._packagePath = this.validDirectoryValue(process.env.ARDUINO_DIRECTORIES_DATA) || path.join(process.env.LOCALAPPDATA, "Arduino15");
        } else {
            this._packagePath = path.join(process.env.LOCALAPPDATA, "Arduino15");
        }

        if (this.preferences.get("sketchbook.path")) {
            if (util.directoryExistsSync(path.join(this._arduinoPath, "portable"))) {
                this._sketchbookPath = path.join(this._arduinoPath, "portable", this.preferences.get("sketchbook.path"));
            } else {
                this._sketchbookPath = this.preferences.get("sketchbook.path");
            }
        } else {
            this._sketchbookPath = path.join(folder, "Arduino");
        }
    }

    private async updateCliDirectories(): Promise<void> {
        const cliPath = this.commandPath;
        const configFileArgs: string[] = [];
        if (this._useLocalArduinoCliConfigFile) {
            const workspacePath = ArduinoWorkspace.rootPath;
            if (workspacePath) {
                configFileArgs.push("--config-file", path.join(workspacePath, "arduino-cli.yaml"));
            }
        }
        let lastError: Error;
        for (const formatArgs of [["--format", "json"], ["--json"]]) {
            try {
                const output: string = await new Promise((resolve, reject) => {
                    childProcess.execFile(cliPath, ["config", "dump", ...formatArgs, ...configFileArgs], { windowsHide: true }, (error, stdout) => {
                        if (error) {
                            reject(error);
                        } else {
                            resolve(stdout);
                        }
                    });
                });
                const directories = parseCliDirectoriesConfig(output);
                const dataPath = this.validDirectoryValue(directories.data);
                const userPath = this.validDirectoryValue(directories.user);
                if (!dataPath && !userPath) {
                    throw new Error("CLI returned no valid directories.data or directories.user values");
                }
                if (dataPath) {
                    this._packagePath = path.resolve(dataPath);
                }
                if (userPath) {
                    this._sketchbookPath = path.resolve(userPath);
                }
                if (!dataPath || !userPath) {
                    const missingDirectory = dataPath ? "user" : "data";
                    Logger.warn(`Arduino CLI configuration did not provide a valid directories.${missingDirectory} value (CLI: ${cliPath}).`);
                }
                return;
            } catch (error) {
                lastError = error;
            }
        }
        Logger.warn(`Unable to read Arduino CLI directories using "${cliPath} config dump". Falling back to extension defaults. ${lastError}`);
    }

    private validDirectoryValue(value: any): string | undefined {
        if (typeof value !== "string" || !value.trim() || value.indexOf("\0") >= 0) {
            return undefined;
        }
        return value.trim();
    }

    private async bundledArduinoCliPath(): Promise<string | undefined> {
        const platform = await util.getPlatform();
        const name = this.bundledArduinoCliName[platform];
        if (!name) {
            return undefined;
        }
        return this._context.asAbsolutePath(path.join("assets", "platform", platform, "arduino-cli", name));
    }

    private async tryResolveArduinoPath(): Promise<void> {
        // Query arduino path sequentially from the following places such as "vscode user settings", "system environment variables",
        // "usual software installation directory for each os".
        // 1. Search vscode user settings first.
        const configValue = VscodeSettings.getInstance().arduinoPath;
        if (!configValue || !configValue.trim()) {
            // 2. Resolve arduino path from the bundled arduino-cli, if CLI support is enabled.
            const bundledPath = await this.bundledArduinoCliPath();
            if (bundledPath && this._useArduinoCli && !this._commandPath) {
                // The extension VSIX stripped the executable bit, so we need to set it.
                // 0x755 means rwxr-xr-x (read and execute for everyone, write for owner).
                // There have been reports of the executable bit already being set on M1
                // Macs, but this call failing, so first check to see if the file is
                // already executable.
                // https://github.com/microsoft/vscode-arduino/issues/1599
                let isExecutable = false;
                try {
                    await fs.access(bundledPath, fsconstants.X_OK);
                    isExecutable = true;
                } catch {
                    // Nothing to do. isExecutable is already false.
                }

                if (!isExecutable) {
                    try {
                        await fs.chmod(bundledPath, 0o755);
                    } catch (e) {
                        Logger.notifyUserError("arduino-cli-not-executable", e, messages.ARDUINO_CLI_NOT_EXECUTABLE + " " + bundledPath);
                    }
                }

                this._usingBundledArduinoCli = true;
                Logger.traceUserData("using-bundled-arduino-cli");
                this._arduinoPath = path.dirname(bundledPath);
                this._commandPath = path.basename(bundledPath);
            } else {
                // 3 & 4. Resolve arduino path from system environment variables and usual software installation directory.
                this._arduinoPath = await Promise.resolve(resolveArduinoPath());
            }
        } else {
            this._arduinoPath = configValue;
        }
    }
}
