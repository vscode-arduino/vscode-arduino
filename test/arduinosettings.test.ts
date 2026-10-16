// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as assert from "assert";
import { parseCliDirectoriesConfig } from "../src/arduino/arduinoSettings";

const testDataPath = "C:\\test-arduino-data";
const testUserPath = "C:\\test-arduino-user";

suite("Arduino settings: Arduino CLI directories", () => {
    test("reads configured data and user directories", () => {
        const directories = parseCliDirectoriesConfig(JSON.stringify({
            directories: { data: testDataPath, user: testUserPath },
        }));
        assert.equal(directories.data, testDataPath);
        assert.equal(directories.user, testUserPath);
    });

    test("accepts CLI output with capitalized directory keys", () => {
        const directories = parseCliDirectoriesConfig(JSON.stringify({
            Directories: { Data: testDataPath, User: testUserPath },
        }));
        assert.equal(directories.data, testDataPath);
        assert.equal(directories.user, testUserPath);
    });

    test("accepts CLI versions that wrap config dump output", () => {
        const directories = parseCliDirectoriesConfig(JSON.stringify({
            config: { directories: { data: testDataPath, user: testUserPath } },
        }));
        assert.equal(directories.data, testDataPath);
        assert.equal(directories.user, testUserPath);
    });

    test("ignores empty, malformed, or invalid paths so defaults can be used", () => {
        assert.deepEqual(parseCliDirectoriesConfig("not json"), {});
        assert.deepEqual(parseCliDirectoriesConfig(JSON.stringify({
            directories: { data: "  ", user: 3 },
        })), {});
    });
});
