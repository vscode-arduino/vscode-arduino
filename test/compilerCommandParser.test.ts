import * as assert from "assert";
import * as ccp from "cocopa";
import * as path from "path";

import {
    ArduinoGccParser,
    IArduinoGccResult,
    preprocessGccCompilerCommand,
    resolveCppStandard,
    ResponseFileReader,
} from "../src/arduino/compilerCommandParser";

suite("Arduino: GCC compiler command parser", () => {

    test("expands nested response files and resolves prefixed include paths", () => {
        const cwd = path.resolve("test", "resources", "compiler-command");
        const mainFlags = path.join(cwd, "flags", "all");
        const defines = path.join(cwd, "flags", "defines");
        const includes = path.join(cwd, "flags", "includes");
        const cppFlags = path.join(cwd, "flags", "cpp_flags");
        const sdkInclude = path.join(cwd, "SDK Root", "include") + "/";
        const directInclude = path.join(cwd, "Direct Include");
        const systemInclude = path.join(cwd, "System Include");

        const files = new Map<string, string>([
            [mainFlags, [
                `@"${defines}"`,
                `-iprefix "${sdkInclude}"`,
                `@"${includes}"`,
                `@"${cppFlags}"`,
                `-I "${directInclude}"`,
                `-isystem "${systemInclude}"`,
            ].join(" ")],
            [defines, "-DIDF_VER=\\\"v5.5.5\\\" -DESP_PLATFORM"],
            [includes, [
                "-iwithprefixbefore freertos/config/include",
                "-iwithprefixbefore \"component with spaces/include\"",
            ].join(" ")],
            [cppFlags, "-std=gnu++2b -fexceptions -std=gnu++2a"],
        ]);
        const readResponseFile: ResponseFileReader = (filePath) => {
            const content = files.get(path.normalize(filePath));
            if (content === undefined) {
                throw new Error(`Unexpected response file: ${filePath}`);
            }
            return content;
        };

        const compiler = path.join(cwd, "Tool Chain", "xtensa-esp32s3-elf-g++");
        const result = preprocessGccCompilerCommand(
            `"${compiler}" @"${mainFlags}" -c sketch.ino.cpp`,
            cwd,
            readResponseFile,
        );

        assert.equal(result.command.includes("@"), false);
        assert.equal(result.arguments.includes(`-I${path.join(sdkInclude, "freertos/config/include")}`), true);
        assert.equal(result.arguments.includes(`-I${path.join(sdkInclude, "component with spaces/include")}`), true);
        assert.equal(result.arguments.includes(`-I${directInclude}`), true);
        assert.equal(result.arguments.includes(`-I${systemInclude}`), true);
        assert.equal(result.arguments.includes("-DIDF_VER=\"v5.5.5\""), true);
        assert.equal(result.cppStandard, "gnu++20");
    });

    test("uses the last C++ standard option and preserves the GNU dialect", () => {
        assert.equal(resolveCppStandard(["-std=gnu++2b", "-std=gnu++2a"]), "gnu++20");
        assert.equal(resolveCppStandard(["-std=gnu++2b", "-std=gnu++17"]), "gnu++17");
        assert.equal(resolveCppStandard(["-std=c++2b"]), "c++23");
        assert.equal(resolveCppStandard(["-std=gnu++2c"]), "gnu++26");
        assert.equal(resolveCppStandard(["-Wall"]), undefined);
    });

    test("passes expanded arguments through the CoCoPa runner", () => {
        const cwd = path.resolve("test", "resources", "compiler-command");
        const responseFile = path.join(cwd, "compiler.flags");
        const sdkInclude = path.join(cwd, "sdk", "include") + "/";
        const readResponseFile: ResponseFileReader = (filePath) => {
            assert.equal(path.normalize(filePath), responseFile);
            return [
                `-iprefix "${sdkInclude}"`,
                "-iwithprefixbefore freertos/include",
                "-DARDUINO_ARCH_ESP32",
                "-std=gnu++2a",
            ].join(" ");
        };
        const parser = new ArduinoGccParser(
            ccp.getTriggerForArduinoGcc("sketch.ino"),
            cwd,
            readResponseFile,
        );
        parser.infoParser.enabled = false;
        const runner = new ccp.Runner([parser]);
        const compiler = path.join(cwd, "toolchain", "xtensa-esp32-elf-g++");

        runner.parse(
            [
                `"${compiler}"`,
                `@"${responseFile}"`,
                `-c "${path.join(cwd, "sketch.ino.cpp")}"`,
                `-o "${path.join(cwd, "sketch.ino.cpp.o")}"`,
            ].join(" "),
        );

        const result = runner.result as IArduinoGccResult;
        assert.ok(result);
        assert.deepEqual(result.includes, [path.join(sdkInclude, "freertos/include")]);
        assert.equal(result.defines.includes("ARDUINO_ARCH_ESP32"), true);
        assert.equal(result.options.includes("-std=gnu++2a"), true);
        assert.equal(result.effectiveCppStandard, "gnu++20");
    });

    test("keeps unreadable response files and prevents recursive expansion loops", () => {
        const cwd = path.resolve("test", "resources", "compiler-command");
        const first = path.join(cwd, "first.flags");
        const second = path.join(cwd, "second.flags");
        const missing = path.join(cwd, "missing.flags");
        const files = new Map<string, string>([
            [first, `@"${second}" -DFIRST`],
            [second, `@"${first}" -DSECOND`],
        ]);
        const readResponseFile: ResponseFileReader = (filePath) => {
            const content = files.get(path.normalize(filePath));
            if (content === undefined) {
                throw new Error("File not found");
            }
            return content;
        };

        const result = preprocessGccCompilerCommand(
            `xtensa-esp32-elf-g++ @"${first}" @"${missing}" sketch.ino.cpp`,
            cwd,
            readResponseFile,
        );

        assert.equal(result.command.includes("-DFIRST"), true);
        assert.equal(result.command.includes("-DSECOND"), true);
        assert.equal(result.command.includes(`@${first}`), true);
        assert.equal(result.command.includes(`@${missing}`), true);
    });

    test("collects forced includes without losing ordinary compiler options", () => {
        const cwd = path.resolve("test", "resources", "compiler-command");
        const forcedHeader = path.join(cwd, "Generated Config.h");
        const result = preprocessGccCompilerCommand(
            `g++ -include "${forcedHeader}" --sysroot "${cwd}" -Wall sketch.ino.cpp`,
            cwd,
        );

        assert.deepEqual(result.forcedIncludes, [forcedHeader]);
        assert.equal(result.command.includes(`--sysroot=${cwd}`), true);
        assert.equal(result.command.includes("-Wall"), true);
    });
});
