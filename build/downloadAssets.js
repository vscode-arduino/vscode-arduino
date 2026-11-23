// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This script downloads and verifies platform-specific arduino-cli binaries
// from GitHub releases. The release is specified by the "version" field in
// assets.json.

const { execFileSync } = require("child_process");
const { createHash } = require("crypto");
const { readFileSync, mkdirSync, rmSync, renameSync, existsSync } = require("fs");
const { resolve } = require("path");

// Without a shell, so that paths with spaces stay single arguments.
function run(program, args) {
  console.log([program, ...args].join(" "));
  execFileSync(program, args);
}

// On Windows, use the system's bsdtar: it extracts .zip files, while a GNU tar
// that comes first in PATH (Git for Windows, MSYS2) neither extracts them nor
// accepts a "C:\..." archive path.
const tar = process.platform === "win32"
  ? resolve(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";

const config = require('./assets.json');

for (const asset in config.assets) {
  if (Object.hasOwnProperty.call(config.assets, asset)) {
    const platforms = config.assets[asset].platforms;
    const hash = config.assets[asset].hash;
    for (const platform of platforms) {
      const directory = resolve(__dirname, "..", "assets", "platform", platform);
      const destination = resolve(directory, asset);
      const extractDirectory = resolve(directory, "arduino-cli");
      // Check if the asset has already been downloaded
      if (!existsSync(extractDirectory)) {

        // Download the asset.
        run("curl", [
          `https://github.com/arduino/arduino-cli/releases/download/${config.version}/${asset}`,
          "--location",
          "--output-dir", directory,
          "--remote-name",
          "--silent",
          "--show-error",
        ]);

        // Verify the hash.
        const actualHash = createHash("sha256")
          .update(readFileSync(destination))
          .digest("hex");
        if (actualHash !== hash) {
          throw new Error(
            `Hash mismatch for ${asset} on ${platform}. Expected ${hash} but got ${actualHash}.`
          );
        }
      

        // Extract to an "arduino-cli" directory.
        mkdirSync(extractDirectory, { recursive: true });
        // tar on Linux doesn't understand zip files.
        if (asset.endsWith(".zip") && process.platform === 'linux') {
          run("unzip", [destination, "-d", extractDirectory]);
        } else {
          run(tar, ["-xf", destination, "-C", extractDirectory]);
        }

        // Remove the downloaded archive. We don't need to ship it.
        rmSync(destination);

        // VSIX signing will silently strip any extensionless files. Artificially
        // add a ".app" extension to extensionless executables.
        const executable = resolve(extractDirectory, "arduino-cli");
        try {
          renameSync(executable, `${executable}.app`);
        } catch {
          // The file might not exist. This is expected for Windows.
        }
      }
    }
  }
}
