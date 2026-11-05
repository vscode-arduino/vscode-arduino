// Copyright (c) Elektronik Workshop. All rights reserved.
// Licensed under the MIT license.

import * as ccp from "cocopa";
import * as fs from "fs";
import * as path from "path";

const MAX_RESPONSE_FILE_DEPTH = 16;

export type ResponseFileReader = (filePath: string) => string;

export interface IPreprocessedGccCompilerCommand {
    arguments: string[];
    command: string;
    cppStandard?: string;
    forcedIncludes: string[];
}

export interface IArduinoGccResult extends ccp.Result {
    effectiveCppStandard?: string;
    forcedIncludes?: string[];
}

/**
 * GCC accepts command line arguments from @response files. Arduino platforms
 * use them for SDK include paths, defines and compiler flags, so IntelliSense
 * must expand them before passing the command to CoCoPa.
 */
export class ArduinoGccParser extends ccp.ParserGcc {

    constructor(
        trigger: ccp.IParserTrigger,
        private readonly workingDirectory: string = process.cwd(),
        private readonly readResponseFile: ResponseFileReader = defaultResponseFileReader,
    ) {
        super(trigger);
    }

    protected parse(line: string): ccp.Result {
        const preprocessed = preprocessGccCompilerCommand(
            line,
            this.workingDirectory,
            this.readResponseFile,
        );
        const result = super.parse(preprocessed.command) as IArduinoGccResult;
        result.effectiveCppStandard = preprocessed.cppStandard;
        result.forcedIncludes = preprocessed.forcedIncludes;
        return result;
    }
}

export function preprocessGccCompilerCommand(
    line: string,
    workingDirectory: string = process.cwd(),
    readResponseFile: ResponseFileReader = defaultResponseFileReader,
): IPreprocessedGccCompilerCommand {
    const initialArguments = splitGccArguments(line);
    const expandedArguments = expandResponseFiles(
        initialArguments,
        workingDirectory,
        readResponseFile,
    );
    const normalized = normalizeGccArguments(expandedArguments);

    return {
        arguments: normalized.arguments,
        command: normalized.arguments.map(quoteForShlex).join(" "),
        cppStandard: resolveCppStandard(normalized.arguments),
        forcedIncludes: normalized.forcedIncludes,
    };
}

/**
 * Finds the effective C++ standard. GCC applies repeated -std options in
 * command-line order, so the final option wins.
 */
export function resolveCppStandard(options: string[]): string | undefined {
    const aliases = new Map<string, string>([
        ["0x", "11"],
        ["1y", "14"],
        ["1z", "17"],
        ["2a", "20"],
        ["2b", "23"],
        ["2c", "26"],
    ]);
    let standard: string | undefined;

    for (const option of options) {
        const match = option.match(/^-std=(gnu\+\+|c\+\+)([a-z0-9]+)$/i);
        if (!match) {
            continue;
        }
        const version = aliases.get(match[2].toLowerCase()) || match[2];
        standard = `${match[1].toLowerCase()}${version}`;
    }

    return standard;
}

export function splitGccArguments(input: string): string[] {
    const result: string[] = [];
    let current = "";
    let quote: string | undefined;
    let tokenStarted = false;

    for (let index = 0; index < input.length; index++) {
        const character = input[index];

        if (quote) {
            if (character === quote) {
                quote = undefined;
                tokenStarted = true;
            } else if (character === "\\" && input[index + 1] === quote) {
                current += quote;
                tokenStarted = true;
                index++;
            } else {
                current += character;
                tokenStarted = true;
            }
            continue;
        }

        if (character === "\"" || character === "'") {
            quote = character;
            tokenStarted = true;
        } else if (/\s/.test(character)) {
            if (tokenStarted) {
                result.push(current);
                current = "";
                tokenStarted = false;
            }
        } else if (character === "\\" &&
                   (input[index + 1] === "\"" || input[index + 1] === "'")) {
            current += input[index + 1];
            tokenStarted = true;
            index++;
        } else {
            current += character;
            tokenStarted = true;
        }
    }

    if (tokenStarted) {
        result.push(current);
    }

    return result;
}

