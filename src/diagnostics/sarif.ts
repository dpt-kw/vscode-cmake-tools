/**
 * Ingestion of the SARIF diagnostic log written by a CMake configure/generate run
 *
 * CMake 4.0 and newer can record every diagnostic it issues during a
 * configure/generate run into a SARIF log. The log carries the same warnings
 * and errors that `CMakeOutputConsumer` scrapes out of the console, but as
 * structured data: file, line, severity, rule id and the full call stack, with
 * no regular expressions standing between CMake and the Problems view.
 *
 * SARIF is not a replacement for consuming CMake's stdout/stderr. It only
 * covers the configure/generate run, and it deliberately omits everything that
 * is not a diagnostic (`message(STATUS ...)`, progress, generator chatter), so
 * the Output panel keeps being fed from the console exactly as before. The log
 * is used for one thing: filling the Problems view.
 */ /** */

import * as path from 'path';
import * as vscode from 'vscode';
import type * as Sarif from 'sarif';

import * as logging from '@cmt/logging';
import { fs } from '@cmt/pr';
import * as util from '@cmt/util';
import { FileDiagnostic, diagnosticSeverity, oneLess } from '@cmt/diagnostics/util';

const log = logging.createLogger('sarif');

/**
 * The CMake command line option that asks for a SARIF log
 */
const sarifOutputArg = '--sarif-output';

/**
 * The path CMake itself writes its log to when a project sets
 * `CMAKE_EXPORT_SARIF`. Asking for that same path rather than inventing one of
 * our own means a project which enables the variable still gets precisely the
 * file it expects, even though we always pass `--sarif-output` (which takes
 * precedence over the variable).
 * @param binaryDir The build directory of the run
 */
export function defaultSarifLogPath(binaryDir: string): string {
    return util.lightNormalizePath(path.join(binaryDir, '.cmake', 'sarif', 'cmake.sarif'));
}

/**
 * The SARIF log path a CMake command line already asks for, if any. CMake
 * accepts both `--sarif-output=<path>` and `--sarif-output <path>`, and honors
 * only the last one given, so a log requested through `cmake.configureArgs` or
 * a preset has to be found rather than competed with.
 * @param args The arguments CMake will be invoked with
 */
export function requestedSarifLogPath(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith(`${sarifOutputArg}=`)) {
            return args[i].substring(sarifOutputArg.length + 1);
        }
        if (args[i] === sarifOutputArg && i + 1 < args.length) {
            return args[i + 1];
        }
    }
    return undefined;
}

/**
 * Arrange for a CMake run to write a SARIF log, and return the path to read it
 * back from afterwards.
 *
 * Any log left behind by a previous run is removed first. That is what makes
 * the log trustworthy as a whole-run replacement for the console diagnostics:
 * a run which produces no log at all (an unexpectedly old CMake, a crash before
 * the log is flushed) leaves nothing to read and quietly falls back to the
 * parsed output, while a run which produces an empty log genuinely had nothing
 * to report.
 *
 * @param args The arguments CMake will be invoked with. `--sarif-output` is
 * appended unless the project already asked for a log of its own.
 * @param binaryDir The build directory of the run
 * @param cwd The working directory CMake will be launched in, used to resolve a
 * relative path the project requested
 * @returns The path the log will be written to, or `undefined` if it could not
 * be prepared
 */
export async function beginSarifLog(args: string[], binaryDir: string, cwd: string): Promise<string | undefined> {
    const requested = requestedSarifLogPath(args);
    const logPath = requested ? util.resolvePath(requested, cwd) : defaultSarifLogPath(binaryDir);
    try {
        await fs.mkdir_p(path.dirname(logPath));
        if (await fs.exists(logPath)) {
            await fs.unlink(logPath);
        }
    } catch (e: any) {
        // Not being able to write a log is not a reason to fail the configure;
        // the console output is still parsed as it always was.
        log.debug(`Unable to prepare the CMake SARIF log at ${logPath}: ${e.message}`);
        return undefined;
    }
    if (!requested) {
        args.push(`${sarifOutputArg}=${logPath}`);
    }
    return logPath;
}

/**
 * Read the diagnostics recorded in a SARIF log written by CMake.
 * @param logPath Path to the log, as returned by `beginSarifLog`
 * @returns The diagnostics in the log, or `undefined` if there is no readable
 * log to take them from
 */
export async function readSarifDiagnostics(logPath: string): Promise<FileDiagnostic[] | undefined> {
    if (!await fs.exists(logPath)) {
        log.debug(`CMake wrote no SARIF log at ${logPath}; using the diagnostics parsed from its output`);
        return undefined;
    }
    let sarifLog: Sarif.Log;
    try {
        sarifLog = JSON.parse(await fs.readFile(logPath)) as Sarif.Log;
    } catch (e: any) {
        log.warning(`Unable to read the CMake SARIF log at ${logPath}: ${e.message}`);
        return undefined;
    }
    return sarifLogDiagnostics(sarifLog);
}

/**
 * Convert a parsed SARIF log into diagnostics.
 * @param sarifLog The log to convert
 */
