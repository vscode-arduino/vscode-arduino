import * as assert from "assert";
import * as Path from "path";
import * as util from "../src/common/util";

import ArduinoActivator from "../src/arduinoActivator";
import ArduinoContext from "../src/arduinoContext";

suite("Arduino: App Initialization", () => {

    // tslint:disable-next-line: only-arrow-functions
    setup(function(done) {
        this.timeout(2 * 60 * 1000);
        try {
            if (!ArduinoContext.initialized) {
                ArduinoActivator.activate().then(() => {
                    done();
                }).catch((error) => {
                    done(`Failed to activate extension: ${error}`);
                });
            } else {
                done();
            }
        } catch (error) {
            done(`Failed to activate extension: ${error}`);
        }
    });

    // tslint:disable-next-line: only-arrow-functions
    test("should be able to resolve arduino settings correctly", function(done) {
        const arduinoSettings = ArduinoContext.arduinoApp.settings;
        assert.equal(util.directoryExistsSync(arduinoSettings.arduinoPath), true,
        "should resolve arduino installation directory automatically");

        assert.equal(util.fileExistsSync(arduinoSettings.commandPath), true,
        "should resolve arduino executable correctly");

        if (arduinoSettings.useArduinoCli) {
            assert.equal(util.directoryExistsSync(arduinoSettings.packagePath), true,
            "should resolve Arduino CLI data directory correctly");

            assert.equal(util.directoryExistsSync(arduinoSettings.sketchbookPath), true,
            "should resolve Arduino CLI user directory correctly");
        } else {
            assert.equal(util.directoryExistsSync(arduinoSettings.defaultPackagePath), true,
            "should resolve arduino IDE built-in package directory correctly");

            assert.equal(util.directoryExistsSync(arduinoSettings.defaultLibPath), true,
            "should resolve arduino IDE built-in library directory correctly");

            assert.equal(util.directoryExistsSync(arduinoSettings.defaultExamplePath), true,
            "should resolve arduino IDE built-in example directory correctly");
        }

        done();
    });

    // tslint:disable-next-line: only-arrow-functions
    test("should initialize package_index and legacy IDE preferences", function(done) {
        const arduinoSettings = ArduinoContext.arduinoApp.settings;

        if (!arduinoSettings.useArduinoCli) {
            assert.equal(util.fileExistsSync(arduinoSettings.preferencePath), true,
            "should be able to init preferences.txt file if not found");

            const configuredSketchbookPath = arduinoSettings.preferences.get("sketchbook.path");
            const portablePath = Path.join(arduinoSettings.arduinoPath, "portable");
            const expectedSketchbookPath = util.directoryExistsSync(portablePath)
                ? Path.join(portablePath, configuredSketchbookPath)
                : configuredSketchbookPath;
            assert.equal(Path.resolve(expectedSketchbookPath), Path.resolve(arduinoSettings.sketchbookPath));
        }

        assert.equal(util.fileExistsSync(Path.join(arduinoSettings.packagePath, "package_index.json")), true,
        "should be able to download package_index.json file if not found");

        done();
    });

    // tslint:disable-next-line: only-arrow-functions
    test("should be able to download necessary library_index", function(done) {
        this.timeout(60 * 1000);

        const arduinoApp = ArduinoContext.arduinoApp;
        const arduinoSettings = ArduinoContext.arduinoApp.settings;
        try {
            arduinoApp.initializeLibrary(false).then(() => {
                assert.equal(util.fileExistsSync(Path.join(arduinoSettings.packagePath, "library_index.json")), true,
                "should be able to download library_index.json file if not found");

                done();
            }).catch((error) => {
                done(`Failed to init library_index.json file: ${error}`);
            });
        } catch (error) {
            done(`Failed to init library_index.json file: ${error}`);
        }
    });
});