function defaultResponseFileReader(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
}

function expandResponseFiles(
    compilerArguments: string[],
    workingDirectory: string,
    readResponseFile: ResponseFileReader,
    activeFiles: string[] = [],
    depth: number = 0,
): string[] {
    const result: string[] = [];

    for (const argument of compilerArguments) {
        if (!argument.startsWith("@") || argument.length === 1) {
            result.push(argument);
            continue;
        }

        const responsePath = resolveResponseFilePath(argument.slice(1), workingDirectory);
        if (depth >= MAX_RESPONSE_FILE_DEPTH || activeFiles.indexOf(responsePath) !== -1) {
            result.push(argument);
            continue;
        }

        try {
            const content = readResponseFile(responsePath);
            const responseArguments = splitGccArguments(content);
            result.push(...expandResponseFiles(
                responseArguments,
                workingDirectory,
                readResponseFile,
                [...activeFiles, responsePath],
                depth + 1,
            ));
        } catch (error) {
            // Preserve unreadable response arguments for the compiler rather
            // than dropping information or aborting IntelliSense generation.
            result.push(argument);
        }
    }

    return result;
}

function resolveResponseFilePath(filePath: string, workingDirectory: string): string {
    return path.normalize(path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workingDirectory, filePath));
}

function normalizeGccArguments(
    compilerArguments: string[],
): { arguments: string[]; forcedIncludes: string[] } {
    const result: string[] = [];
    const forcedIncludes: string[] = [];
    let includePrefix = "";

    for (let index = 0; index < compilerArguments.length; index++) {
        const argument = compilerArguments[index];

        if (argument === "-iprefix") {
            includePrefix = compilerArguments[index + 1] || "";
            index++;
            continue;
        }
        if (argument.startsWith("-iprefix") && argument.length > "-iprefix".length) {
            includePrefix = argument.slice("-iprefix".length);
            continue;
        }

        const prefixedInclude = optionValue(
            compilerArguments,
            index,
            ["-iwithprefixbefore", "-iwithprefix"],
        );
        if (prefixedInclude) {
            result.push(`-I${path.normalize(includePrefix + prefixedInclude.value)}`);
            index += prefixedInclude.consumed;
            continue;
        }

        const include = optionValue(
            compilerArguments,
            index,
            ["-isystem", "-iquote", "-I"],
        );
        if (include) {
            result.push(`-I${path.normalize(include.value)}`);
            index += include.consumed;
            continue;
        }

        const forcedInclude = optionValue(compilerArguments, index, ["-include"]);
        if (forcedInclude) {
            forcedIncludes.push(path.normalize(forcedInclude.value));
            index += forcedInclude.consumed;
            continue;
        }

        if (argument === "--sysroot" && compilerArguments[index + 1]) {
            result.push(`--sysroot=${compilerArguments[index + 1]}`);
            index++;
            continue;
        }

        result.push(argument);
    }

    return { arguments: result, forcedIncludes };
}

function optionValue(
    compilerArguments: string[],
    index: number,
    options: string[],
): { consumed: number; value: string } | undefined {
    const argument = compilerArguments[index];

    for (const option of options) {
        if (argument === option) {
            const value = compilerArguments[index + 1];
            return value === undefined ? undefined : { consumed: 1, value };
        }
        if (argument.startsWith(option) && argument.length > option.length) {
            return { consumed: 0, value: argument.slice(option.length) };
        }
    }

    return undefined;
}

/**
 * CoCoPa tokenizes the reconstructed command with shlex. Single quotes keep
 * Windows backslashes literal; double-quoted fallback handles apostrophes.
 */
function quoteForShlex(argument: string): string {
    if (argument.indexOf("'") === -1) {
        return `'${argument}'`;
    }
    return `"${argument.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