export function sarifLogDiagnostics(sarifLog: Sarif.Log): FileDiagnostic[] {
    const diagnostics: FileDiagnostic[] = [];
    for (const run of sarifLog.runs ?? []) {
        const bases = baseDirectories(run);
        for (const result of run.results ?? []) {
            const diagnostic = diagnosticFromResult(result, bases);
            if (diagnostic) {
                diagnostics.push(diagnostic);
            }
        }
    }
    return diagnostics;
}

/**
 * A file and range that a SARIF location refers to
 */
interface ResolvedLocation {
    filepath: string;
    range: vscode.Range;
}

/**
 * The directories that the `uriBaseId` of a location can be relative to. SARIF
 * asks tools to report relocatable paths, so CMake reports files under the
 * source or build directory relative to those.
 * @param run The SARIF run to take the base directories from
 */
function baseDirectories(run: Sarif.Run): Map<string, string> {
    const bases = new Map<string, string>();
    for (const [id, location] of Object.entries(run.originalUriBaseIds ?? {})) {
        if (location.uri) {
            bases.set(id, fileUriToPath(location.uri));
        }
    }
    return bases;
}

/**
 * Turn a `file://` URI written by CMake back into a path.
 *
 * CMake builds these by pasting the directory onto `file://`, which is not a
 * well-formed URI on Windows (`file://C:/src/`) and would lose the drive if
 * handed to `vscode.Uri.parse`, so peel the scheme off by hand and leave the
 * rest of the path exactly as CMake wrote it.
 * @param uri The URI to convert
 */
function fileUriToPath(uri: string): string {
    return uri.replace(/^file:\/\//, '');
}

/**
 * Resolve the file and range a SARIF location points at.
 * @param location The location to resolve
 * @param bases The base directories of the run, by `uriBaseId`
 * @returns The resolved location, or `undefined` if it does not name a file we
 * can place on disk
 */
function resolveLocation(location: Sarif.Location | undefined, bases: Map<string, string>): ResolvedLocation | undefined {
    const physical = location?.physicalLocation;
    const artifact = physical?.artifactLocation;
    if (!physical || !artifact || !artifact.uri) {
        return undefined;
    }
    const base = artifact.uriBaseId ? bases.get(artifact.uriBaseId) : undefined;
    if (!base && !path.isAbsolute(artifact.uri)) {
        // Relative to a base the run never described. Nothing to anchor it to.
        return undefined;
    }
    const region = physical.region;
    // A location without a region refers to the file as a whole. CMake writes
    // those for placeholder frames, such as the site of a deferred call.
    const line = oneLess(region?.startLine ?? 1);
    const column = region?.startColumn !== undefined ? oneLess(region.startColumn) : 0;
    return {
        filepath: util.resolvePath(artifact.uri, base ?? ''),
        range: new vscode.Range(line, column, line, 9999)
    };
}

/**
 * The severity a SARIF level corresponds to.
 * @param level The level of the result, if it stated one
 */
function severityFromLevel(level?: Sarif.Result.level): vscode.DiagnosticSeverity {
    if (level === undefined) {
        // SARIF says a result with no explicit level takes it from the rule's
        // configuration, which defaults to `warning`.
        return vscode.DiagnosticSeverity.Warning;
    }
    // SARIF's levels are spelled the same way as the severities the compiler
    // output parsers already understand. `none` is not one of them: it marks a
    // result which is not a problem in its own right.
    return diagnosticSeverity(level) ?? vscode.DiagnosticSeverity.Hint;
}

/**
 * Convert a single SARIF result into a diagnostic.
 * @param result The result to convert
 * @param bases The base directories of the run, by `uriBaseId`
 * @returns The diagnostic, or `undefined` if the result cannot be placed in a file
 */
function diagnosticFromResult(result: Sarif.Result, bases: Map<string, string>): FileDiagnostic | undefined {
    const location = resolveLocation(result.locations?.[0], bases);
    if (!location) {
        return undefined;
    }
    const diag = new vscode.Diagnostic(location.range, result.message.text ?? '', severityFromLevel(result.level));
    diag.source = 'cmake';
    diag.code = result.ruleId;
    diag.relatedInformation = callStackRelatedInformation(result, bases);
    return { filepath: location.filepath, diag };
}

/**
 * The call stack of a result, as related information hanging off the diagnostic.
 * @param result The result to take the call stack from
 * @param bases The base directories of the run, by `uriBaseId`
 */
function callStackRelatedInformation(result: Sarif.Result, bases: Map<string, string>): vscode.DiagnosticRelatedInformation[] {
    const related: vscode.DiagnosticRelatedInformation[] = [];
    // The innermost frame is the diagnostic's own location. The frames above it
    // are what CMake prints under "Call Stack (most recent call first):".
    for (const frame of result.stacks?.[0]?.frames.slice(1) ?? []) {
        const location = resolveLocation(frame.location, bases);
        if (!location) {
            continue;
        }
        const command = frame.location?.logicalLocations?.[0]?.name;
        const message = frame.location?.message?.text ?? (command ? `In call to '${command}' here` : 'In call here');
        related.push(new vscode.DiagnosticRelatedInformation(
            new vscode.Location(vscode.Uri.file(location.filepath), location.range),
            message
        ));
    }
    return related;
}
