// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

import * as constants from "../common/constants";

/**
 * Status bar item that reports IntelliSense analysis runs: a spinner while
 * an analysis runs and a warning after a failed one, until the next
 * analysis starts. Clicking it shows the Arduino output. With
 * arduino.analyzingSketchFocusOutput off, analyses don't reveal the output,
 * so this is where a failure becomes visible.
 */
export class AnalysisStatusBar {
    private _item: vscode.StatusBarItem;
    private _running = false;

    constructor() {
        this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, constants.statusBarPriority.ANALYSIS);
        this._item.command = "arduino.showOutput";
    }

    /**
     * An analysis has started writing to the output.
     */
    public start(sketch: string) {
        this._running = true;
        this._item.text = "$(sync~spin) Analyzing";
        this._item.tooltip = `Analyzing sketch '${sketch}' for IntelliSense. Click to show the output.`;
        this._item.show();
    }

    /**
     * The build has ended. Does nothing unless start() was called, so
     * analyses that end before producing any output (no board selected,
     * no sketch) leave the status bar alone.
     */
    public finish(succeeded: boolean) {
        if (!this._running) {
            return;
        }
        this._running = false;
        if (succeeded) {
            this._item.hide();
        } else {
            this._item.text = "$(warning) Analysis failed";
            this._item.tooltip = "The IntelliSense analysis of the sketch failed. Click to show the output.";
        }
    }

    /**
     * Hides the item, e.g. a failure that a newer analysis supersedes.
     */
    public hide() {
        this._running = false;
        this._item.hide();
    }
}
